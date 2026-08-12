const $ = (id) => document.getElementById(id);

const state = {
  queue: [],
  currentIndex: 0,
  isRunning: false,
  results: [],
  activeFilter: "all"
};

// --- Helper Utilities ---
function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeMsisdn(value) {
  let v = digits(value);
  if (v.startsWith("252")) v = v.slice(3);
  if (v.length === 7) v = `71${v}`;
  if (!/^71\d{7}$/.test(v)) {
    throw new Error(`Invalid MSISDN: "${value}". Must be 9 digits starting with 71, or last 7 digits.`);
  }
  return v;
}

function normalizeIccid(value) {
  let iccid = digits(value);
  if (/^\d{19,20}$/.test(iccid)) return iccid;
  if (iccid.length === 8) return `892526379000${iccid}`;
  if (iccid.length === 7) return `8925263790000${iccid}`;
  throw new Error(`Invalid ICCID: "${value}". Must be full 19-20 digits, 8 digits, or 7 digits.`);
}

function parseInputItem(rawLine, searchMode) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  const rawDigits = digits(trimmed);
  if (!rawDigits) return null;

  let type = searchMode;
  if (searchMode === "auto") {
    if (rawDigits.startsWith("89") || rawDigits.length >= 19 || rawDigits.length === 8 || (rawDigits.length === 7 && rawDigits.startsWith("9"))) {
      type = "iccid";
    } else {
      type = "msisdn";
    }
  }

  try {
    const value = type === "iccid" ? normalizeIccid(rawDigits) : normalizeMsisdn(rawDigits);
    return { raw: trimmed, value, type: type.toUpperCase(), status: "PENDING" };
  } catch (err) {
    return { raw: trimmed, value: rawDigits, type: type.toUpperCase(), status: "SKIPPED", message: err.message };
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active browser tab found.");
  return tab;
}

async function sendToContent(action, payload = {}) {
  const tab = await activeTab();
  const message = { source: "amtel-batch-v1", action, ...payload };
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await new Promise((resolve) => setTimeout(resolve, 200));
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      throw new Error("Cannot connect to https://www.crmamtel.com/. Please open Amtel CRM in this tab.");
    }
  }
}

// --- UI Updates & State Management ---
function updateBadge(connected, message = "") {
  const badge = $("connectionBadge");
  if (connected) {
    badge.textContent = "CRM Connected";
    badge.className = "badge connected";
  } else {
    badge.textContent = message || "CRM Disconnected";
    badge.className = "badge disconnected";
  }
}

function updateLineCount() {
  const lines = $("batchInput").value.split(/\r?\n/).filter((l) => l.trim().length > 0);
  $("lineCountBadge").textContent = `${lines.length} item${lines.length === 1 ? "" : "s"}`;
}

function renderUI() {
  const total = state.queue.length;
  const current = state.currentIndex;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  // Progress Bar
  if (state.isRunning || total > 0) {
    $("progressSection").classList.remove("hidden");
    $("progressBar").style.width = `${percent}%`;
    $("progressPercent").textContent = `${percent}%`;
    $("progressCounter").textContent = `Processed ${current} / ${total}`;
  }

  // Action Buttons
  if (state.isRunning) {
    $("startBatchBtn").classList.add("hidden");
    $("stopBatchBtn").classList.remove("hidden");
    $("stopBatchBtn").disabled = false;
    $("batchInput").disabled = true;
  } else {
    $("startBatchBtn").classList.remove("hidden");
    $("startBatchBtn").disabled = false;
    $("stopBatchBtn").classList.add("hidden");
    $("batchInput").disabled = false;
  }

  // Summary Metrics
  const activated = state.results.filter((r) => r.status === "ACTIVATED").length;
  const alreadyActive = state.results.filter((r) => r.status === "ALREADY_ACTIVE").length;
  const skipped = state.results.filter((r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR").length;

  $("metricTotal").textContent = total;
  $("metricActivated").textContent = activated;
  $("metricAlreadyActive").textContent = alreadyActive;
  $("metricSkipped").textContent = skipped;

  $("countAll").textContent = state.results.length;
  $("countActivated").textContent = activated;
  $("countAlreadyActive").textContent = alreadyActive;
  $("countSkipped").textContent = skipped;

  if (state.results.length > 0) {
    $("reportSection").classList.remove("hidden");
  }

  renderReportList();
}

function renderReportList() {
  const listEl = $("reportList");
  listEl.innerHTML = "";

  const filtered = state.results.filter((item) => {
    if (state.activeFilter === "all") return true;
    if (state.activeFilter === "SKIPPED") return item.status === "SKIPPED" || item.status === "NOT_FOUND" || item.status === "ERROR";
    return item.status === state.activeFilter;
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="text-align: center; color: #94a3b8; padding: 12px; font-size: 11px;">No records match filter.</div>`;
    return;
  }

  filtered.forEach((item) => {
    const row = document.createElement("div");
    row.className = "report-item";

    const badgeClass = item.status.toLowerCase();
    const badgeText = item.status === "ALREADY_ACTIVE" ? "ACTIVE" : item.status;

    row.innerHTML = `
      <div>
        <div class="item-identifier">${item.value} <span style="font-size:10px; color:#64748b;">(${item.type})</span></div>
        <div class="item-detail">${item.message || "Processed"}</div>
      </div>
      <span class="item-badge ${badgeClass}">${badgeText}</span>
    `;
    listEl.appendChild(row);
  });
}

async function saveState() {
  await chrome.storage.local.set({
    batchState: {
      queue: state.queue,
      currentIndex: state.currentIndex,
      results: state.results,
      inputRaw: $("batchInput").value,
      searchMode: $("searchTypeSelect").value
    }
  });
}

async function restoreState() {
  try {
    const data = await chrome.storage.local.get("batchState");
    if (data.batchState) {
      const s = data.batchState;
      state.queue = s.queue || [];
      state.currentIndex = s.currentIndex || 0;
      state.results = s.results || [];
      if (s.inputRaw) $("batchInput").value = s.inputRaw;
      if (s.searchMode) {
        $("searchTypeSelect").value = s.searchMode;
        document.querySelectorAll(".mode-pill").forEach((pill) => {
          pill.classList.toggle("active", pill.dataset.value === s.searchMode);
        });
      }
    }
    updateLineCount();
    renderUI();
  } catch (e) {
    console.warn("Could not restore state:", e);
  }

  try {
    await sendToContent("inspect");
    updateBadge(true);
  } catch (e) {
    updateBadge(false, e.message);
  }
}

// --- Main Batch Worker Loop ---
async function runBatch() {
  if (state.currentIndex >= state.queue.length) {
    state.isRunning = false;
    $("currentStatusText").textContent = "Batch process completed.";
    renderUI();
    await saveState();
    return;
  }

  state.isRunning = true;
  renderUI();

  while (state.currentIndex < state.queue.length && state.isRunning) {
    const item = state.queue[state.currentIndex];
    
    // Update live status text
    $("currentStatusText").textContent = `Checking ${item.type} ${item.value}...`;
    renderUI();

    let result;
    if (item.status === "SKIPPED") {
      // Item failed at parse time
      result = { value: item.value, type: item.type, status: "SKIPPED", message: item.message };
    } else {
      try {
        const response = await sendToContent("processCard", { item });
        if (response && response.ok) {
          result = {
            value: item.value,
            type: item.type,
            status: response.status, // "ACTIVATED", "ALREADY_ACTIVE", "NOT_FOUND", "SKIPPED"
            message: response.message || response.reason
          };
        } else {
          result = {
            value: item.value,
            type: item.type,
            status: "SKIPPED",
            message: response?.error || response?.reason || "Unknown error during CRM search."
          };
        }
      } catch (err) {
        result = {
          value: item.value,
          type: item.type,
          status: "SKIPPED",
          message: err.message
        };
      }
    }

    state.results.push(result);
    state.currentIndex++;
    renderUI();
    await saveState();

    // Small inter-item delay to allow CRM DOM stabilization
    if (state.currentIndex < state.queue.length && state.isRunning) {
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  state.isRunning = false;
  $("currentStatusText").textContent = "Batch finished.";
  renderUI();
  await saveState();
}

// --- Export Handlers ---
function copyReportToClipboard() {
  if (state.results.length === 0) return;
  const activated = state.results.filter((r) => r.status === "ACTIVATED").length;
  const active = state.results.filter((r) => r.status === "ALREADY_ACTIVE").length;
  const skipped = state.results.filter((r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR").length;

  let reportText = `=====================================\n`;
  reportText += `AMTEL BATCH ACTIVATION SUMMARY REPORT\n`;
  reportText += `Date: ${new Date().toLocaleString()}\n`;
  reportText += `Total Processed: ${state.results.length}\n`;
  reportText += `Activated: ${activated} | Already Active: ${active} | Skipped/Failed: ${skipped}\n`;
  reportText += `=====================================\n\n`;

  state.results.forEach((r, idx) => {
    reportText += `${idx + 1}. [${r.status}] ${r.type}: ${r.value} — ${r.message}\n`;
  });

  navigator.clipboard.writeText(reportText).then(() => {
    const btn = $("copyReportBtn");
    const orig = btn.textContent;
    btn.textContent = "✓ Copied!";
    setTimeout(() => (btn.textContent = orig), 2000);
  });
}

function downloadCsvReport() {
  if (state.results.length === 0) return;
  let csv = "Index,Identifier,Type,Status,Message\n";
  state.results.forEach((r, idx) => {
    const safeMsg = `"${(r.message || "").replace(/"/g, '""')}"`;
    csv += `${idx + 1},"${r.value}","${r.type}","${r.status}",${safeMsg}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `amtel_activation_report_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Event Listeners ---
document.querySelectorAll(".mode-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".mode-pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    $("searchTypeSelect").value = pill.dataset.value;
    saveState();
  });
});

const pasteBtn = $("pasteBtn");
if (pasteBtn) {
  pasteBtn.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        $("batchInput").value = text;
        updateLineCount();
        saveState();
      }
    } catch {
      alert("Please paste content directly into the text field.");
    }
  });
}

const sampleBtn = $("sampleBtn");
if (sampleBtn) {
  sampleBtn.addEventListener("click", () => {
    const samples = ["716210819", "6210827", "89252637900009210819", "9210819"].join("\n");
    $("batchInput").value = samples;
    updateLineCount();
    saveState();
  });
}

$("batchInput").addEventListener("input", () => {
  updateLineCount();
  saveState();
});

$("searchTypeSelect").addEventListener("change", () => {
  saveState();
});

$("startBatchBtn").addEventListener("click", () => {
  const searchMode = $("searchTypeSelect").value;
  const rawLines = $("batchInput").value.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    alert("Please enter at least one MSISDN or ICCID to process.");
    return;
  }

  const items = rawLines.map((l) => parseInputItem(l, searchMode)).filter(Boolean);
  state.queue = items;
  state.currentIndex = 0;
  state.results = [];
  
  runBatch();
});

$("stopBatchBtn").addEventListener("click", () => {
  state.isRunning = false;
  $("currentStatusText").textContent = "Stopping batch...";
  renderUI();
});

$("clearBtn").addEventListener("click", async () => {
  if (state.isRunning) return;
  $("batchInput").value = "";
  state.queue = [];
  state.currentIndex = 0;
  state.results = [];
  updateLineCount();
  $("progressSection").classList.add("hidden");
  $("reportSection").classList.add("hidden");
  renderUI();
  await chrome.storage.local.remove("batchState");
});

const resetHeaderBtn = $("resetHeaderBtn");
if (resetHeaderBtn) {
  resetHeaderBtn.addEventListener("click", async () => {
    if (state.isRunning) {
      const confirmReset = confirm("A batch process is currently running. Stop and reset all state?");
      if (!confirmReset) return;
    }
    state.isRunning = false;
    $("batchInput").value = "";
    state.queue = [];
    state.currentIndex = 0;
    state.results = [];
    updateLineCount();
    $("progressSection").classList.add("hidden");
    $("reportSection").classList.add("hidden");
    renderUI();
    await chrome.storage.local.remove("batchState");
  });
}

$("copyReportBtn").addEventListener("click", copyReportToClipboard);
$("downloadCsvBtn").addEventListener("click", downloadCsvReport);

document.querySelectorAll(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
    e.target.classList.add("active");
    state.activeFilter = e.target.dataset.filter;
    renderReportList();
  });
});

// Initialize on popup load
restoreState();
