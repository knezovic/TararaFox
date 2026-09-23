"use strict";

/*
 * Tarara WebSocket capture hook.
 *
 * The background page captures HTTP bodies with webRequest.filterResponseData,
 * but that API only sees the WebSocket HTTP Upgrade handshake — never the
 * frames that flow over an established wss:// connection. To read those frames
 * we have to hook the page's own WebSocket object.
 *
 * This hook captures INCOMING messages only. It attaches a "message" listener
 * to every socket and never overrides send(), so the page's outgoing traffic
 * is left completely untouched — outbound wrapping from the content principal
 * can break a live feed across the Xray membrane, which is not worth the risk.
 *
 * Firefox technique (CSP-immune, no injected <script>): from this content
 * script we reach the page realm through window.wrappedJSObject and replace
 * WebSocket with an exportFunction-wrapped constructor. Because nothing is
 * inserted as a <script> node and no inline eval runs, the page's CSP never
 * applies; and because the script runs at document_start it lands before the
 * page's own bundles capture the WebSocket reference.
 *
 * The exported callbacks run with this content script's privileges, so they
 * relay captured frames straight to the background page via
 * runtime.sendMessage. All per-row pattern/type gating and the send queue live
 * in the background (single source of truth).
 *
 * Tab scoping: contentScripts.register cannot target tabs, so this hook also
 * lands in the user's own tabs on a watched origin. It therefore starts
 * "pending" and asks the background whether its tab is a Tarara tab. Frames
 * seen while pending stay in this tab. On "yes" they are flushed and capture
 * continues; on "no" (or no answer within HELLO_TIMEOUT_MS) they are
 * discarded, the message listeners are removed and the native WebSocket is
 * restored, so nothing from an unwatched tab is ever relayed.
 *
 * Cardinal rule: a capture failure must never break the host page's traffic.
 * Every step is wrapped in try/catch; on any error we leave the native
 * WebSocket untouched and the page keeps working normally.
 *
 * Known blind spots:
 *  - WebSockets opened inside Web Workers live in a separate realm with their
 *    own WebSocket prototype and are invisible to a main-document hook.
 *  - Binary frames are captured best-effort (see capture() below).
 */

(function installTararaWebSocketHook() {
  let pageWin;
  try {
    pageWin = window.wrappedJSObject;
  } catch (_e) {
    return; // no Xray membrane (e.g. non-Firefox) — nothing we can safely do
  }
  if (!pageWin || pageWin.__tararaWSHooked) return;

  const RealWS = pageWin.WebSocket;
  if (typeof RealWS !== "function") return;
  if (typeof exportFunction !== "function") return;

  const MAX_FRAME_BYTES = 10 * 1024 * 1024; // mirror MAX_BODY_BYTES in background.js
  const HELLO_TIMEOUT_MS = 5000; // no answer from the background = not a Tarara tab
  const MAX_PENDING_FRAMES = 100; // frames kept while waiting for the answer

  let mode = "pending"; // "pending" -> "on" (Tarara tab) or "off" (uninstalled)
  let wrapper = null;
  const pendingFrames = [];
  const hookedWhilePending = []; // { target, listener }, removed on "off"

  function send(frame) {
    try {
      browser.runtime.sendMessage({ type: "wsFrame", frame }).catch(() => {});
    } catch (_e) {
      /* background may be unavailable; never throw into the page */
    }
  }

  function relay(frame) {
    if (mode === "on") {
      send(frame);
    } else if (mode === "pending") {
      if (pendingFrames.length >= MAX_PENDING_FRAMES) pendingFrames.shift();
      pendingFrames.push(frame);
    }
  }

  // Resolve the pending state once, from the background's answer or timeout.
  function settle(capture) {
    if (mode !== "pending") return;
    if (capture) {
      mode = "on";
      hookedWhilePending.length = 0;
      for (const frame of pendingFrames.splice(0)) send(frame);
      return;
    }
    mode = "off";
    pendingFrames.length = 0;
    for (const { target, listener } of hookedWhilePending.splice(0)) {
      try {
        target.removeEventListener("message", listener, false);
      } catch (_e) {
        /* socket already gone */
      }
    }
    try {
      // Only restore if nobody replaced our wrapper in the meantime; if the
      // page wrapped it again, the wrapper stays but is inert (mode is "off").
      // Compare unwrapped: the page-side and content-side views of the same
      // function are different Xray wrappers.
      if (XPCNativeWrapper.unwrap(pageWin.WebSocket) === XPCNativeWrapper.unwrap(wrapper)) {
        pageWin.WebSocket = RealWS;
      }
      delete pageWin.__tararaWSHooked;
    } catch (_e) {
      /* the inert wrapper is harmless */
    }
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const CHUNK = 0x8000; // chunk to avoid String.fromCharCode stack limits
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function emitText(url, text) {
    // byteLength is the full UTF-8 size before any truncation to the cap.
    const byteLength = new TextEncoder().encode(text).length;
    const truncated = byteLength > MAX_FRAME_BYTES;
    relay({
      socketUrl: url,
      ts: Date.now(),
      bodyEncoding: "text",
      bodyTruncated: truncated,
      byteLength,
      body: truncated ? text.slice(0, MAX_FRAME_BYTES) : text,
    });
  }

  function emitBytes(url, bytes, totalBytes) {
    const capped =
      bytes.length > MAX_FRAME_BYTES ? bytes.subarray(0, MAX_FRAME_BYTES) : bytes;
    relay({
      socketUrl: url,
      ts: Date.now(),
      bodyEncoding: "base64",
      bodyTruncated: totalBytes > capped.length,
      byteLength: totalBytes,
      body: bytesToBase64(capped),
    });
  }

  function emitBase64(url, base64, totalBytes) {
    relay({
      socketUrl: url,
      ts: Date.now(),
      bodyEncoding: "base64",
      bodyTruncated: (totalBytes || 0) > MAX_FRAME_BYTES,
      byteLength: totalBytes || 0,
      body: base64,
    });
  }

  // Records that a binary frame was seen but could not be decoded across the
  // Xray boundary, so the report still reflects its existence and size.
  function emitUndecoded(url, totalBytes) {
    relay({
      socketUrl: url,
      ts: Date.now(),
      bodyEncoding: "base64",
      bodyTruncated: false,
      binaryUndecoded: true,
      byteLength: totalBytes || 0,
      body: "",
    });
  }

  function capture(url, data) {
    if (mode === "off") return;
    try {
      if (typeof data === "string") {
        emitText(url, data);
        return;
      }

      const raw = data && data.wrappedJSObject ? data.wrappedJSObject : data;
      if (!raw || typeof raw !== "object") return;

      // Blob (the default binaryType) — bytes are async. Convert in the PAGE
      // realm via the page's own FileReader so only a primitive string crosses
      // back, sidestepping all Xray byte-reading hazards.
      if (typeof raw.size === "number" && typeof raw.arrayBuffer === "function") {
        const total = raw.size;
        try {
          const slice = raw.size > MAX_FRAME_BYTES && typeof raw.slice === "function"
            ? raw.slice(0, MAX_FRAME_BYTES)
            : raw;
          const reader = new pageWin.FileReader();
          reader.onload = exportFunction(function () {
            try {
              const result = String(reader.result || "");
              const comma = result.indexOf(",");
              emitBase64(url, comma >= 0 ? result.slice(comma + 1) : "", total);
            } catch (_e) {
              /* swallow */
            }
          }, window);
          reader.onerror = exportFunction(function () {
            emitUndecoded(url, total);
          }, window);
          reader.readAsDataURL(slice);
        } catch (_e) {
          emitUndecoded(url, total);
        }
        return;
      }

      // ArrayBuffer / TypedArray / DataView — best-effort synchronous read.
      try {
        let bytes = null;
        let total = 0;
        if (typeof raw.byteLength === "number" && raw.buffer) {
          // typed array or DataView view onto a buffer
          bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
          total = raw.byteLength;
        } else if (typeof raw.byteLength === "number") {
          // ArrayBuffer
          bytes = new Uint8Array(raw);
          total = raw.byteLength;
        }
        if (bytes) {
          emitBytes(url, bytes.slice(0), total); // copy out of page memory
          return;
        }
      } catch (_e) {
        /* fall through to undecoded */
      }

      emitUndecoded(url, (raw && (raw.byteLength || raw.size)) || 0);
    } catch (_e) {
      /* never throw into the page */
    }
  }

  function hookInstance(sock, url) {
    const target = sock && sock.wrappedJSObject ? sock.wrappedJSObject : sock;
    if (!target) return;

    // INBOUND ONLY. We deliberately do NOT override send(): wrapping the page's
    // send from the content principal risks breaking its outgoing frames across
    // the Xray membrane, which can kill a live feed (e.g. Socket.IO ping/pong)
    // and stop messages from arriving at all. Adding a "message" listener is
    // purely additive — it fires alongside the page's own onmessage/
    // addEventListener handlers and cannot break the page.
    try {
      const listener = exportFunction(function (ev) {
        try {
          capture(url, ev.data);
        } catch (_e) {
          /* swallow */
        }
      }, window);
      target.addEventListener("message", listener, false);
      if (mode === "pending") hookedWhilePending.push({ target, listener });
    } catch (_e) {
      /* inbound capture unavailable */
    }
  }

  function TararaWebSocket(url, protocols) {
    // protocols may be a page-side array/string; unwrap objects before handing
    // them back to the page constructor.
    const proto =
      protocols && typeof protocols === "object" && protocols.wrappedJSObject
        ? protocols.wrappedJSObject
        : protocols;
    const sock = proto === undefined ? new RealWS(url) : new RealWS(url, proto);
    if (mode === "off") return sock; // uninstalled, but the page kept a reference
    try {
      hookInstance(sock, String(url));
    } catch (_e) {
      /* page still gets a fully working socket */
    }
    return sock; // page-owned object, returned to the page as-is
  }

  try {
    wrapper = exportFunction(TararaWebSocket, window);
    pageWin.WebSocket = wrapper;
    // Keep instanceof and the WebSocket.* state constants working.
    try {
      pageWin.WebSocket.prototype = RealWS.prototype;
    } catch (_e) {
      /* ignore */
    }
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      try {
        pageWin.WebSocket[key] = RealWS[key];
      } catch (_e) {
        /* ignore */
      }
    }
    pageWin.__tararaWSHooked = true;
  } catch (_e) {
    /* leave the native WebSocket intact — the page is never broken */
    return;
  }

  // Ask whether this is a Tarara tab. Anything but an explicit yes, in time,
  // uninstalls the hook.
  setTimeout(() => settle(false), HELLO_TIMEOUT_MS);
  try {
    browser.runtime.sendMessage({ type: "wsHookHello" }).then(
      (reply) => settle(Boolean(reply && reply.capture)),
      () => settle(false)
    );
  } catch (_e) {
    settle(false);
  }
})();
