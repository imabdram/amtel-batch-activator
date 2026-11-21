// Amtel Batch Activator — standalone identifier/table parser.
// Loaded before popup.js. Exposes a single global: AmtelParser.
//
// Responsibilities:
//   1. Normalise MSISDN / IMSI / ICCID values.
//   2. Parse pasted text (one identifier per line).
//   3. Parse real spreadsheet exports (.xlsx / .xlsm) with zero dependencies,
//      including multi-column "Batch create subscriber" sheets whose headers are
//      IMSI, MSISDN, ICCID, Primary Offering, etc.
//   4. Parse .csv / .tsv / .txt tables with the same header-aware column logic.

(function (global) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Identifier normalisation
  // ---------------------------------------------------------------------------

  function digits(value) {
    return String(value === null || value === undefined ? "" : value).replace(/\D/g, "");
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
    const imsi = String(value === null || value === undefined ? "" : value)
      .trim()
      .replace(/\.00$/, "");
    if (!/^\d{15}$/.test(imsi)) {
      throw new Error(`Invalid IMSI: "${value}". Must be a 15-digit IMSI.`);
    }
    return imsi;
  }

  function extractIdentifierFromLine(rawLine) {
    let line = String(rawLine === null || rawLine === undefined ? "" : rawLine).trim();
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

  function detectType(rawValue) {
    const rawDigits = digits(rawValue);
    if (
      rawDigits.startsWith("89") ||
      rawDigits.length >= 19 ||
      rawDigits.length === 8 ||
      (rawDigits.length === 7 && rawDigits.startsWith("9"))
    ) {
      return "ICCID";
    }
    if (/^\d{15}(?:\.00)?$/.test(rawValue)) return "IMSI";
    return "MSISDN";
  }

  function parseInputItem(rawLine, searchMode) {
    const trimmed = extractIdentifierFromLine(rawLine);
    if (!trimmed) return null;

    // Drop header labels (e.g. "IMSI", "MSISDN") that were pasted or exported
    // together with the data, instead of queueing them as invalid items.
    if (!/\d/.test(trimmed) && headerTypeForCell(trimmed)) return null;

    let type = searchMode;
    if (searchMode === "auto") type = detectType(trimmed);

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
    const lines = String(rawText || "")
      .split(/[\r\n,;]+/)
      .map((l) => l.trim())
      .filter(Boolean);
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

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  const COLUMN_TYPES = ["IMSI", "MSISDN", "ICCID"];

  const HEADER_ALIASES = {
    IMSI: "IMSI",
    "SUBSCRIBER IMSI": "IMSI",
    MSISDN: "MSISDN",
    "MSISDN NUMBER": "MSISDN",
    "MSISDN NO": "MSISDN",
    MOBILE: "MSISDN",
    "MOBILE NUMBER": "MSISDN",
    "MOBILE NO": "MSISDN",
    PHONE: "MSISDN",
    "PHONE NUMBER": "MSISDN",
    "PHONE NO": "MSISDN",
    TELEPHONE: "MSISDN",
    TEL: "MSISDN",
    "SUBSCRIBER NUMBER": "MSISDN",
    "SUBSCRIBER NO": "MSISDN",
    NUMBER: "MSISDN",
    ICCID: "ICCID",
    "ICC ID": "ICCID",
    SIM: "ICCID",
    "SIM NUMBER": "ICCID",
    "SIM SERIAL": "ICCID",
    "SIM SERIAL NUMBER": "ICCID",
    "SIM CARD": "ICCID",
    "SIM CARD NUMBER": "ICCID",
    "CARD NUMBER": "ICCID",
    USIM: "ICCID",
    "USIM NUMBER": "ICCID",
    CARD: "ICCID"
  };

  function normalizeHeaderToken(value) {
    return String(value === null || value === undefined ? "" : value)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();
  }

  function headerTypeForCell(value) {
    const token = normalizeHeaderToken(value);
    if (!token) return null;
    if (HEADER_ALIASES[token]) return HEADER_ALIASES[token];
    if (token.includes("IMSI")) return "IMSI";
    if (token.includes("ICCID")) return "ICCID";
    if (token.includes("MSISDN")) return "MSISDN";
    if (token.includes("SIM SERIAL") || token.includes("SIM NUMBER") || token === "SIM") return "ICCID";
    return null;
  }

  function columnLetter(index) {
    let n = Number(index) + 1;
    let out = "";
    while (n > 0) {
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out;
  }

  function columnIndexFromLetters(letters) {
    let n = 0;
    for (const ch of String(letters).toUpperCase()) {
      n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
  }

  function cellToString(cell) {
    if (cell === null || cell === undefined) return "";
    if (typeof cell === "object") return "";
    return String(cell).trim();
  }

  function mostCommon(values) {
    const counts = new Map();
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    let best = "auto";
    let bestCount = -1;
    for (const [v, c] of counts) {
      if (c > bestCount) {
        best = v;
        bestCount = c;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // Header detection + column extraction
  // ---------------------------------------------------------------------------

  function detectHeaderRow(rows, maxScan = 10) {
    const limit = Math.min(rows.length, maxScan);
    for (let r = 0; r < limit; r++) {
      const row = rows[r] || [];
      const map = {};
      let found = 0;
      for (let c = 0; c < row.length; c++) {
        const type = headerTypeForCell(row[c]);
        if (type && map[type] === undefined) {
          map[type] = c;
          found++;
        }
      }
      if (found > 0) return { rowIndex: r, map };
    }
    return null;
  }

  function describeHeaderMap(map) {
    const entries = Object.entries(map || {}).sort((a, b) => a[1] - b[1]);
    if (!entries.length) return "";
    return entries.map(([type, col]) => `${type} (${columnLetter(col)})`).join(", ");
  }

  function collectColumnValues(rows, columnIndex, startRow, mode) {
    const values = [];
    const types = [];
    let invalid = 0;

    for (let r = startRow; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const raw = cellToString(row[columnIndex]);
      if (!raw) continue;

      const item = parseInputItem(raw, mode);
      if (item && item.status !== "SKIPPED" && item.value) {
        values.push(raw);
        types.push(item.type);
      } else {
        invalid++;
      }
    }

    return {
      values,
      invalid,
      type: mode === "auto" ? mostCommon(types) : mode
    };
  }

  function maxColumnCount(rows) {
    let max = 0;
    for (const row of rows) {
      if (row && row.length > max) max = row.length;
    }
    return max;
  }

  /**
   * Pull one identifier column out of a 2-D table.
   * Prefers a column explicitly named by its header (IMSI / MSISDN / ICCID),
   * then falls back to the best-matching column by value shape.
   *
   * @param {Array<Array<string|number>>} rows
   * @param {"auto"|"MSISDN"|"IMSI"|"ICCID"} mode
   */
  function extractIdentifiersFromTable(rows, mode) {
    const safeRows = Array.isArray(rows) ? rows : [];
    const header = detectHeaderRow(safeRows);
    const headerMap = header ? header.map : {};
    const dataStart = header ? header.rowIndex + 1 : 0;
    const targetMode = mode && mode !== "auto" ? mode : null;
    const tried = new Set();
    let emptyHeaderColumn = null;

    const candidates = [];
    if (targetMode) {
      if (headerMap[targetMode] !== undefined) candidates.push({ column: headerMap[targetMode], type: targetMode });
    } else {
      for (const type of COLUMN_TYPES) {
        if (headerMap[type] !== undefined) candidates.push({ column: headerMap[type], type });
      }
    }

    for (const candidate of candidates) {
      tried.add(candidate.column);
      const found = collectColumnValues(safeRows, candidate.column, dataStart, targetMode || candidate.type);
      if (found.values.length > 0) {
        return {
          values: found.values,
          type: targetMode || found.type,
          columnIndex: candidate.column,
          columnLetter: columnLetter(candidate.column),
          headerLabel: header ? cellToString((safeRows[header.rowIndex] || [])[candidate.column]) : "",
          headerFound: Boolean(header),
          headerMap,
          invalidCount: found.invalid,
          rows: safeRows
        };
      }
      if (!emptyHeaderColumn) {
        emptyHeaderColumn = {
          column: candidate.column,
          type: targetMode || candidate.type,
          invalid: found.invalid
        };
      }
    }

    // Fallback: score every column by how many valid identifiers it holds.
    let best = null;
    const columnCount = maxColumnCount(safeRows);
    for (let c = 0; c < columnCount; c++) {
      if (tried.has(c)) continue;
      const found = collectColumnValues(safeRows, c, dataStart, targetMode || "auto");
      if (found.values.length === 0) continue;
      if (!best || found.values.length > best.values.length) {
        best = {
          values: found.values,
          type: targetMode || found.type,
          columnIndex: c,
          columnLetter: columnLetter(c),
          headerLabel: header ? cellToString((safeRows[header.rowIndex] || [])[c]) : "",
          headerFound: Boolean(header),
          headerMap,
          invalidCount: found.invalid,
          rows: safeRows
        };
      }
    }
    if (best) return best;

    const available = describeHeaderMap(headerMap);
    let reason;
    if (emptyHeaderColumn) {
      reason =
        (emptyHeaderColumn.invalid > 0
          ? `The ${emptyHeaderColumn.type} column (${columnLetter(emptyHeaderColumn.column)}) has ` +
            `${emptyHeaderColumn.invalid} value(s), but none are valid ${emptyHeaderColumn.type} values.`
          : `The ${emptyHeaderColumn.type} column (${columnLetter(emptyHeaderColumn.column)}) is empty.`) +
        (available ? ` Columns found: ${available}.` : "");
    } else if (targetMode) {
      reason =
        `No valid ${targetMode} values were found.` +
        (available ? ` Columns found: ${available}.` : " Add an IMSI, MSISDN or ICCID column.");
    } else {
      reason = "No valid IMSI, MSISDN or ICCID values were found in this file.";
    }

    return {
      values: [],
      type: targetMode || "auto",
      columnIndex: -1,
      columnLetter: "",
      headerLabel: "",
      headerFound: Boolean(header),
      headerMap,
      invalidCount: 0,
      rows: safeRows,
      reason
    };
  }

  // ---------------------------------------------------------------------------
  // Delimited text (.csv / .tsv / .txt)
  // ---------------------------------------------------------------------------

  function splitDelimitedLine(line, delimiter) {
    if (!delimiter) return [line];
    const out = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        out.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out;
  }

  function detectDelimiter(sampleLine) {
    const candidates = ["\t", ";", ","];
    let best = null;
    let bestCount = 0;
    for (const delimiter of candidates) {
      const count = splitDelimitedLine(sampleLine, delimiter).length - 1;
      if (count > bestCount) {
        best = delimiter;
        bestCount = count;
      }
    }
    return best;
  }

  function parseDelimitedText(text) {
    const clean = String(text || "").replace(/^\uFEFF/, "");
    const lines = clean.split(/\r\n|\r|\n/);
    const sample = lines.find((line) => line.trim()) || "";
    const delimiter = detectDelimiter(sample);

    const rows = [];
    for (const line of lines) {
      if (!line.trim() && delimiter) {
        rows.push([]);
        continue;
      }
      rows.push(splitDelimitedLine(line, delimiter).map((cell) => cell.trim()));
    }
    return rows;
  }

  // ---------------------------------------------------------------------------
  // XLSX internals: ZIP directory, inflate, XML
  // ---------------------------------------------------------------------------

  function decodeUtf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function decodeXml(value) {
    return String(value)
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function attr(attrs, name) {
    if (!attrs) return "";
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = attrs.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : "";
  }

  function collectText(fragment) {
    let text = "";
    const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    for (const match of String(fragment).matchAll(re)) text += decodeXml(match[1]);
    return text;
  }

  function formatExcelNumber(raw) {
    let value = String(raw).trim();
    if (/^[+-]?\d+(?:\.\d+)?[Ee][+-]?\d+$/.test(value)) {
      const num = Number(value);
      if (Number.isFinite(num)) {
        value = Number.isInteger(num) ? BigInt(Math.round(num)).toString() : String(num);
      }
    }
    return value;
  }

  function findEndOfCentralDirectory(bytes) {
    const minOffset = Math.max(0, bytes.length - 66600);
    for (let i = bytes.length - 22; i >= minOffset; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        return i;
      }
    }
    return -1;
  }

  function readZipArchive(bytes) {
    const eocd = findEndOfCentralDirectory(bytes);
    if (eocd < 0) throw new Error("Not a valid .xlsx file (ZIP directory not found).");

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entryCount = view.getUint16(eocd + 10, true);
    let pointer = view.getUint32(eocd + 16, true);
    const entries = new Map();

    for (let i = 0; i < entryCount; i++) {
      if (pointer + 46 > bytes.length || view.getUint32(pointer, true) !== 0x02014b50) break;
      const method = view.getUint16(pointer + 10, true);
      const compressedSize = view.getUint32(pointer + 20, true);
      const uncompressedSize = view.getUint32(pointer + 24, true);
      const nameLength = view.getUint16(pointer + 28, true);
      const extraLength = view.getUint16(pointer + 30, true);
      const commentLength = view.getUint16(pointer + 32, true);
      const localOffset = view.getUint32(pointer + 42, true);
      const name = decodeUtf8(bytes.subarray(pointer + 46, pointer + 46 + nameLength));
      entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
      pointer += 46 + nameLength + extraLength + commentLength;
    }

    if (entries.size === 0) throw new Error("Not a valid .xlsx file (no ZIP entries found).");
    return entries;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("This browser cannot read .xlsx files. Please save the sheet as .csv and upload that.");
    }
    const stream = new DecompressionStream("deflate-raw");
    // Start draining the readable side before writing: awaiting write() first can
    // deadlock once the stream's internal queue fills up.
    const drained = new Response(stream.readable).arrayBuffer();
    const writer = stream.writable.getWriter();
    await writer.write(data);
    await writer.close();
    return new Uint8Array(await drained);
  }

  async function readZipEntry(bytes, entry) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offset = entry.localOffset;
    if (offset + 30 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error("Corrupted .xlsx file (bad ZIP entry header).");
    }
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const localCompressedSize = view.getUint32(offset + 18, true);
    const size = entry.compressedSize || localCompressedSize;
    if (!size) throw new Error("Corrupted .xlsx file (empty ZIP entry).");

    const dataStart = offset + 30 + nameLength + extraLength;
    const raw = bytes.subarray(dataStart, dataStart + size);

    if (entry.method === 0) return raw;
    if (entry.method === 8) return inflateRaw(raw);
    throw new Error(`Unsupported .xlsx compression method (${entry.method}).`);
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    const strings = [];
    const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    for (const match of xml.matchAll(re)) strings.push(collectText(match[1]));
    return strings;
  }

  function parseSheetRows(xml, sharedStrings) {
    const rows = [];
    let maxColumn = -1;
    const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;

    for (const rowMatch of xml.matchAll(rowRe)) {
      const rowAttr = attr(rowMatch[1], "r");
      const rowIndex = rowAttr ? parseInt(rowAttr, 10) - 1 : rows.length;
      if (!Number.isFinite(rowIndex) || rowIndex < 0 || rowIndex > 200000) continue;

      const cells = [];
      let autoColumn = 0;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

      for (const cellMatch of rowMatch[2].matchAll(cellRe)) {
        const attrs = cellMatch[1] || "";
        const body = cellMatch[2] || "";
        const refLetters = (attr(attrs, "r").match(/^[A-Z]+/i) || [""])[0];
        const column = refLetters ? columnIndexFromLetters(refLetters) : autoColumn;
        autoColumn = column + 1;
        const type = attr(attrs, "t");
        let value = "";

        if (type === "inlineStr") {
          value = collectText(body);
        } else {
          const vMatch = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
          if (vMatch) {
            const raw = decodeXml(vMatch[1]).trim();
            if (type === "s") {
              const index = parseInt(raw, 10);
              value = sharedStrings[index] !== undefined ? sharedStrings[index] : "";
            } else if (type === "b") {
              value = raw === "1" ? "TRUE" : "FALSE";
            } else if (type === "str" || type === "e") {
              value = raw;
            } else {
              value = formatExcelNumber(raw);
            }
          } else {
            value = collectText(body);
          }
        }

        value = String(value).trim();
        if (value !== "") {
          cells[column] = value;
          if (column > maxColumn) maxColumn = column;
        }
      }

      if (cells.length) rows[rowIndex] = cells;
    }

    for (let r = 0; r < rows.length; r++) {
      if (!rows[r]) rows[r] = [];
    }
    return rows;
  }

  async function listWorksheets(readText, entryNames) {
    const workbookXml = await readText("xl/workbook.xml");
    const relsXml = await readText("xl/_rels/workbook.xml.rels");
    const relTargets = new Map();

    if (relsXml) {
      const relRe = /<Relationship\b([^>]*)\/?>/g;
      for (const match of relsXml.matchAll(relRe)) {
        const attrs = match[1];
        const id = attr(attrs, "Id");
        const target = attr(attrs, "Target");
        if (!id || !target) continue;
        const normalized = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
        relTargets.set(id, normalized);
      }
    }

    const sheets = [];
    if (workbookXml) {
      const sheetRe = /<sheet\b([^>]*)\/?>/g;
      for (const match of workbookXml.matchAll(sheetRe)) {
        const attrs = match[1];
        const name = decodeXml(attr(attrs, "name")) || "Sheet";
        const rid = attr(attrs, "r:id") || attr(attrs, "id");
        const path = rid ? relTargets.get(rid) : "";
        if (path) sheets.push({ name, path });
      }
    }

    if (sheets.length === 0) {
      // Fallback for workbooks without usable relationship data.
      const candidates = (entryNames || [])
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
        .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));
      candidates.forEach((path, index) => sheets.push({ name: `Sheet${index + 1}`, path }));
    }

    return sheets;
  }

  /**
   * Parse an .xlsx / .xlsm workbook and return the best identifier column.
   * @param {ArrayBuffer|Uint8Array} input
   * @param {"auto"|"MSISDN"|"IMSI"|"ICCID"} mode
   */
  async function parseWorkbook(input, mode = "auto") {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const archive = readZipArchive(bytes);

    const textCache = new Map();
    const readText = async (name) => {
      if (textCache.has(name)) return textCache.get(name);
      const entry = archive.get(name);
      const value = entry ? decodeUtf8(await readZipEntry(bytes, entry)) : null;
      textCache.set(name, value);
      return value;
    };

    const sharedStrings = parseSharedStrings(await readText("xl/sharedStrings.xml"));
    const worksheets = await listWorksheets(readText, Array.from(archive.keys()));
    if (worksheets.length === 0) throw new Error("No worksheets found in this workbook.");

    const parsed = [];
    for (const sheet of worksheets) {
      const xml = await readText(sheet.path);
      if (!xml) continue;
      const rows = parseSheetRows(xml, sharedStrings);
      if (rows.length === 0) continue;
      const extracted = extractIdentifiersFromTable(rows, mode);
      const score = (extracted.headerFound ? 1000000 : 0) + extracted.values.length;
      parsed.push({ sheet, rows, extracted, score });
    }

    if (parsed.length === 0) throw new Error("This workbook has no readable rows.");

    parsed.sort((a, b) => b.score - a.score);
    const best = parsed[0];
    const extracted = best.extracted;

    return {
      sheetName: best.sheet.name,
      sheetNames: parsed.map((p) => p.sheet.name),
      values: extracted.values,
      type: extracted.type,
      columnIndex: extracted.columnIndex,
      columnLetter: extracted.columnLetter,
      headerLabel: extracted.headerLabel,
      headerFound: extracted.headerFound,
      headerMap: extracted.headerMap,
      invalidCount: extracted.invalidCount,
      rows: best.rows,
      reason: extracted.reason || ""
    };
  }

  global.AmtelParser = {
    digits,
    normalizeMsisdn,
    normalizeIccid,
    normalizeImsi,
    extractIdentifierFromLine,
    detectType,
    parseInputItem,
    getParsedQueue,
    parseDelimitedText,
    extractIdentifiersFromTable,
    parseWorkbook,
    columnLetter
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
