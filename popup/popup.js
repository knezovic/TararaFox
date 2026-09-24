"use strict";

const toggleButton = document.getElementById("toggle");
const statePill = document.getElementById("state-pill");
const sinceEl = document.getElementById("since");
const errorEl = document.getElementById("error");

const NOT_RESPONDING = "Tarara is not responding. Try again in a moment.";
let actionError = null; // why the last Start/Stop click failed, if it did

// The background may be briefly unavailable (e.g. while the add-on reloads),
// in which case sendMessage rejects or resolves to undefined.
async function getStatus() {
  try {
    return (await browser.runtime.sendMessage({ type: "getStatus" })) || null;
  } catch {
    return null;
  }
}

toggleButton.addEventListener("click", async () => {
  toggleButton.disabled = true;
  try {
    const status = await getStatus();
    if (!status) throw new Error(NOT_RESPONDING);
    const response = await browser.runtime.sendMessage({
      type: status.running ? "stop" : "start",
    });
    actionError = response && response.ok === false ? response.error : null;
  } catch (error) {
    actionError = error.message || NOT_RESPONDING;
  } finally {
    // Re-enable even if the refresh fails, so the button never stays stuck.
    try {
      await refresh();
    } finally {
      toggleButton.disabled = false;
    }
  }
});

document.getElementById("open-settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

async function refresh() {
  const status = await getStatus();
  if (!status) {
    showError(NOT_RESPONDING);
    return;
  }

  statePill.textContent = status.running ? "Running" : "Stopped";
  statePill.classList.toggle("running", status.running);
  statePill.classList.toggle("stopped", !status.running);

  document.getElementById("stat-tabs").textContent = String(status.trackedTabs);
  document.getElementById("stat-matched").textContent = String(status.stats.matched);
  document.getElementById("stat-sent").textContent = String(status.stats.sent);
  document.getElementById("stat-failed").textContent = String(status.stats.failed);
  document.getElementById("stat-dropped").textContent = String(status.stats.dropped || 0);

  sinceEl.hidden = !status.running;
  if (status.running && status.startedAt) {
    sinceEl.textContent = `Running since ${new Date(status.startedAt).toLocaleTimeString()}`;
  }

  toggleButton.textContent = status.running ? "Stop monitoring" : "Start monitoring";
  toggleButton.classList.toggle("danger", status.running);
  toggleButton.classList.toggle("primary", !status.running);

  showError(status.lastError || actionError);
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

refresh();
setInterval(refresh, 1000);
