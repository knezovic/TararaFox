"use strict";

/**
 * Shared defaults and constants. Loaded by the background page, the options
 * page and the popup, so it must stay free of page-specific APIs.
 */
const TararaDefaults = (() => {
  const CONTENT_TYPE_OPTIONS = [
    { key: "all", label: "All" },
    { key: "json", label: "JSON" },
    { key: "xml", label: "XML" },
    { key: "html", label: "HTML" },
    { key: "text", label: "Text" },
    { key: "javascript", label: "JavaScript" },
    { key: "css", label: "CSS" },
    { key: "websocket", label: "WebSocket" },
  ];

  /** Default computer name in the "Tarara-yyyyMMdd" format. */
  function defaultComputerName(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `Tarara-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  }

  function newRow() {
    return {
      id: crypto.randomUUID(),
      enabled: true,
      url: "",
      patterns: "",
      contentTypes: ["all"],
      refreshSeconds: 0,
      scrollToEnd: false,
    };
  }

  function defaultSettings() {
    return {
      computerName: defaultComputerName(),
      apiEndpoint: "",
      rows: [],
    };
  }

  return { CONTENT_TYPE_OPTIONS, defaultComputerName, newRow, defaultSettings };
})();
