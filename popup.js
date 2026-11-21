const $ = (id) => document.getElementById(id);

let state = {
  queue: [],
  currentIndex: 0,
  isRunning: false,
  isPaused: false,
  results: [],
  activeFilter: "all",
  targetTabId: null,
  statusText: "Ready",
  // Set when the input came from an uploaded workbook/table, so switching
  // between Auto/MSISDN/IMSI/ICCID can re-pick the matching column.
  sheetTable: null
};

const foundStatuses = new Set(["FOUND", "ACTIVATED", "ALREADY_ACTIVE"]);

// --- Identifier parsing helpers (shared with parser.js) ---
const {
  getParsedQueue,
  parseDelimitedText,
  extractIdentifiersFromTable,
  parseWorkbook
} = AmtelParser;

// --- Uploaded file: status line + column-aware loading ---
function showSourceStatus(text, kind = "") {
  const el = $("sourceStatus");
  if (!el) return;
  el.textContent = text || "";
  el.className = "source-status" + (text ? "" : " hidden") + (kind ? ` ${kind}` : "");
}

function describeSource(table) {
  const count = table.values.length;
  const typeLabel = table.type && table.type !== "auto" ? ` (${table.type})` : "";
  const parts = [`${count} identifier${count === 1 ? "" : "s"}${typeLabel}`];
  if (table.sourceLabel) parts.push(table.sourceLabel);
  if (table.columnLetter) parts.push(`column ${table.columnLetter}`);
  if (table.invalidCount > 0) parts.push(`${table.invalidCount} skipped`);
  return parts.join(" · ");
}

function setSearchMode(mode, { reload = true } = {}) {
  $("searchTypeSelect").value = mode;
  document.querySelectorAll(".mode-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.value === mode);
  });
  if (reload) reloadFromLoadedSheet(mode);
}

// Re-read the stored worksheet/table and pull the column that matches `mode`.
// Returns true when the file was the source of the input (so the caller can skip
// its own updateLineCount call).
function reloadFromLoadedSheet(mode) {
  if (!state.sheetTable || !state.sheetTable.rows) return false;

  const extracted = extractIdentifiersFromTable(state.sheetTable.rows, mode);
  if (!extracted.values.length) {
    showSourceStatus(
      `⚠️ ${extracted.reason || `No ${mode} values in this file.`} Input left unchanged.`,
      "warn"
    );
    return true;
  }

  $("batchInput").value = extracted.values.join("\n");
  updateLineCount();
  savePopupSettings();
  showSourceStatus(
    `✓ ${describeSource({
      ...extracted,
      sourceLabel: state.sheetTable.sourceLabel
    })}`,
    "success"
  );
  return true;
}

function applyTableToInput(table) {
  if ($("searchTypeSelect").value === "auto" && ["IMSI", "MSISDN", "ICCID"].includes(table.type)) {
    setSearchMode(table.type, { reload: false });
  }

  $("batchInput").value = table.values.join("\n");
  state.sheetTable = {
    rows: table.rows,
    sourceLabel: table.sourceLabel || ""
  };
  updateLineCount();
  savePopupSettings();
  showSourceStatus(`✓ ${describeSource(table)}`, "success");
}

// --- Universal file handler (.xlsx, .xlsm, .csv, .tsv, .txt) ---
async function handleUploadedFile(file) {
  if (!file) return;

  const fileName = file.name || "file";
  const dotIndex = fileName.lastIndexOf(".");
  const ext = (dotIndex >= 0 ? fileName.slice(dotIndex + 1) : "").toLowerCase();
  const mode = $("searchTypeSelect").value;

  showSourceStatus(`Loading ${fileName}…`);

  try {
    let table;

    if (ext === "xlsx" || ext === "xlsm") {
      // Multi-column CRM exports: header row (IMSI / MSISDN / ICCID) is detected,
      // then the column matching the selected mode is loaded.
      table = await parseWorkbook(await file.arrayBuffer(), mode);
      table.sourceLabel = `sheet "${table.sheetName}"`;
    } else if (ext === "csv" || ext === "tsv" || ext === "txt") {
      const rows = parseDelimitedText(await file.text());
      table = { ...extractIdentifiersFromTable(rows, mode), sourceLabel: `file "${fileName}"` };
    } else {
      throw new Error(
        `Unsupported file type${ext ? ` ".${ext}"` : ""}. Use .xlsx, .xlsm, .csv, .tsv or .txt.`
      );
    }

    if (!table.values || table.values.length === 0) {
      throw new Error(table.reason || `No valid IMSI, MSISDN or ICCID values were found in "${fileName}".`);
    }

    applyTableToInput(table);
  } catch (err) {
    console.error("File processing error:", err);
    state.sheetTable = null;
    showSourceStatus(`⚠️ ${err.message}`, "error");
    alert(`Could not load "${fileName}":\n\n${err.message}`);
  }
}

// --- Target CRM Tab Resolution (Strictly crmamtel.com) ---
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
  const allTabs = await chrome.tabs.query({});
  const crmTabs = allTabs.filter(isCrmTab);

  if (crmTabs.length > 0) {
    const activeCrm = crmTabs.find((t) => t.active);
    return activeCrm || crmTabs[0];
  }
  return null;
}

// --- Audio Alerts ---
function playCompletionSound() {
  if (!$("soundCheck")?.checked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch (e) {
    console.debug("AudioContext chime not available:", e);
  }
}

function playWarningAlarm() {
  if (!$("soundCheck")?.checked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(440, ctx.currentTime);
    osc.frequency.setValueAtTime(330, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.6);
  } catch (e) {
    console.debug("AudioContext alarm not available:", e);
  }
}

// --- UI Updates & State Management ---
function updateBadge(connected, message = "") {
  const badge = $("connectionBadge");
  if (!badge) return;
  if (connected) {
    badge.textContent = message || "CRM Connected";
    badge.className = "badge connected";
  } else {
    badge.textContent = message || "CRM Disconnected";
    badge.className = "badge disconnected";
  }
}

function updateLineCount() {
  const rawText = $("batchInput").value;
  const dedupe = $("dedupeCheck")?.checked ?? true;
  const searchMode = $("searchTypeSelect").value;
  const parsed = getParsedQueue(rawText, searchMode, dedupe);
  const totalLines = rawText.split(/[\r\n,;]+/).filter((l) => l.trim().length > 0).length;

  if (dedupe && totalLines > parsed.length) {
    $("lineCountBadge").textContent = `${parsed.length} queued (${totalLines - parsed.length} dupes removed)`;
  } else {
    $("lineCountBadge").textContent = `${parsed.length} item${parsed.length === 1 ? "" : "s"}`;
  }
}

function renderUI() {
  const total = state.queue.length;
  const current = state.currentIndex;
  const percent = total > 0 ? Math.round((current / total) * 100) : 0;

  // Progress Bar
  if (state.isRunning || state.isPaused || total > 0) {
    $("progressSection").classList.remove("hidden");
    $("progressBar").style.width = `${percent}%`;
    $("progressPercent").textContent = `${percent}%`;
    $("progressCounter").textContent = `Processed ${current} / ${total}`;
    $("currentStatusText").textContent = state.statusText || (state.isRunning ? "Processing..." : "Ready");
  }

  // Session Expiry Alert on Resume button
  const isSessionExpiry = state.isPaused && state.statusText && state.statusText.includes("Session Expired");

  // Action Buttons State
  if (state.isRunning && !state.isPaused) {
    $("startBatchBtn").classList.add("hidden");
    $("pauseBatchBtn").classList.remove("hidden");
    $("resumeBatchBtn").classList.add("hidden");
    $("stopBatchBtn").classList.remove("hidden");
    $("batchInput").disabled = true;
  } else if (state.isPaused) {
    $("startBatchBtn").classList.add("hidden");
    $("pauseBatchBtn").classList.add("hidden");
    $("resumeBatchBtn").classList.remove("hidden");
    $("stopBatchBtn").classList.remove("hidden");
    $("batchInput").disabled = true;

    if (isSessionExpiry) {
      $("resumeBatchBtn").innerHTML = '<span class="btn-icon">▶</span> Resume (After Login)';
      $("resumeBatchBtn").classList.add("btn-glow");
    } else {
      $("resumeBatchBtn").innerHTML = '<span class="btn-icon">▶</span> Resume';
      $("resumeBatchBtn").classList.remove("btn-glow");
    }
  } else {
    $("startBatchBtn").classList.remove("hidden");
    $("pauseBatchBtn").classList.add("hidden");
    $("resumeBatchBtn").classList.add("hidden");
    $("stopBatchBtn").classList.add("hidden");
    $("batchInput").disabled = false;
  }

  // Summary Metrics
  const found = state.results.filter((r) => foundStatuses.has(r.status)).length;
  const activated = state.results.filter((r) => r.status === "ACTIVATED").length;
  const alreadyActive = state.results.filter((r) => r.status === "ALREADY_ACTIVE").length;
  const skipped = state.results.filter(
    (r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR"
  ).length;

  const setTxt = (id, val) => {
    const el = $(id);
    if (el) el.textContent = val;
  };

  setTxt("metricTotal", total);
  setTxt("metricFound", found);
  setTxt("metricActivated", activated);
  setTxt("metricAlreadyActive", alreadyActive);
  setTxt("metricSkipped", skipped);

  setTxt("countAll", state.results.length);
  setTxt("countFound", found);
  setTxt("countActivated", activated);
  setTxt("countAlreadyActive", alreadyActive);
  setTxt("countSkipped", skipped);

  // Retry Failed Button
  const retryBtn = $("retryFailedBtn");
  if (retryBtn) {
    if (skipped > 0 && !state.isRunning) {
      retryBtn.classList.remove("hidden");
      retryBtn.textContent = `🔁 Retry Failed (${skipped})`;
    } else {
      retryBtn.classList.add("hidden");
    }
  }

  if (state.results.length > 0) {
    $("reportSection").classList.remove("hidden");
  }

  renderReportList();
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function renderReportList() {
  const listEl = $("reportList");
  listEl.innerHTML = "";

  const filtered = state.results.filter((item) => {
    if (state.activeFilter === "all") return true;
    if (state.activeFilter === "FOUND") return foundStatuses.has(item.status);
    if (state.activeFilter === "SKIPPED")
      return item.status === "SKIPPED" || item.status === "NOT_FOUND" || item.status === "ERROR";
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
    const duration = item.durationMs ? ` • ${item.durationMs}ms` : "";
    const lastTopUp = item.lastTopUp || "N/A";
    const topUpClass = lastTopUp === "N/A" ? "na" : "amount";

    // Last Top-up sits immediately before the status badge, so the operator sees
    // the amount next to ACTIVE before moving on.
    row.innerHTML = `
      <div class="item-main">
        <div class="item-identifier">${escapeHtml(item.value)} <span style="font-size:10px; color:#64748b;">(${escapeHtml(item.type)}${duration})</span></div>
        <div class="item-detail">${escapeHtml(item.message || "Processed")}</div>
      </div>
      <div class="item-side">
        <span class="topup-pill ${topUpClass}" title="Last Top-up Amount">${escapeHtml(lastTopUp)}</span>
        <span class="item-badge ${badgeClass}">${badgeText}</span>
      </div>
    `;
    listEl.appendChild(row);
  });
}

// --- Sync with Persistent Background Service Worker ---
function syncFromBackground(bgState) {
  if (!bgState) return;
  const wasRunning = state.isRunning;
  state = { ...state, ...bgState };

  if (bgState.statusText && bgState.statusText.includes("Session Expired")) {
    playWarningAlarm();
  } else if (wasRunning && !state.isRunning && state.currentIndex >= state.queue.length && state.queue.length > 0) {
    playCompletionSound();
  }

  renderUI();
}

async function fetchBackgroundState() {
  try {
    const res = await chrome.runtime.sendMessage({ action: "GET_STATE" });
    if (res?.ok && res.state) {
      syncFromBackground(res.state);
    }
  } catch (err) {
    console.debug("[Amtel Batch] Could not reach background worker:", err);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "BATCH_UPDATE" && msg.state) {
    syncFromBackground(msg.state);
  }
});

async function savePopupSettings() {
  await chrome.storage.local.set({
    popupSettings: {
      inputRaw: $("batchInput").value,
      searchMode: $("searchTypeSelect").value,
      speedDelay: $("speedSelect")?.value || "800",
      dedupe: $("dedupeCheck")?.checked ?? true,
      sound: $("soundCheck")?.checked ?? true
    }
  });
}

async function restorePopupSettings() {
  try {
    const data = await chrome.storage.local.get("popupSettings");
    if (data.popupSettings) {
      const s = data.popupSettings;
      if (s.inputRaw && !state.isRunning && state.queue.length === 0) {
        $("batchInput").value = s.inputRaw;
      }
      if (s.speedDelay && $("speedSelect")) $("speedSelect").value = s.speedDelay;
      if (s.dedupe !== undefined && $("dedupeCheck")) $("dedupeCheck").checked = s.dedupe;
      if (s.sound !== undefined && $("soundCheck")) $("soundCheck").checked = s.sound;

      if (s.searchMode && s.searchMode !== "Account ID" && s.searchMode !== "Profile ID") {
        $("searchTypeSelect").value = s.searchMode;
        document.querySelectorAll(".mode-pill").forEach((pill) => {
          pill.classList.toggle("active", pill.dataset.value === s.searchMode);
        });
      }
    }
  } catch (e) {
    console.warn("Could not restore settings:", e);
  }

  const crmTab = await findCrmTab();
  if (crmTab) {
    state.targetTabId = crmTab.id;
    const titleSnippet = crmTab.title ? crmTab.title.slice(0, 18) : "Amtel CRM";
    updateBadge(true, `CRM: ${titleSnippet}`);
  } else {
    updateBadge(false, "CRM tab not found");
  }

  updateLineCount();
}

// --- Export Handlers ---
function copyReportToClipboard() {
  if (state.results.length === 0) return;
  const found = state.results.filter((r) => foundStatuses.has(r.status)).length;
  const activated = state.results.filter((r) => r.status === "ACTIVATED").length;
  const active = state.results.filter((r) => r.status === "ALREADY_ACTIVE").length;
  const skipped = state.results.filter(
    (r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR"
  ).length;

  let reportText = `=====================================\n`;
  reportText += `AMTEL BATCH ACTIVATION SUMMARY REPORT\n`;
  reportText += `Date: ${new Date().toLocaleString()}\n`;
  reportText += `Total Processed: ${state.results.length}\n`;
  reportText += `Found: ${found} | Activated: ${activated} | Already Active: ${active} | Failed/Skipped: ${skipped}\n`;
  reportText += `=====================================\n\n`;

  state.results.forEach((r, idx) => {
    const dur = r.durationMs ? ` (${r.durationMs}ms)` : "";
    const topUp = r.lastTopUp || "N/A";
    reportText += `${idx + 1}. ${r.type}: ${r.value} | Last Top-up: ${topUp} | [${r.status}] ${r.message}${dur}\n`;
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
  // Last_Topup deliberately sits before Status so the amount lines up next to
  // the ACTIVE column in the CSV as well.
  let csv = "Index,Identifier,Type,Last_Topup,Status,Message,Processed_At,Duration_ms\n";
  state.results.forEach((r, idx) => {
    const safeMsg = `"${(r.message || "").replace(/"/g, '""')}"`;
    const safeType = `"${r.type || ""}"`;
    const safeVal = `"${r.value || ""}"`;
    const safeTopUp = `"${(r.lastTopUp || "N/A").replace(/"/g, '""')}"`;
    const time = r.processedAt || "";
    const dur = r.durationMs || 0;
    csv += `${idx + 1},${safeVal},${safeType},${safeTopUp},"${r.status}",${safeMsg},"${time}",${dur}\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `amtel_activation_report_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadJsonReport() {
  if (state.results.length === 0) return;
  const data = {
    exportedAt: new Date().toISOString(),
    total: state.results.length,
    summary: {
      found: state.results.filter((r) => foundStatuses.has(r.status)).length,
      activated: state.results.filter((r) => r.status === "ACTIVATED").length,
      alreadyActive: state.results.filter((r) => r.status === "ALREADY_ACTIVE").length,
      failedOrSkipped: state.results.filter(
        (r) => r.status === "SKIPPED" || r.status === "NOT_FOUND" || r.status === "ERROR"
      ).length
    },
    results: state.results
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `amtel_activation_report_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- Event Listeners ---
document.querySelectorAll(".mode-pill").forEach((pill) => {
  pill.addEventListener("click", () => {
    document.querySelectorAll(".mode-pill").forEach((p) => p.classList.remove("active"));
    pill.classList.add("active");
    $("searchTypeSelect").value = pill.dataset.value;
    if (!reloadFromLoadedSheet(pill.dataset.value)) updateLineCount();
    savePopupSettings();
  });
});

$("searchTypeSelect").addEventListener("change", (e) => {
  document.querySelectorAll(".mode-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.value === e.target.value);
  });
  if (!reloadFromLoadedSheet(e.target.value)) updateLineCount();
  savePopupSettings();
});

$("batchInput").addEventListener("input", () => {
  // A manual edit detaches the input from the uploaded file's columns.
  state.sheetTable = null;
  showSourceStatus("");
  updateLineCount();
  savePopupSettings();
});

$("dedupeCheck").addEventListener("change", () => {
  updateLineCount();
  savePopupSettings();
});

$("speedSelect")?.addEventListener("change", savePopupSettings);
$("soundCheck")?.addEventListener("change", savePopupSettings);

// File Upload & Drag-and-Drop
const fileInput = $("fileInput");
const uploadFileBtn = $("uploadFileBtn");
const editorContainer = $("editorContainer");

if (uploadFileBtn && fileInput) {
  uploadFileBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    // Reset so selecting the same file again still fires a change event.
    e.target.value = "";
    if (file) handleUploadedFile(file);
  });
}

if (editorContainer) {
  editorContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    editorContainer.classList.add("drag-over");
  });
  editorContainer.addEventListener("dragleave", (e) => {
    e.preventDefault();
    editorContainer.classList.remove("drag-over");
  });
  editorContainer.addEventListener("drop", (e) => {
    e.preventDefault();
    editorContainer.classList.remove("drag-over");
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleUploadedFile(e.dataTransfer.files[0]);
    }
  });
}

// Toolbar Buttons
const sampleBtn = $("sampleBtn");
if (sampleBtn) {
  sampleBtn.addEventListener("click", () => {
    const samples = ["637900001057585", "716210819", "89252637900009210819"].join("\n");
    state.sheetTable = null;
    $("batchInput").value = samples;
    showSourceStatus("✓ 3 sample identifiers loaded (IMSI · MSISDN · ICCID)", "success");
    updateLineCount();
    savePopupSettings();
  });
}

// Main Batch Controls (delegated to background.js)
$("startBatchBtn").addEventListener("click", async () => {
  const searchMode = $("searchTypeSelect").value;
  const rawText = $("batchInput").value;
  const dedupe = $("dedupeCheck")?.checked ?? true;
  const items = getParsedQueue(rawText, searchMode, dedupe);

  if (items.length === 0) {
    alert("Please enter at least one identifier to process.");
    return;
  }

  const crmTab = await findCrmTab();
  if (!crmTab) {
    updateBadge(false, "CRM tab not found");
    alert("Could not find an open Amtel CRM tab. Please open https://www.crmamtel.com/ in Chrome.");
    return;
  }

  updateBadge(true, `CRM: ${crmTab.title ? crmTab.title.slice(0, 18) : "Connected"}`);
  const speedDelay = $("speedSelect")?.value || "800";

  await chrome.runtime.sendMessage({
    action: "START_BATCH",
    queue: items,
    speedDelay,
    targetTabId: crmTab.id
  });
});

$("pauseBatchBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "PAUSE_BATCH" });
});

$("resumeBatchBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "RESUME_BATCH" });
});

$("stopBatchBtn").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "STOP_BATCH" });
});

$("clearBtn").addEventListener("click", async () => {
  if (state.isRunning) return;
  state.sheetTable = null;
  $("batchInput").value = "";
  showSourceStatus("");
  updateLineCount();
  $("progressSection").classList.add("hidden");
  $("reportSection").classList.add("hidden");
  await chrome.runtime.sendMessage({ action: "CLEAR_BATCH" });
  await chrome.storage.local.remove("popupSettings");
  await chrome.storage.local.remove("backgroundBatchState");
});

// Retry Failed Items Button
const retryFailedBtn = $("retryFailedBtn");
if (retryFailedBtn) {
  retryFailedBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "RETRY_FAILED" });
  });
}

// Reset State Header Button
const resetHeaderBtn = $("resetHeaderBtn");
if (resetHeaderBtn) {
  resetHeaderBtn.addEventListener("click", async () => {
    if (state.isRunning) {
      const confirmReset = confirm("A batch process is currently running in the background. Stop and reset all state?");
      if (!confirmReset) return;
    }
    $("batchInput").value = "";
    state.sheetTable = null;
    showSourceStatus("");
    updateLineCount();
    $("progressSection").classList.add("hidden");
    $("reportSection").classList.add("hidden");
    await chrome.runtime.sendMessage({ action: "CLEAR_BATCH" });
    await chrome.storage.local.remove("popupSettings");
    await chrome.storage.local.remove("backgroundBatchState");
  });
}

// Export Buttons
$("copyReportBtn")?.addEventListener("click", copyReportToClipboard);
$("downloadCsvBtn")?.addEventListener("click", downloadCsvReport);
$("downloadJsonBtn")?.addEventListener("click", downloadJsonReport);

// Filter Tabs
document.querySelectorAll(".filter-tab").forEach((tab) => {
  tab.addEventListener("click", (e) => {
    document.querySelectorAll(".filter-tab").forEach((t) => t.classList.remove("active"));
    e.target.classList.add("active");
    state.activeFilter = e.target.dataset.filter;
    renderReportList();
  });
});

// Initialize on popup load
(async () => {
  await fetchBackgroundState();
  await restorePopupSettings();
  renderUI();
})();
