const $ = (id) => document.getElementById(id);

let state = {
  queue: [],
  currentIndex: 0,
  isRunning: false,
  isPaused: false,
  results: [],
  activeFilter: "all",
  targetTabId: null,
  statusText: "Ready"
};

const foundStatuses = new Set(["FOUND", "ACTIVATED", "ALREADY_ACTIVE"]);

// --- Helper Utilities & Normalizers ---
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

function normalizeImsi(value) {
  const imsi = String(value || "").trim().replace(/\.00$/, "");
  if (!/^\d{15}$/.test(imsi)) {
    throw new Error(`Invalid IMSI: "${value}". Must be a 15-digit IMSI.`);
  }
  return imsi;
}

function extractIdentifierFromLine(rawLine) {
  let line = String(rawLine || "").trim();
  if (!line) return null;

  // Handle Excel / Sheets tab-delimited paste or CSV
  if (line.includes("\t")) {
    const cols = line.split("\t").map((c) => c.trim()).filter(Boolean);
    const candidate = cols.find((c) => /^\d+(\.00)?$/.test(c.replace(/\s+/g, "")));
    line = candidate || cols[0];
  } else if (line.includes(",") && !line.includes(" ")) {
    const cols = line.split(",").map((c) => c.trim()).filter(Boolean);
    const candidate = cols.find((c) => /^\d+(\.00)?$/.test(c.replace(/\s+/g, "")));
    line = candidate || cols[0];
  }
  return line.trim();
}

function parseInputItem(rawLine, searchMode) {
  const trimmed = extractIdentifierFromLine(rawLine);
  if (!trimmed) return null;

  let type = searchMode;
  if (searchMode === "auto") {
    const rawDigits = digits(trimmed);
    if (
      rawDigits.startsWith("89") ||
      rawDigits.length >= 19 ||
      rawDigits.length === 8 ||
      (rawDigits.length === 7 && rawDigits.startsWith("9"))
    ) {
      type = "ICCID";
    } else if (/^\d{15}(?:\.00)?$/.test(trimmed)) {
      type = "IMSI";
    } else {
      type = "MSISDN";
    }
  }

  try {
    let value;
    if (type === "ICCID") value = normalizeIccid(trimmed);
    else if (type === "MSISDN") value = normalizeMsisdn(trimmed);
    else if (type === "IMSI") value = normalizeImsi(trimmed);
    else value = trimmed.replace(/\.00$/, "").trim();
    return { raw: trimmed, value, type, status: "PENDING" };
  } catch (err) {
    return { raw: trimmed, value: trimmed, type, status: "SKIPPED", message: err.message };
  }
}

function getParsedQueue(rawText, searchMode, deduplicate = true) {
  const lines = rawText.split(/[\r\n,;]+/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  const queue = [];

  for (const rawLine of lines) {
    const item = parseInputItem(rawLine, searchMode);
    if (!item) continue;

    if (deduplicate) {
      const key = `${item.type}:${item.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    queue.push(item);
  }
  return queue;
}

// --- Native Pure JS XLSX Decompressor (Zero External Dependencies) ---
async function parseXlsxBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const files = {};
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    // Check local file header signature 0x04034b50 (PK\x03\x04)
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x4b || bytes[offset + 2] !== 0x03 || bytes[offset + 3] !== 0x04) {
      offset++;
      continue;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 30);
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const fileNameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);

    const nameStart = offset + 30;
    const nameBytes = bytes.slice(nameStart, nameStart + fileNameLen);
    const fileName = new TextDecoder().decode(nameBytes);

    const dataStart = nameStart + fileNameLen + extraLen;
    const dataEnd = dataStart + compressedSize;

    if (fileName.includes("sheet1.xml") || fileName.includes("sharedStrings.xml")) {
      const compressedData = bytes.slice(dataStart, dataEnd);
      let content = "";
      if (method === 8) {
        // Deflated with method 8
        const ds = new DecompressionStream("deflate-raw");
        const writer = ds.writable.getWriter();
        writer.write(compressedData);
        writer.close();
        const reader = ds.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let pos = 0;
        for (const chunk of chunks) {
          merged.set(chunk, pos);
          pos += chunk.length;
        }
        content = new TextDecoder().decode(merged);
      } else if (method === 0) {
        // Stored / uncompressed
        content = new TextDecoder().decode(compressedData);
      }
      files[fileName] = content;
    }

    offset = dataEnd;
  }

  // Parse shared strings table if present
  const sharedStrings = [];
  const sstKey = Object.keys(files).find((k) => k.includes("sharedStrings.xml"));
  if (sstKey && files[sstKey]) {
    const sstMatches = files[sstKey].matchAll(/<si>(.*?)<\/si>/gs);
    for (const match of sstMatches) {
      const textMatches = [...match[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join("");
      sharedStrings.push(textMatches);
    }
  }

  // Parse sheet1.xml cells in column A
  const sheetKey = Object.keys(files).find((k) => k.includes("sheet1.xml"));
  const identifiers = [];
  if (sheetKey && files[sheetKey]) {
    const cellMatches = files[sheetKey].matchAll(/<c\s+r="A(\d+)"([^>]*)>(.*?)<\/c>/gs);
    for (const match of cellMatches) {
      const attrs = match[2];
      const body = match[3];
      const valMatch = body.match(/<v>(.*?)<\/v>/);
      if (!valMatch) continue;

      let val = valMatch[1].trim();
      const isString = /t="s"/i.test(attrs);
      if (isString) {
        const idx = parseInt(val, 10);
        val = sharedStrings[idx] !== undefined ? sharedStrings[idx] : val;
      }

      val = String(val).replace(/\.00$/, "").trim();
      if (!val || /^(imsi|msisdn|number|id|subscriber|card)$/i.test(val)) continue;
      identifiers.push(val);
    }
  }

  return identifiers;
}

// --- CSV / TSV / TXT Parser ---
function parseTextFile(rawContent) {
  const lines = rawContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const identifiers = [];

  for (const line of lines) {
    let col = line;
    if (line.includes("\t")) {
      col = line.split("\t")[0];
    } else if (line.includes(",")) {
      col = line.split(",")[0];
    } else if (line.includes(";")) {
      col = line.split(";")[0];
    }

    col = col.replace(/^["']|["']$/g, "").trim();
    col = col.replace(/\.00$/, "").trim();

    if (!col || /^(imsi|msisdn|number|id|subscriber|card)$/i.test(col)) continue;
    identifiers.push(col);
  }

  return identifiers;
}

// --- Universal File Handler (.csv, .xlsx, .tsv, .txt) ---
async function handleUploadedFile(file) {
  if (!file) return;
  const fileName = file.name.toLowerCase();
  const titleEl = $("editorStatusTitle");
  titleEl.textContent = `LOADING ${file.name.toUpperCase()}...`;

  try {
    let items = [];
    if (fileName.endsWith(".xlsx")) {
      const buffer = await file.arrayBuffer();
      items = await parseXlsxBuffer(buffer);
    } else {
      const text = await file.text();
      items = parseTextFile(text);
    }

    if (items.length === 0) {
      alert(`No valid identifiers could be found in column 1 of "${file.name}".`);
      titleEl.textContent = "INPUT";
      return;
    }

    $("batchInput").value = items.join("\n");

    // Auto-select IMSI mode if items look like 15-digit IMSIs (e.g. starting with 6379)
    const isImsiSample = items.slice(0, 5).some((i) => /^\d{15}$/.test(i));
    if (isImsiSample) {
      $("searchTypeSelect").value = "IMSI";
      document.querySelectorAll(".mode-pill").forEach((pill) => {
        pill.classList.toggle("active", pill.dataset.value === "IMSI");
      });
    }

    updateLineCount();
    savePopupSettings();

    titleEl.textContent = `✓ LOADED ${items.length} ITEMS`;
    titleEl.classList.add("success-highlight");
    setTimeout(() => {
      titleEl.textContent = "INPUT";
      titleEl.classList.remove("success-highlight");
    }, 3500);
  } catch (err) {
    console.error("File processing error:", err);
    alert(`Could not parse file: ${err.message}`);
    titleEl.textContent = "INPUT";
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

    row.innerHTML = `
      <div>
        <div class="item-identifier">${item.value} <span style="font-size:10px; color:#64748b;">(${item.type}${duration})</span></div>
        <div class="item-detail">${item.message || "Processed"}</div>
      </div>
      <span class="item-badge ${badgeClass}">${badgeText}</span>
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
    reportText += `${idx + 1}. [${r.status}] ${r.type}: ${r.value} — ${r.message}${dur}\n`;
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
  let csv = "Index,Identifier,Type,Status,Message,Processed_At,Duration_ms\n";
  state.results.forEach((r, idx) => {
    const safeMsg = `"${(r.message || "").replace(/"/g, '""')}"`;
    const safeType = `"${r.type || ""}"`;
    const safeVal = `"${r.value || ""}"`;
    const time = r.processedAt || "";
    const dur = r.durationMs || 0;
    csv += `${idx + 1},${safeVal},${safeType},"${r.status}",${safeMsg},"${time}",${dur}\n`;
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
    updateLineCount();
    savePopupSettings();
  });
});

$("searchTypeSelect").addEventListener("change", (e) => {
  document.querySelectorAll(".mode-pill").forEach((pill) => {
    pill.classList.toggle("active", pill.dataset.value === e.target.value);
  });
  updateLineCount();
  savePopupSettings();
});

$("batchInput").addEventListener("input", () => {
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
    if (e.target.files && e.target.files.length > 0) {
      handleUploadedFile(e.target.files[0]);
    }
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
    $("batchInput").value = samples;
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
  $("batchInput").value = "";
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
