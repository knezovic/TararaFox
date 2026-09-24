"use strict";

/* global TararaDefaults */

const rowsBody = document.getElementById("rows-body");
const computerNameInput = document.getElementById("computer-name");
const apiEndpointInput = document.getElementById("api-endpoint");
const apiKeyInput = document.getElementById("api-key");
const statusEl = document.getElementById("status");

let statusTimer = null;

init();

async function init() {
  const { settings } = await browser.storage.local.get("settings");
  fillForm({ ...TararaDefaults.defaultSettings(), ...(settings || {}) });

  document.getElementById("add-row").addEventListener("click", () => {
    rowsBody.appendChild(renderRow(TararaDefaults.newRow()));
  });
  document.getElementById("save").addEventListener("click", save);
  document.getElementById("export").addEventListener("click", exportSettings);
  document.getElementById("import").addEventListener("click", () => {
    document.getElementById("import-file").click();
  });
  document
    .getElementById("import-file")
    .addEventListener("change", importSettings);
}

// Populate every field (general inputs + watched-tab rows) from a merged
// settings object. Shared by initial load and import so both go through one
// code path. Clears any existing rows first so import replaces, not appends.
function fillForm(merged) {
  computerNameInput.value = merged.computerName;
  apiEndpointInput.value = merged.apiEndpoint;
  apiKeyInput.value = merged.apiKey || "";

  rowsBody.replaceChildren();
  const rows =
    merged.rows && merged.rows.length > 0 ? merged.rows : [TararaDefaults.newRow()];
  for (const row of rows) {
    rowsBody.appendChild(renderRow(row));
  }
}

function renderRow(row) {
  const tr = document.createElement("tr");
  tr.dataset.id = row.id || crypto.randomUUID();

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.className = "row-enabled";
  enabled.checked = row.enabled !== false;
  enabled.title = "Enabled";
  tr.appendChild(cell(enabled));

  const url = document.createElement("input");
  url.type = "url";
  url.className = "row-url";
  url.placeholder = "https://example.com/dashboard";
  url.spellcheck = false;
  url.value = row.url || "";

  const patterns = document.createElement("textarea");
  patterns.className = "row-patterns";
  patterns.rows = 2;
  patterns.placeholder = "https://example.com/api/*";
  patterns.spellcheck = false;
  patterns.title = "One pattern per line or comma-separated. * is a wildcard. Empty = every request in the tab.";
  patterns.value = row.patterns || "";

  // Stack the tab URL and its URL patterns vertically in one wide cell, so both
  // inputs get the full combined column width (longer fields) instead of sharing
  // the row across two narrow side-by-side columns.
  const targetWrap = document.createElement("div");
  targetWrap.className = "row-target";
  targetWrap.appendChild(url);
  targetWrap.appendChild(patterns);
  tr.appendChild(cell(targetWrap));

  tr.appendChild(cell(renderTypes(row.contentTypes)));

  const refresh = document.createElement("input");
  refresh.type = "number";
  refresh.className = "row-refresh";
  refresh.min = "0";
  refresh.step = "1";
  refresh.title = `Reload the tab every N seconds (at least ${TararaDefaults.MIN_REFRESH_SECONDS}). 0 = no automatic reload.`;
  refresh.value = String(Math.max(0, Math.floor(Number(row.refreshSeconds)) || 0));
  tr.appendChild(cell(refresh));

  const scroll = document.createElement("input");
  scroll.type = "checkbox";
  scroll.className = "row-scroll";
  scroll.checked = row.scrollToEnd === true;
  scroll.title = "Slowly scroll the tab to the bottom, continuing as lazy-loaded content appears.";
  tr.appendChild(cell(scroll));

  const activate = document.createElement("input");
  activate.type = "checkbox";
  activate.className = "row-activate";
  activate.checked = row.activate === true;
  activate.title = "Bring this tab to the foreground whenever it loads or refreshes (Firefox throttles background tabs, so lazy content may not load in a hidden tab). Steals focus.";
  tr.appendChild(cell(activate));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = "Remove entry";
  remove.addEventListener("click", () => tr.remove());
  tr.appendChild(cell(remove));

  return tr;
}

function renderTypes(selectedTypes) {
  const selected =
    Array.isArray(selectedTypes) && selectedTypes.length > 0 ? selectedTypes : ["all"];
  const wrap = document.createElement("div");
  wrap.className = "types row-types";

  for (const option of TararaDefaults.CONTENT_TYPE_OPTIONS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.dataset.type = option.key;
    box.checked = selected.includes(option.key);
    label.appendChild(box);
    label.appendChild(document.createTextNode(option.label));
    wrap.appendChild(label);
  }

  // "All" is mutually exclusive with the specific types.
  wrap.addEventListener("change", (event) => {
    const changed = event.target;
    if (!changed.matches("input[type=checkbox]") || !changed.checked) return;
    const boxes = [...wrap.querySelectorAll("input[type=checkbox]")];
    if (changed.dataset.type === "all") {
      for (const box of boxes) {
        if (box.dataset.type !== "all") box.checked = false;
      }
    } else {
      boxes.find((box) => box.dataset.type === "all").checked = false;
    }
  });

  return wrap;
}

function cell(child) {
  const td = document.createElement("td");
  td.appendChild(child);
  return td;
}

function collect() {
  const rows = [...rowsBody.querySelectorAll("tr")]
    .map((tr) => ({
      id: tr.dataset.id,
      enabled: tr.querySelector(".row-enabled").checked,
      url: tr.querySelector(".row-url").value.trim(),
      patterns: tr.querySelector(".row-patterns").value.trim(),
      contentTypes: collectTypes(tr),
      refreshSeconds: Math.max(
        0,
        Math.floor(Number(tr.querySelector(".row-refresh").value)) || 0
      ),
      scrollToEnd: tr.querySelector(".row-scroll").checked,
      activate: tr.querySelector(".row-activate").checked,
    }))
    .filter((row) => row.url || row.patterns);

  return {
    computerName: computerNameInput.value.trim() || TararaDefaults.defaultComputerName(),
    apiEndpoint: apiEndpointInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    rows,
  };
}

function collectTypes(tr) {
  const selected = [...tr.querySelectorAll(".row-types input:checked")].map(
    (box) => box.dataset.type
  );
  return selected.length > 0 ? selected : ["all"];
}

function validate(settings) {
  const errors = [];
  // The API endpoint receives captured response/request bodies, which may be
  // sensitive, so it must be HTTPS — never plaintext HTTP.
  if (settings.apiEndpoint && !isHttpsUrl(settings.apiEndpoint)) {
    errors.push("API endpoint must be a valid https URL.");
  }
  // Tab URLs may be HTTP — the user may need to watch a non-HTTPS site.
  // Disabled entries are ignored when monitoring starts, so they are not
  // validated either: a half-edited disabled entry must not block saving.
  settings.rows.forEach((row, index) => {
    if (!row.enabled) return;
    if (!isHttpUrl(row.url)) {
      errors.push(`Entry ${index + 1}: tab URL must be a valid http(s) URL.`);
    }
    if (row.refreshSeconds > 0 && row.refreshSeconds < TararaDefaults.MIN_REFRESH_SECONDS) {
      errors.push(
        `Entry ${index + 1}: refresh must be 0 (off) or at least ${TararaDefaults.MIN_REFRESH_SECONDS} seconds.`
      );
    }
  });
  return errors;
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

async function save() {
  const settings = collect();
  const errors = validate(settings);
  if (errors.length > 0) {
    showStatus(errors[0], true);
    return;
  }
  await browser.storage.local.set({ settings });
  showStatus("Saved. Changes apply the next time monitoring starts.", false);
}

// Write the current form values to a downloadable JSON file. The apiKey is
// included so the backup is complete — keep the file safe. Uses a Blob +
// object URL + a temporary anchor so no "downloads" permission is needed.
function exportSettings() {
  const envelope = {
    format: "tarara-settings",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: collect(),
  };
  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
  a.download = `tarara-settings-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showStatus("Exported settings to file.", false);
}

// Read a JSON file and fill the form with its settings, merging over defaults.
// Accepts both the versioned envelope ({ format, settings }) and a bare
// settings object. Does NOT write to storage — the user reviews the filled
// form and clicks Save to commit, reusing the normal validate() + save() path.
function importSettings(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const incoming =
        parsed && parsed.format === "tarara-settings" && parsed.settings
          ? parsed.settings
          : parsed; // accept a bare settings object too
      if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
        showStatus("Invalid file: not a settings object.", true);
        return;
      }
      if (incoming.rows !== undefined && !Array.isArray(incoming.rows)) {
        showStatus("Invalid file: \"rows\" must be a list of watched tabs.", true);
        return;
      }
      const { settings: clean, skippedRows } = sanitizeImported(incoming);
      fillForm({ ...TararaDefaults.defaultSettings(), ...clean });
      const skipped = skippedRows > 0
        ? ` ${skippedRows} invalid ${skippedRows === 1 ? "entry was" : "entries were"} skipped.`
        : "";
      showStatus(`Imported settings — review and click Save to apply.${skipped}`, false);
    } catch (err) {
      showStatus("Invalid file: " + (err.message || "could not parse JSON"), true);
    }
  };
  reader.onerror = () => showStatus("Could not read the file.", true);
  reader.readAsText(file);
  event.target.value = ""; // allow re-importing the same file
}

// Keep only well-typed fields from an imported file, so a hand-edited or
// foreign JSON file cannot put odd values into the form (a string "rows"
// used to become one entry per character). Missing or mistyped fields are
// left out and fall back to the defaults; rows that are not objects are
// skipped and counted.
function sanitizeImported(incoming) {
  const str = (value) => (typeof value === "string" ? value : undefined);
  const knownTypes = new Set(TararaDefaults.CONTENT_TYPE_OPTIONS.map((option) => option.key));
  const settings = {};
  if (str(incoming.computerName)) settings.computerName = incoming.computerName;
  if (str(incoming.apiEndpoint) !== undefined) settings.apiEndpoint = incoming.apiEndpoint;
  if (str(incoming.apiKey) !== undefined) settings.apiKey = incoming.apiKey;

  let skippedRows = 0;
  if (Array.isArray(incoming.rows)) {
    settings.rows = [];
    for (const row of incoming.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        skippedRows++;
        continue;
      }
      const contentTypes = Array.isArray(row.contentTypes)
        ? row.contentTypes.filter((type) => knownTypes.has(type))
        : [];
      const refresh = Math.floor(Number(row.refreshSeconds));
      settings.rows.push({
        id: str(row.id) || crypto.randomUUID(),
        enabled: row.enabled !== false,
        url: str(row.url) || "",
        patterns: str(row.patterns) || "",
        contentTypes: contentTypes.length > 0 ? contentTypes : ["all"],
        refreshSeconds: Number.isFinite(refresh) && refresh > 0 ? refresh : 0,
        scrollToEnd: row.scrollToEnd === true,
        activate: row.activate === true,
      });
    }
  }
  return { settings, skippedRows };
}

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 5000);
}
