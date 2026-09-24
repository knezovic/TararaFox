"use strict";

/* global TararaDefaults, TararaMatching */

const MAX_BODY_BYTES = 10 * 1024 * 1024; // captured response bodies are truncated beyond this
const MAX_QUEUE_BYTES = 100 * 1024 * 1024; // oldest pending reports are dropped beyond this (approx.)
const MAX_QUEUE_LENGTH = 100000; // safety cap on the number of pending reports
const POST_TIMEOUT_MS = 30 * 1000; // a delivery attempt is aborted after this
const RETRY_DELAYS_MS = [5000, 10000, 30000, 60000]; // pause before each retry; the last repeats
const REQUEST_META_TTL_MS = 5 * 60 * 1000;

const state = {
  running: false,
  starting: false, // true while startMonitoring is still loading settings / opening tabs
  settings: null,
  startedAt: null,
  trackedTabs: new Map(), // tabId -> watch row
  refreshTimers: new Map(), // tabId -> interval id
  requestMeta: new Map(), // requestId -> { rawRequestBody, contentType, statusCode, skip, seenAt }
  registeredScripts: [], // dynamically registered WebSocket-hook content scripts
  sweepTimer: null,
  queue: [], // pending reports as { body: serialized JSON, size }
  queueBytes: 0,
  sending: false,
  retryIndex: 0, // position in RETRY_DELAYS_MS while the endpoint keeps failing
  retryTimer: null,
  abortController: null, // the in-flight delivery, aborted on stop
  generation: 0, // bumped on stop so a delivery loop from before the stop exits
  stats: { matched: 0, sent: 0, failed: 0, dropped: 0 },
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
  const merged = { ...TararaDefaults.defaultSettings(), ...(settings || {}) };
  // Without a stored name a new random one would be generated on every start;
  // persist the generated name so the machine keeps one identity.
  if (!settings || !settings.computerName) {
    await browser.storage.local.set({ settings: merged });
  }
  return merged;
}

// A second start while one is still in progress (double click, popup reopened)
// returns right away instead of opening a duplicate set of tabs.
async function startMonitoring() {
  if (state.running || state.starting) return;
  state.starting = true;
  try {
    await openWatchTabs();
  } finally {
    state.starting = false;
  }
}

async function openWatchTabs() {
  const settings = await loadSettings();
  const endpoint = (settings.apiEndpoint || "").trim();
  // Captured bodies are forwarded here, so the endpoint must be HTTPS.
  if (!/^https:\/\//i.test(endpoint)) {
    throw new Error("API endpoint is not configured or is not an https URL. Set an https endpoint on the settings page first.");
  }
  const rows = (settings.rows || []).filter((row) => row.enabled && (row.url || "").trim());
  if (rows.length === 0) {
    throw new Error("No enabled watch entries. Add at least one on the settings page.");
  }

  state.settings = { ...settings, apiEndpoint: endpoint };
  state.running = true;
  addRequestListeners();
  state.startedAt = Date.now();
  state.stats = { matched: 0, sent: 0, failed: 0, dropped: 0 };
  state.lastError = null;

  try {
    await registerWebSocketHooks(rows);
    if (!state.running) {
      unregisterWebSocketHooks(); // registered after the stop already ran
      return;
    }

    for (const row of rows) {
      if (!state.running) return; // stopped while tabs were still opening
      // Open blank first and record the tab as tracked, then navigate. The
      // WebSocket hook asks on its first load whether its tab is tracked (see
      // handleWsHookHello); recording before navigating guarantees the answer
      // is already known when that question arrives.
      const tab = await browser.tabs.create({
        url: "about:blank",
        // Open in the foreground when "Active" is set, so the first load is not
        // throttled as a hidden tab.
        active: row.activate === true,
      });
      if (!state.running) {
        await browser.tabs.remove(tab.id).catch(() => {});
        return;
      }
      state.trackedTabs.set(tab.id, row);
      await browser.tabs.update(tab.id, { url: row.url.trim() });
      const requested = Math.floor(Number(row.refreshSeconds)) || 0;
      // Settings saved before the minimum existed may hold smaller values.
      const seconds = requested > 0 ? Math.max(requested, TararaDefaults.MIN_REFRESH_SECONDS) : 0;
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
// page's WebSocket is never touched on sites the user is not watching. A
// registration cannot target specific tabs, so the hook also lands in the
// user's own tabs on those origins; there it asks handleWsHookHello, is told it
// is not tracked, and uninstalls itself without relaying anything.
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

/**
 * Build a match pattern that covers a row URL's whole host, e.g. `https://example.com/*`.
 * Match patterns cannot contain a port (one would make contentScripts.register
 * throw), so the hostname is used; a portless pattern matches every port.
 */
function originMatchPattern(rawUrl) {
  try {
    const url = new URL(String(rawUrl || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

async function stopMonitoring() {
  state.running = false;
  state.startedAt = null;
  removeRequestListeners();
  discardQueue();
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
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!state.running || changeInfo.status !== "complete") return;
  const row = state.trackedTabs.get(tabId);
  if (!row) return;
  // Skip the about:blank placeholder that watched tabs open on before
  // navigating to the row URL (see startMonitoring).
  if (tab && tab.url === "about:blank") return;
  // "Active" rows are brought to the foreground on every load (the initial open
  // and each refresh), because Firefox throttles background tabs and lazy-loaded
  // content often does not arrive in a hidden tab. This steals focus, so it is
  // intended for a dedicated monitoring machine.
  if (row.activate === true) {
    browser.tabs.update(tabId, { active: true }).catch(() => {});
  }
  if (row.scrollToEnd === true) {
    browser.tabs
      .executeScript(tabId, { file: "content/auto-scroll.js", runAt: "document_idle" })
      .catch(() => {});
  }
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
function onHeadersReceived(details) {
  if (!state.running) return;
  const row = state.trackedTabs.get(details.tabId);
  if (!row || !TararaMatching.urlMatches(details.url, row.patterns)) return;
  const header = (details.responseHeaders || []).find(
    (item) => item.name.toLowerCase() === "content-type"
  );
  const contentType = header ? header.value : "";
  const existing = state.requestMeta.get(details.requestId) || {};
  const skip = !TararaMatching.contentTypeMatches(contentType, row.contentTypes);
  state.requestMeta.set(details.requestId, {
    ...existing,
    // A skipped response is never reported, so its request body can go now.
    rawRequestBody: skip ? null : existing.rawRequestBody,
    contentType,
    statusCode: details.statusCode,
    skip,
    seenAt: Date.now(),
  });
}

function onBeforeRequest(details) {
  if (!state.running) return {};
  const row = state.trackedTabs.get(details.tabId);
  if (!row || !TararaMatching.urlMatches(details.url, row.patterns)) return {};

  // The request body is only exposed here (onBeforeRequest). Keep a reference
  // to it (no copy, no decoding yet): onHeadersReceived drops it when the
  // response fails the content-type filter, and finalizeCapture decodes it only
  // for reports that are actually sent.
  const existing = state.requestMeta.get(details.requestId) || {};
  state.requestMeta.set(details.requestId, {
    ...existing,
    rawRequestBody: details.requestBody || null,
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
}

// Both listeners are registered only while monitoring runs, so the blocking
// onBeforeRequest does not sit in front of every request in the browser while
// Tarara is stopped. The state.running checks inside stay as a second guard.
function addRequestListeners() {
  if (browser.webRequest.onBeforeRequest.hasListener(onBeforeRequest)) return;
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
  browser.webRequest.onBeforeRequest.addListener(
    onBeforeRequest,
    { urls: ["<all_urls>"] },
    ["blocking", "requestBody"]
  );
}

// Stream filters already attached keep running to completion on their own.
function removeRequestListeners() {
  browser.webRequest.onHeadersReceived.removeListener(onHeadersReceived);
  browser.webRequest.onBeforeRequest.removeListener(onBeforeRequest);
}

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
  const request = decodeRequestBody(meta.rawRequestBody);
  enqueue({
    timestamp: new Date().toISOString(),
    computerName: state.settings.computerName,
    pageUrl:
      details.type === "main_frame" ? details.url : details.documentUrl || row.url,
    requestUrl: details.url,
    domain: TararaMatching.domainOf(details.url),
    method: details.method,
    resourceType: details.type,
    statusCode: meta.statusCode ?? null,
    contentType,
    requestBody: request.requestBody,
    requestBodyEncoding: request.requestBodyEncoding,
    requestBodyTruncated: request.requestBodyTruncated,
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
    // Cap in UTF-8 bytes like every other body, not in characters.
    const bytes = new TextEncoder().encode(text);
    const truncated = bytes.length > MAX_BODY_BYTES;
    return {
      requestBody: truncated
        ? new TextDecoder().decode(bytes.subarray(0, MAX_BODY_BYTES), { stream: true })
        : text,
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
  // Serialize once: the string is what gets sent and what is measured.
  const body = JSON.stringify(payload);
  state.queue.push({ body, size: body.length });
  state.queueBytes += body.length;
  // Newer data is worth more than older: when the endpoint is down long enough
  // to fill the queue, the oldest pending reports make room.
  while (
    state.queue.length > 1 &&
    (state.queueBytes > MAX_QUEUE_BYTES || state.queue.length > MAX_QUEUE_LENGTH)
  ) {
    state.queueBytes -= state.queue.shift().size;
    state.stats.dropped++;
  }
  updateBadge();
  drainQueue();
}

// Stop means stop: pending reports are thrown away, any in-flight delivery is
// aborted and a scheduled retry is cancelled.
function discardQueue() {
  state.generation++;
  state.stats.dropped += state.queue.length;
  state.queue = [];
  state.queueBytes = 0;
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
  if (state.abortController) state.abortController.abort();
  state.abortController = null;
  state.sending = false;
  state.retryIndex = 0;
  state.lastError = null; // a "retrying in N s" message would be stale now
}

// Deliver pending reports oldest first. A report leaves the queue only once it
// is delivered or permanently rejected; on a transient failure the whole queue
// pauses (RETRY_DELAYS_MS) and resumes with the same report.
async function drainQueue() {
  if (state.sending || state.retryTimer) return;
  state.sending = true;
  const generation = state.generation;
  try {
    while (state.queue.length > 0) {
      const item = state.queue[0];
      const outcome = await postOnce(item.body);
      if (generation !== state.generation) return; // stopped meanwhile
      if (outcome.kind === "retry") {
        const delay = RETRY_DELAYS_MS[Math.min(state.retryIndex, RETRY_DELAYS_MS.length - 1)];
        state.retryIndex++;
        state.lastError = `Delivery failed (${outcome.message}), retrying in ${delay / 1000} s`;
        console.error("Tarara: delivery failed, will retry", outcome.message);
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          drainQueue();
        }, delay);
        updateBadge();
        return;
      }
      state.queue.shift();
      state.queueBytes -= item.size;
      state.retryIndex = 0;
      if (outcome.kind === "ok") {
        state.stats.sent++;
        state.lastError = null;
      } else {
        state.stats.failed++;
        state.lastError = `Report rejected by the endpoint (${outcome.message})`;
        console.error("Tarara: report rejected, not retrying", outcome.message);
      }
      updateBadge();
    }
  } finally {
    if (generation === state.generation) state.sending = false;
  }
}

// One delivery attempt. Returns { kind: "ok" | "retry" | "rejected", message }.
// Network errors, timeouts, 408, 429 and 5xx are transient ("retry"); any other
// non-2xx status means the endpoint will never accept this report ("rejected").
async function postOnce(body) {
  const controller = new AbortController();
  state.abortController = controller;
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const headers = { "Content-Type": "application/json" };
    // Optional API key set on the settings page; sent as a header so the
    // endpoint can authenticate the report. Sent only when configured.
    const apiKey = (state.settings.apiKey || "").trim();
    if (apiKey) headers["X-API-Key"] = apiKey;
    const response = await fetch(state.settings.apiEndpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (response.ok) return { kind: "ok", message: null };
    const status = response.status;
    const transient = status === 408 || status === 429 || status >= 500;
    return { kind: transient ? "retry" : "rejected", message: `HTTP ${status}` };
  } catch (error) {
    const message = error.name === "AbortError" ? "timed out" : error.message;
    return { kind: "retry", message };
  } finally {
    clearTimeout(timer);
    if (state.abortController === controller) state.abortController = null;
  }
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
    color: state.stats.failed > 0 || state.stats.dropped > 0 ? "#b91c1c" : "#2e7d32",
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
    domain: TararaMatching.domainOf(frame.socketUrl),
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

// The WebSocket hook's first question on every page load: should this frame
// capture at all? Only frames inside a tracked tab of a row that opted into
// WebSocket capture get a yes; everything else uninstalls the hook.
function handleWsHookHello(sender) {
  const row = state.running && sender && sender.tab
    ? state.trackedTabs.get(sender.tab.id)
    : null;
  return { capture: Boolean(row && TararaMatching.webSocketEnabled(row.contentTypes)) };
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message && message.type) {
    case "wsHookHello":
      return Promise.resolve(handleWsHookHello(sender));
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
