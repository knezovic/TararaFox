"use strict";

const toggleButton = document.getElementById("toggle");
const statePill = document.getElementById("state-pill");
const sinceEl = document.getElementById("since");
const errorEl = document.getElementById("error");

toggleButton.addEventListener("click", async () => {
  toggleButton.disabled = true;
  try {
    const status = await browser.runtime.sendMessage({ type: "getStatus" });
    const response = await browser.runtime.sendMessage({
      type: status.running ? "stop" : "start",
    });
    showError(response && response.ok === false ? response.error : null);
  } finally {
    await refresh();
    toggleButton.disabled = false;
  }
});

document.getElementById("open-settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

async function refresh() {
  const status = await browser.runtime.sendMessage({ type: "getStatus" });

  statePill.textContent = status.running ? "Running" : "Stopped";
  statePill.classList.toggle("running", status.running);
  statePill.classList.toggle("stopped", !status.running);

  document.getElementById("stat-tabs").textContent = String(status.trackedTabs);
  document.getElementById("stat-matched").textContent = String(status.stats.matched);
  document.getElementById("stat-sent").textContent = String(status.stats.sent);
  document.getElementById("stat-failed").textContent = String(status.stats.failed);

  sinceEl.hidden = !status.running;
  if (status.running && status.startedAt) {
    sinceEl.textContent = `Running since ${new Date(status.startedAt).toLocaleTimeString()}`;
  }

  toggleButton.textContent = status.running ? "Stop monitoring" : "Start monitoring";
  toggleButton.classList.toggle("danger", status.running);
  toggleButton.classList.toggle("primary", !status.running);

  if (status.lastError) showError(status.lastError);
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

refresh();
setInterval(refresh, 1000);
