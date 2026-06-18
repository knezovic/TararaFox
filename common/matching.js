"use strict";

/**
 * URL-pattern and Content-Type matching shared by the background page and
 * (potentially) the options page.
 */
const TararaMatching = (() => {
  const regexpCache = new Map();

  /** Split a patterns field into individual patterns (newline or comma separated). */
  function parsePatterns(text) {
    return String(text || "")
      .split(/[\n,]+/)
      .map((pattern) => pattern.trim())
      .filter(Boolean);
  }

  /** Compile a wildcard pattern (`*` matches any run of characters) to a RegExp. */
  function wildcardToRegExp(pattern) {
    let regexp = regexpCache.get(pattern);
    if (!regexp) {
      const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      regexp = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`, "i");
      if (regexpCache.size > 200) regexpCache.clear();
      regexpCache.set(pattern, regexp);
    }
    return regexp;
  }

  /** An empty patterns field matches every request in the tab. */
  function urlMatches(url, patternsText) {
    const patterns = parsePatterns(patternsText);
    if (patterns.length === 0) return true;
    return patterns.some((pattern) => wildcardToRegExp(pattern).test(url));
  }

  /**
   * Match a WebSocket URL against a row's patterns. The patterns field is shared
   * with the HTTP path, where users naturally write http(s) patterns, so the
   * socket URL is also tested with its scheme normalized (`wss://` -> `https://`,
   * `ws://` -> `http://`). An empty patterns field still matches every frame.
   */
  function socketUrlMatches(socketUrl, patternsText) {
    if (urlMatches(socketUrl, patternsText)) return true;
    const raw = String(socketUrl || "");
    const normalized = raw.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
    return normalized !== raw && urlMatches(normalized, patternsText);
  }

  function normalizeMimeType(contentTypeHeader) {
    return String(contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  }

  function charsetOf(contentTypeHeader) {
    const match = /charset=["']?([\w-]+)/i.exec(String(contentTypeHeader || ""));
    return match ? match[1] : null;
  }

  /** Map a MIME type to one of the filter categories, or null if none apply. */
  function categorizeMimeType(mime) {
    if (!mime) return null;
    if (mime === "application/json" || mime === "text/json" || mime.endsWith("+json")) return "json";
    if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
    if (mime === "application/xml" || mime === "text/xml" || mime.endsWith("+xml")) return "xml";
    if (mime === "text/css") return "css";
    if (
      mime === "application/javascript" ||
      mime === "text/javascript" ||
      mime === "application/x-javascript" ||
      mime === "application/ecmascript" ||
      mime === "text/ecmascript"
    ) {
      return "javascript";
    }
    if (mime.startsWith("text/")) return "text";
    return null;
  }

  function contentTypeMatches(contentTypeHeader, selectedTypes) {
    const selected =
      Array.isArray(selectedTypes) && selectedTypes.length > 0 ? selectedTypes : ["all"];
    if (selected.includes("all")) return true;
    const category = categorizeMimeType(normalizeMimeType(contentTypeHeader));
    return category !== null && selected.includes(category);
  }

  /**
   * Whether WebSocket frames should be captured for a row. WebSocket frames
   * have no MIME type, so they are gated by an explicit "websocket" selection
   * (or "All", which covers everything).
   */
  function webSocketEnabled(selectedTypes) {
    const selected =
      Array.isArray(selectedTypes) && selectedTypes.length > 0 ? selectedTypes : ["all"];
    return selected.includes("all") || selected.includes("websocket");
  }

  /** Whether the body should be forwarded as text (otherwise it is base64-encoded). */
  function isTextual(contentTypeHeader) {
    return (
      categorizeMimeType(normalizeMimeType(contentTypeHeader)) !== null ||
      charsetOf(contentTypeHeader) !== null
    );
  }

  return {
    parsePatterns,
    urlMatches,
    socketUrlMatches,
    normalizeMimeType,
    charsetOf,
    contentTypeMatches,
    webSocketEnabled,
    isTextual,
  };
})();
