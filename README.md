# Amtel Batch Activator Extension

A tiny Chrome extension that lets you batch‑activate numbers.

## Quick start (load in Chrome for development)
1. Open Chrome and go to `chrome://extensions/`.
2. Turn **Developer mode** on (top‑right toggle).
3. Click **Load unpacked**.
4. Select the folder containing this project:
   ```
   C:\Users\HCF\Downloads\amtel-batch-activator
   ```
5. The extension appears in the toolbar. Click the icon to open the popup.

## What the extension does
- Paste MSISDN, IMSI or ICCID numbers (or drop a spreadsheet file).
- Choose a mode (Auto, MSISDN, IMSI, ICCID).
- Click **Start** to begin the batch process.
- Progress, results and a CSV export are shown.
- Each result row shows the subscriber's **Last Top-up Amount** immediately before
  the status badge (`ACTIVE`, `ACTIVATED`, …), as either the amount (`$5.00`) or
  `N/A` when the CRM reports none.
- CSV, JSON and copied reports include the same value; in the CSV the `Last_Topup`
  column sits directly before `Status`.

## Supported input files
- `.xlsx` / `.xlsm` — real CRM exports such as `Batch_create_subscriber_sample_file.xlsx`,
  which has an `IMSI`, `MSISDN`, `ICCID` and `Primary ffering` column.
- `.csv`, `.tsv`, `.txt` — same header rules, comma / semicolon / tab separated.

How a workbook is read:
1. The first sheet that has a recognisable header row wins (the header row may sit
   below a title row). Header names are matched case‑insensitively, so `IMSI`,
   `MSISDN`, `MSISDN Number`, `Mobile`, `Phone`, `ICCID`, `SIM Number`, etc. all work.
2. The column that matches the selected mode is loaded — e.g. in `MSISDN` mode the
   worksheet's `MSISDN` column is used, not just column A.
3. `Auto` mode picks the first recognised identifier column and switches the mode
   pill to that type (IMSI in the sample file).
4. After a file is loaded, clicking another mode pill re‑reads the same file and
   loads that type's column without re‑uploading.
5. A status line under the input box shows the count, sheet and column used, or a
   clear reason (e.g. "the ICCID column is empty").
6. Rows that are blank, headers, or the wrong format are skipped; duplicates are
   handled by the **Dedupe** checkbox.

Editing the textarea manually detaches it from the uploaded file, so your edits are
never overwritten.

## Customisation
- Edit `popup.html`, `popup.css` and `popup.js` to change UI or behaviour.
- `parser.js` contains all spreadsheet/CSV parsing and identifier normalisation.
- The **Contact info** line at the top shows a support phone number.

## Building / publishing
When you are ready to ship, zip the folder and upload it in Chrome Web Store Developer Dashboard.
Include `parser.js` alongside the other four files.

---
*Created by Amtel Qardho – support: 071‑710‑2026 / 071‑640‑8296*
