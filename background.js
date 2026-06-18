"use strict";

/* global TararaDefaults, TararaMatching */

const MAX_BODY_BYTES = 10 * 1024 * 1024; // captured response bodies are truncated beyond this
const MAX_QUEUE_LENGTH = 500; // oldest pending reports are dropped beyond this
const POST_RETRIES = 2;
const REQUEST_META_TTL_MS = 5 * 60 * 1000;

const state = {
  running: false,
  settings: null,
  startedAt: null,
  trackedTabs: new Map(), // tabId -> watch row
  refreshTimers: new Map(), // tabId -> interval id
  requestMeta: new Map(), // requestId -> { contentType, statusCode, skip, seenAt }
  registeredScripts: [], // dynamically registered WebSocket-hook content scripts
  sweepTimer: null,
  queue: [],
  sending: false,
  stats: { matched: 0, sent: 0, failed: 0 },
  lastError: null,
};

browser.runtime.onInstalled.addListener(async () => {
  const stored = await browser.storage.local.get("settings");
  if (!stored.settings) {
    await browser.storage.local.set({ settings: TararaDefaults.defaultSettings() });
  }
});

async function loadSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...TararaDefaults.defaultSettings(), ...(settings || {}) };
}

async function startMonitoring() {
  if (state.running) return;

  const settings = await loadSettings();
  const endpoint = (settings.apiEndpoint || "").trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("API endpoint is not configured. Set it on the settings page first.");
  }
  const rows = (settings.rows || []).filter((row) => row.enabled && (row.url || "").trim());
  if (rows.length === 0) {
    throw new Error("No enabled watch entries. Add at least one on the settings page.");
  }

  state.settings = { ...settings, apiEndpoint: endpoint };
  state.running = true;
  state.startedAt = Date.now();
  state.stats = { matched: 0, sent: 0, failed: 0 };
  state.lastError = null;

  try {
    await registerWebSocketHooks(rows);

    for (const row of rows) {
      const tab = await browser.tabs.create({ url: row.url.trim() });
      state.trackedTabs.set(tab.id, row);
      const seconds = Math.floor(Number(row.refreshSeconds)) || 0;
      if (seconds > 0) {
        const timer = setInterval(() => {
          browser.tabs.reload(tab.id, { bypassCache: true }).catch(() => {});
        }, seconds * 1000);
        state.refreshTimers.set(tab.id, timer);
      }
    }
  } catch (error) {
    await stopMonitoring();
    throw new Error(`Could not open watch tabs: ${error.message}`);
  }

  state.sweepTimer = setInterval(sweepRequestMeta, 60 * 1000);
  updateBadge();
}

// WebSocket frames are invisible to webRequest, so they are captured in-page by
// content/ws-hook.js. Register that hook (at document_start, before the tabs
// open) only for the origins of rows that opted into WebSocket capture, so the
// page's WebSocket is never touched on sites the user is not watching.
async function registerWebSocketHooks(rows) {
  if (!browser.contentScripts || !browser.contentScripts.register) return;

  const origins = new Set();
  for (const row of rows) {
    if (!TararaMatching.webSocketEnabled(row.contentTypes)) continue;
    const pattern = originMatchPattern(row.url);
    if (pattern) origins.add(pattern);
  }
  if (origins.size === 0) return;

  try {
    const handle = await browser.contentScripts.register({
      matches: [...origins],
      js: [{ file: "content/ws-hook.js" }],
      runAt: "document_start",
      allFrames: true,
    });
    state.registeredScripts.push(handle);
  } catch (error) {
    // Non-fatal: HTTP capture still works without the WebSocket hook.
    console.error("Tarara: failed to register WebSocket hook", error);
  }
}

function unregisterWebSocketHooks() {
  for (const handle of state.registeredScripts) {
    try {
      handle.unregister();
    } catch (_e) {
      /* already gone */
    }
  }
  state.registeredScripts = [];
}

/** Build a match pattern that covers a row URL's whole origin, e.g. `https://example.com/*`. */
function originMatchPattern(rawUrl) {
  try {
    const url = new URL(String(rawUrl || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}

async function stopMonitoring() {
  state.running = false;
  state.startedAt = null;
  unregisterWebSocketHooks();
  for (const timer of state.refreshTimers.values()) clearInterval(timer);
  state.refreshTimers.clear();
  if (state.sweepTimer) {
    clearInterval(state.sweepTimer);
    state.sweepTimer = null;
  }
  const tabIds = [...state.trackedTabs.keys()];
  state.trackedTabs.clear();
  state.requestMeta.clear();
  if (tabIds.length > 0) {
    await browser.tabs.remove(tabIds).catch(() => {});
  }
  updateBadge();
}

// Watched rows that opted into "scroll to end" get the auto-scroll content
// script injected on every load (initial open and each refresh). Injection is
// targeted at the specific tracked tab via executeScript, so only Tarara's own
// tabs are ever scrolled — never other tabs the user has open on the same site.
// The script drives its own scroll loop in the page (see content/auto-scroll.js).
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.running || changeInfo.status !== "complete") return;
  const row = state.trackedTabs.get(tabId);
  if (!row || row.scrollToEnd !== true) return;
  browser.tabs
    .executeScript(tabId, { file: "content/auto-scroll.js", runAt: "document_idle" })
    .catch(() => {});
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (!state.trackedTabs.has(tabId)) return;
  state.trackedTabs.delete(tabId);
  const timer = state.refreshTimers.get(tabId);
  if (timer) {
    clearInterval(timer);
    state.refreshTimers.delete(tabId);
  }
  if (state.running && state.trackedTabs.size === 0) {
    stopMonitoring();
  }
});

// Content-Type is only known once headers arrive; remember it per request so
// the stream filter can decide whether the body is worth keeping in memory.
browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!state.running) return;
    const row = state.trackedTabs.get(details.tabId);
    if (!row || !TararaMatching.urlMatches(details.url, row.patterns)) return;
    const header = (details.responseHeaders || []).find(
      (item) => item.name.toLowerCase() === "content-type"
    );
    const contentType = header ? header.value : "";
    const existing = state.requestMeta.get(details.requestId) || {};
    state.requestMeta.set(details.requestId, {
      ...existing,
      contentType,
      statusCode: details.statusCode,
      skip: !TararaMatching.contentTypeMatches(contentType, row.contentTypes),
      seenAt: Date.now(),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!state.running) return {};
    const row = state.trackedTabs.get(details.tabId);
    if (!row || !TararaMatching.urlMatches(details.url, row.patterns)) return {};

    // The request body is only exposed here (onBeforeRequest). Capture it now and
    // stash it on the request meta; it is attached to the report later only if the
    // response also passes the content-type filter (see finalizeCapture).
    const existing = state.requestMeta.get(details.requestId) || {};
    state.requestMeta.set(details.requestId, {
      ...existing,
      ...decodeRequestBody(details.requestBody),
      seenAt: Date.now(),
    });

    const filter = browser.webRequest.filterResponseData(details.requestId);
    const chunks = [];
    let capturedBytes = 0;
    let totalBytes = 0;

    filter.ondata = (event) => {
      // Always pass the data through so the page keeps working normally.
      filter.write(event.data);
      totalBytes += event.data.byteLength;
      const meta = state.requestMeta.get(details.requestId);
      if (meta && meta.skip) return;
      if (capturedBytes < MAX_BODY_BYTES) {
        // Cap precisely at MAX_BODY_BYTES so the kept body never exceeds the
        // documented limit and bodyTruncated stays exact.
        const remaining = MAX_BODY_BYTES - capturedBytes;
        const chunk =
          event.data.byteLength > remaining
            ? new Uint8Array(event.data, 0, remaining)
            : new Uint8Array(event.data);
        chunks.push(chunk);
        capturedBytes += chunk.byteLength;
      }
    };
    filter.onstop = () => {
      filter.close();
      finalizeCapture(details, row, chunks, totalBytes, capturedBytes);
    };
    filter.onerror = () => {
      state.requestMeta.delete(details.requestId);
    };
    return {};
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);

function finalizeCapture(details, row, chunks, totalBytes, capturedBytes) {
  const meta = state.requestMeta.get(details.requestId) || {};
  state.requestMeta.delete(details.requestId);
  const contentType = meta.contentType || "";
  const skip =
    meta.skip !== undefined
      ? meta.skip
      : !TararaMatching.contentTypeMatches(contentType, row.contentTypes);
  if (!state.running || skip) return;

  const { body, bodyEncoding } = decodeBody(chunks, contentType);
  enqueue({
    timestamp: new Date().toISOString(),
    computerName: state.settings.computerName,
    pageUrl:
      details.type === "main_frame" ? details.url : details.documentUrl || row.url,
    requestUrl: details.url,
    method: details.method,
    resourceType: details.type,
    statusCode: meta.statusCode ?? null,
    contentType,
    requestBody: meta.requestBody || "",
    requestBodyEncoding: meta.requestBodyEncoding || null,
    requestBodyTruncated: Boolean(meta.requestBodyTruncated),
    bodyEncoding,
    bodyTruncated: totalBytes > capturedBytes,
    byteLength: totalBytes,
    body,
  });
}

function decodeBody(chunks, contentTypeHeader) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  if (TararaMatching.isTextual(contentTypeHeader)) {
    return { body: decodeText(bytes, TararaMatching.charsetOf(contentTypeHeader)), bodyEncoding: "text" };
  }
  return { body: toBase64(bytes), bodyEncoding: "base64" };
}

// Decode the outgoing request payload exposed by webRequest in onBeforeRequest.
// formData (urlencoded / multipart) is serialized to JSON; a raw byte body is
// decoded as UTF-8 text when valid, otherwise base64. File parts (no `bytes`)
// are skipped. Capped at MAX_BODY_BYTES like the response body.
function decodeRequestBody(requestBody) {
  if (!requestBody) {
    return { requestBody: "", requestBodyEncoding: null, requestBodyTruncated: false };
  }
  if (requestBody.formData) {
    const text = JSON.stringify(requestBody.formData);
    const truncated = text.length > MAX_BODY_BYTES;
    return {
      requestBody: truncated ? text.slice(0, MAX_BODY_BYTES) : text,
      requestBodyEncoding: "text",
      requestBodyTruncated: truncated,
    };
  }
  if (Array.isArray(requestBody.raw) && requestBody.raw.length > 0) {
    const parts = requestBody.raw
      .filter((part) => part && part.bytes)
      .map((part) => new Uint8Array(part.bytes));
    const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const capped = Math.min(totalLength, MAX_BODY_BYTES);
    const bytes = new Uint8Array(capped);
    let offset = 0;
    for (const part of parts) {
      if (offset >= capped) break;
      const slice = part.subarray(0, capped - offset);
      bytes.set(slice, offset);
      offset += slice.byteLength;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { requestBody: text, requestBodyEncoding: "text", requestBodyTruncated: totalLength > capped };
    } catch {
      return {
        requestBody: toBase64(bytes),
        requestBodyEncoding: "base64",
        requestBodyTruncated: totalLength > capped,
      };
    }
  }
  return { requestBody: "", requestBodyEncoding: null, requestBodyTruncated: false };
}

function decodeText(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function toBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function enqueue(payload) {
  state.stats.matched++;
  if (state.queue.length >= MAX_QUEUE_LENGTH) {
    state.queue.shift();
    state.stats.failed++;
  }
  state.queue.push(payload);
  updateBadge();
  drainQueue();
}

async function drainQueue() {
  if (state.sending) return;
  state.sending = true;
  try {
    while (state.queue.length > 0) {
      const payload = state.queue.shift();
      try {
        await postWithRetry(payload);
        state.stats.sent++;
        state.lastError = null;
      } catch (error) {
        state.stats.failed++;
        state.lastError = `Delivery failed: ${error.message}`;
        console.error("Tarara: failed to deliver report", error);
      }
      updateBadge();
    }
  } finally {
    state.sending = false;
  }
}

async function postWithRetry(payload) {
  let lastError;
  for (let attempt = 0; attempt <= POST_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
    try {
      const response = await fetch(state.settings.apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function sweepRequestMeta() {
  const cutoff = Date.now() - REQUEST_META_TTL_MS;
  for (const [requestId, meta] of state.requestMeta) {
    if (meta.seenAt < cutoff) state.requestMeta.delete(requestId);
  }
}

function updateBadge() {
  if (!state.running) {
    browser.browserAction.setBadgeText({ text: "" });
    return;
  }
  browser.browserAction.setBadgeBackgroundColor({
    color: state.stats.failed > 0 ? "#b91c1c" : "#2e7d32",
  });
  const sent = state.stats.sent;
  browser.browserAction.setBadgeText({ text: sent > 999 ? "999+" : String(sent) });
}

// A WebSocket frame relayed from content/ws-hook.js. Gated the same way as the
// HTTP path (tracked tab + per-row URL patterns + WebSocket opt-in), then fed
// into the existing send queue using the standard payload contract.
function handleWsFrame(frame, sender) {
  if (!state.running || !frame || !sender || !sender.tab) return;
  const row = state.trackedTabs.get(sender.tab.id);
  if (!row || !TararaMatching.webSocketEnabled(row.contentTypes)) return;
  if (!TararaMatching.socketUrlMatches(frame.socketUrl, row.patterns)) return;

  let timestamp;
  try {
    timestamp = new Date(frame.ts).toISOString();
  } catch {
    timestamp = new Date().toISOString();
  }

  enqueue({
    timestamp,
    computerName: state.settings.computerName,
    pageUrl: sender.tab.url || row.url,
    requestUrl: frame.socketUrl,
    method: "WS_RECV",
    resourceType: "websocket",
    statusCode: null,
    contentType: frame.bodyEncoding === "text" ? "text/plain" : "application/octet-stream",
    requestBody: "",
    requestBodyEncoding: null,
    requestBodyTruncated: false,
    bodyEncoding: frame.bodyEncoding,
    // An undecodable binary frame carries no body but is not empty: flag it as
    // truncated so the endpoint can tell it apart from a genuinely empty frame
    // (its size still shows in byteLength below).
    bodyTruncated: Boolean(frame.bodyTruncated || frame.binaryUndecoded),
    byteLength: typeof frame.byteLength === "number" ? frame.byteLength : null,
    body: frame.body || "",
  });
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message && message.type) {
    case "start":
      return startMonitoring()
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, error: error.message }));
    case "stop":
      return stopMonitoring().then(() => ({ ok: true }));
    case "wsFrame":
      handleWsFrame(message.frame, sender);
      return undefined;
    case "getStatus":
      return Promise.resolve({
        running: state.running,
        startedAt: state.startedAt,
        trackedTabs: state.trackedTabs.size,
        queued: state.queue.length,
        stats: state.stats,
        lastError: state.lastError,
      });
    default:
      return undefined;
  }
});
