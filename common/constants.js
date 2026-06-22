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

  /**
   * Default computer name: "TARARA-" plus 6 random uppercase letters. Generated
   * once (at install, when default settings are seeded) so each install gets a
   * stable identifier, then editable by the user.
   */
  function defaultComputerName() {
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let suffix = "";
    for (let i = 0; i < 6; i += 1) suffix += letters[bytes[i] % letters.length];
    return `TARARA-${suffix}`;
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
      activate: false,
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
