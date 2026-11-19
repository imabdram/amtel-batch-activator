// Amtel Batch Activator — Persistent Background Service Worker (Manifest V3)

// Configure Chrome Side Panel to open automatically on toolbar icon click
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  console.info("[Amtel Batch] Service worker installed & side panel behavior configured.");
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

// Fallback if browser does not support automatic openPanelOnActionClick
chrome.action?.onClicked?.addListener(async (tab) => {
  if (chrome.sidePanel?.open) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch (e) {
      console.warn("[Amtel Batch] Could not open side panel, opening tab instead:", e);
    }
  }
  chrome.tabs.create({ url: "popup.html" });
});

// --- State Management ---
const state = {
  queue: [],
  currentIndex: 0,
  isRunning: false,
  isPaused: false,
  results: [],
  speedDelay: 800,
  targetTabId: null,
  statusText: "Ready"
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function broadcastUpdate(extra = {}) {
  try {
    await chrome.runtime.sendMessage({
      type: "BATCH_UPDATE",
      state: {
        queue: state.queue,
        currentIndex: state.currentIndex,
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        results: state.results,
        speedDelay: state.speedDelay,
        targetTabId: state.targetTabId,
        statusText: state.statusText
      },
      ...extra
    });
  } catch {
    // Popup or side panel may not be open, which is expected
  }
}

async function saveState() {
  try {
    await chrome.storage.local.set({
      backgroundBatchState: {
        queue: state.queue,
        currentIndex: state.currentIndex,
        isRunning: state.isRunning,
        isPaused: state.isPaused,
        results: state.results,
        speedDelay: state.speedDelay,
        targetTabId: state.targetTabId,
        statusText: state.statusText
      }
    });
  } catch (err) {
    console.warn("[Amtel Batch] Failed to persist state:", err);
  }
}

async function restoreState() {
  try {
    const data = await chrome.storage.local.get("backgroundBatchState");
    if (data.backgroundBatchState) {
      const s = data.backgroundBatchState;
      state.queue = s.queue || [];
      state.currentIndex = s.currentIndex || 0;
      state.results = s.results || [];
      state.speedDelay = s.speedDelay || 800;
      state.targetTabId = s.targetTabId || null;
      state.isRunning = false;
      state.isPaused = s.isPaused || false;
      state.statusText = s.statusText || "Ready";
    }
  } catch (err) {
    console.warn("[Amtel Batch] Failed to restore state:", err);
  }
}

restoreState();

// --- CRM Tab Validator (Strictly crmamtel.com) ---
function isCrmTab(t) {
  if (!t || !t.id || !t.url) return false;
  try {
    const u = new URL(t.url);
    const host = u.hostname.toLowerCase();
    return host === "www.crmamtel.com" || host === "crmamtel.com";
  } catch {
    return false;
  }
}

async function findCrmTab() {
  if (state.targetTabId) {
    try {
      const tab = await chrome.tabs.get(state.targetTabId);
      if (isCrmTab(tab)) {
        return tab;
      }
    } catch {}
    state.targetTabId = null;
  }

  const allTabs = await chrome.tabs.query({});
  const crmTabs = allTabs.filter(isCrmTab);

  if (crmTabs.length > 0) {
    const activeCrm = crmTabs.find((t) => t.active);
    const chosen = activeCrm || crmTabs[0];
    state.targetTabId = chosen.id;
    return chosen;
  }

  return null;
}

async function sendToContent(action, payload = {}) {
  const tab = await findCrmTab();
  if (!tab?.id) {
    throw new Error(
      "No open Amtel CRM tab detected in Chrome. Please open https://www.crmamtel.com/ in a tab and log in."
    );
  }

  const message = { source: "amtel-batch-v1", action, ...payload };

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (firstErr) {
    // Tab was open before extension reload; dynamically inject content.js
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await sleep(350);
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (injectErr) {
      console.error("[Amtel Batch] Injection or send failed on tab:", tab.id, tab.url, injectErr);
      throw new Error(
        `Cannot connect to Amtel CRM tab "${tab.title || tab.url}" (ID: ${tab.id}). Reason: ${injectErr.message || firstErr.message}. Please refresh the Amtel CRM tab (F5).`
      );
    }
  }
}

// --- Notifications ---
function notifyCompletion(total, activated, failed) {
  try {
    if (chrome.notifications?.create) {
      const iconUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAACVJREFUOE9jZKAQMFKon2HUAIbRMAoGDIwm4Q8YqA0eDYPBAAMAHzEAAfW86wEAAAAASUVORK5CYII=";
      chrome.notifications.create({
        type: "basic",
        iconUrl,
        title: "Amtel Batch Activator — Finished",
        message: `Processed ${total} cards: ${activated} activated, ${failed} failed or skipped.`,
        priority: 2
      });
    }
  } catch {}
}

function notifySessionExpired(reason) {
  try {
    if (chrome.notifications?.create) {
      const iconUrl =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAACVJREFUOE9jZKAQMFKon2HUAIbRMAoGDIwm4Q8YqA0eDYPBAAMAHzEAAfW86wEAAAAASUVORK5CYII=";
      chrome.notifications.create({
        type: "basic",
        iconUrl,
        title: "⚠️ Amtel CRM Session Expired",
        message: "Your CRM session has timed out. Please log in to Amtel CRM, then click Resume.",
        priority: 2
      });
    }
  } catch {}
}

// --- Main Persistent Batch Execution Loop ---
async function runBatch() {
  if (state.isRunning) return;
  state.isRunning = true;
  state.isPaused = false;
  state.statusText = "Batch running...";
  await broadcastUpdate();
  await saveState();

  while (state.currentIndex < state.queue.length && state.isRunning && !state.isPaused) {
    const item = state.queue[state.currentIndex];
    const itemStarted = Date.now();

    state.statusText = `Checking ${item.type} ${item.value} (${state.currentIndex + 1}/${state.queue.length})...`;
    await broadcastUpdate();

    let result;
    if (item.status === "SKIPPED") {
      result = {
        value: item.value,
        type: item.type,
        status: "SKIPPED",
        message: item.message,
        processedAt: new Date().toISOString(),
        durationMs: 0
      };
    } else {
      try {
        const response = await sendToContent("processCard", { item });

        // Check for session expiry from CRM
        if (response?.status === "SESSION_EXPIRED") {
          state.isPaused = true;
          state.isRunning = false;
          state.statusText = "⚠️ PAUSED: CRM Session Expired! Please log back into CRM and click Resume.";
          notifySessionExpired(response.reason);
          await saveState();
          await broadcastUpdate();
          break;
        }

        const durationMs = Date.now() - itemStarted;
        if (response && response.ok) {
          result = {
            value: item.value,
            type: item.type,
            status: response.status,
            message: response.message || response.reason,
            processedAt: new Date().toISOString(),
            durationMs
          };
        } else {
          result = {
            value: item.value,
            type: item.type,
            status: "SKIPPED",
            message: response?.error || response?.reason || "Unknown error during CRM search.",
            processedAt: new Date().toISOString(),
            durationMs
          };
        }
      } catch (err) {
        if (err.message && err.message.includes("SESSION_EXPIRED")) {
          state.isPaused = true;
          state.isRunning = false;
          state.statusText = "⚠️ PAUSED: CRM Session Expired! Please log back into CRM and click Resume.";
          notifySessionExpired(err.message);
          await saveState();
          await broadcastUpdate();
          break;
        }

        result = {
          value: item.value,
          type: item.type,
          status: "SKIPPED",
          message: err.message,
          processedAt: new Date().toISOString(),
          durationMs: Date.now() - itemStarted
        };
      }
    }

    state.results.push(result);
    state.currentIndex++;
    await saveState();
    await broadcastUpdate();

    if (state.currentIndex < state.queue.length && state.isRunning && !state.isPaused) {
      await sleep(state.speedDelay || 800);
    }
  }

  if (state.isPaused) {
    if (!state.statusText.includes("Session Expired")) {
      state.statusText = `Paused at item ${state.currentIndex} of ${state.queue.length}.`;
    }
  } else if (state.currentIndex >= state.queue.length) {
    state.isRunning = false;
    state.statusText = "Batch finished.";
    const activated = state.results.filter((r) => r.status === "ACTIVATED").length;
    const failed = state.results.filter((r) => r.status === "SKIPPED" || r.status === "NOT_FOUND").length;
    notifyCompletion(state.queue.length, activated, failed);
  } else {
    state.statusText = "Batch stopped.";
  }

  state.isRunning = false;
  await saveState();
  await broadcastUpdate();
}

// --- Messages from Popup / Side Panel UI ---
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.action === "CHECK_CRM") {
    findCrmTab()
      .then((tab) => {
        if (tab) {
          sendResponse({ ok: true, tabTitle: tab.title, tabId: tab.id, url: tab.url });
        } else {
          sendResponse({ ok: false, error: "No open Amtel CRM tab found" });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (request?.action === "GET_STATE") {
    sendResponse({ ok: true, state });
    return true;
  }

  if (request?.action === "START_BATCH") {
    state.queue = request.queue || [];
    state.currentIndex = 0;
    state.results = [];
    state.speedDelay = parseInt(request.speedDelay, 10) || 800;
    state.targetTabId = request.targetTabId || state.targetTabId;
    runBatch();
    sendResponse({ ok: true });
    return true;
  }

  if (request?.action === "PAUSE_BATCH") {
    state.isPaused = true;
    state.statusText = "Pausing after current card...";
    broadcastUpdate();
    saveState();
    sendResponse({ ok: true });
    return true;
  }

  if (request?.action === "RESUME_BATCH") {
    state.isPaused = false;
    runBatch();
    sendResponse({ ok: true });
    return true;
  }

  if (request?.action === "STOP_BATCH") {
    state.isRunning = false;
    state.isPaused = false;
    state.statusText = "Batch stopped.";
    broadcastUpdate();
    saveState();
    sendResponse({ ok: true });
    return true;
  }

  if (request?.action === "CLEAR_BATCH") {
    state.isRunning = false;
    state.isPaused = false;
    state.queue = [];
    state.currentIndex = 0;
    state.results = [];
    state.statusText = "Ready";
    broadcastUpdate();
    saveState();
    sendResponse({ ok: true });
    return true;
  }

  if (request?.action === "RETRY_FAILED") {
    const failedItems = state.results
      .filter((r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR")
      .map((r) => ({
        raw: r.value,
        value: r.value,
        type: r.type,
        status: "PENDING"
      }));

    if (failedItems.length > 0) {
      state.results = state.results.filter(
        (r) => r.status !== "SKIPPED" && r.status !== "NOT_FOUND" && r.status !== "ERROR"
      );
      state.queue = failedItems;
      state.currentIndex = 0;
      runBatch();
    }
    sendResponse({ ok: true });
    return true;
  }
});
