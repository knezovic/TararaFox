"use strict";

/* global TararaDefaults */

const rowsBody = document.getElementById("rows-body");
const computerNameInput = document.getElementById("computer-name");
const apiEndpointInput = document.getElementById("api-endpoint");
const statusEl = document.getElementById("status");

let statusTimer = null;

init();

async function init() {
  const { settings } = await browser.storage.local.get("settings");
  const merged = { ...TararaDefaults.defaultSettings(), ...(settings || {}) };

  computerNameInput.value = merged.computerName;
  apiEndpointInput.value = merged.apiEndpoint;

  const rows = merged.rows && merged.rows.length > 0 ? merged.rows : [TararaDefaults.newRow()];
  for (const row of rows) {
    rowsBody.appendChild(renderRow(row));
  }

  document.getElementById("add-row").addEventListener("click", () => {
    rowsBody.appendChild(renderRow(TararaDefaults.newRow()));
  });
  document.getElementById("reset-computer-name").addEventListener("click", () => {
    computerNameInput.value = TararaDefaults.defaultComputerName();
  });
  document.getElementById("save").addEventListener("click", save);
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
  tr.appendChild(cell(url));

  const patterns = document.createElement("textarea");
  patterns.className = "row-patterns";
  patterns.rows = 2;
  patterns.placeholder = "https://example.com/api/*";
  patterns.spellcheck = false;
  patterns.title = "One pattern per line or comma-separated. * is a wildcard. Empty = every request in the tab.";
  patterns.value = row.patterns || "";
  tr.appendChild(cell(patterns));

  tr.appendChild(cell(renderTypes(row.contentTypes)));

  const refresh = document.createElement("input");
  refresh.type = "number";
  refresh.className = "row-refresh";
  refresh.min = "0";
  refresh.step = "1";
  refresh.title = "Reload the tab every N seconds. 0 = no automatic reload.";
  refresh.value = String(Math.max(0, Math.floor(Number(row.refreshSeconds)) || 0));
  tr.appendChild(cell(refresh));

  const scroll = document.createElement("input");
  scroll.type = "checkbox";
  scroll.className = "row-scroll";
  scroll.checked = row.scrollToEnd === true;
  scroll.title = "Slowly scroll the tab to the bottom, continuing as lazy-loaded content appears.";
  tr.appendChild(cell(scroll));

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
    }))
    .filter((row) => row.url || row.patterns);

  return {
    computerName: computerNameInput.value.trim() || TararaDefaults.defaultComputerName(),
    apiEndpoint: apiEndpointInput.value.trim(),
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
  settings.rows.forEach((row, index) => {
    if (!isHttpUrl(row.url)) {
      errors.push(`Entry ${index + 1}: tab URL must be a valid http(s) URL.`);
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

function showStatus(message, isError) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", Boolean(isError));
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusEl.textContent = "";
  }, 5000);
}
