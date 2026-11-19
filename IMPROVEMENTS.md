# Amtel Batch Activator — Improvement Plan & Architecture Guide

A comprehensive architectural, performance, and user-experience improvement plan for the **Amtel Batch Subscriber Activator** Chrome Extension (Manifest V3).

---

## 1. Executive Summary

The Amtel Batch Activator automates subscriber lookup and card activation on Amtel CRM (`https://www.crmamtel.com/`). While the core search and activation flows function, several critical architectural constraints and operational bottlenecks exist:

- **Popup Lifecycle Abortions**: When an operator clicks outside the popup window, Chrome destroys the execution context, terminating active batches.
- **Tab Focus Sensitivity**: Tab messaging targets `activeTab()`, causing disconnections whenever the operator switches tabs during execution.
- **DOM Layout Thrashing**: Running `goHome()` navigation and querying `document.body.innerText` on every queue item degrades throughput and causes UI lockups.
- **Missing Operator Controls**: Lack of pause/resume, deduplication, retry-on-failure, and multi-column Excel/CSV paste support.

This document details concrete technical specifications and roadmap items to upgrade the extension to production-grade reliability.

---

## 2. Priority 0: Critical Architecture & Extension Lifecycle

### 2.1 Migrate Batch Execution to a Background Service Worker or Chrome Side Panel
* **Current Issue**: The `while` batch loop runs inside `popup.js`. When the user clicks away or switches windows, Chrome unloads the popup DOM and kills the loop.
* **Solution**:
  1. **Option A (Recommended — Side Panel API)**:
     - Manifest V3 native side panel (`"permissions": ["sidePanel"]`, `"side_panel": { "default_path": "popup.html" }`).
     - Stays open alongside the CRM page indefinitely without closing on outside clicks.
  2. **Option B (Background Service Worker)**:
     - Move the queue processor to `background.js`.
     - `popup.js` sends `START_BATCH`, `PAUSE_BATCH`, `STOP_BATCH` messages to the service worker.
     - Progress is synced to `chrome.storage.session` or broadcast via `chrome.runtime.sendMessage`.

### 2.2 Pin Target CRM Tab ID
* **Current Issue**: `activeTab()` in `popup.js` queries `currentWindow: true, active: true`. If an operator opens another tab to check emails while a 200-card batch is running, the extension tries to send messages to the email tab, throwing: `"Cannot connect to https://www.crmamtel.com/"`.
* **Solution**:
  - When the batch begins, store `targetTabId = tab.id`.
  - All subsequent `chrome.tabs.sendMessage(targetTabId, ...)` calls must use this specific ID.
  - Implement an auto-reconnect fallback that queries `{ url: "https://www.crmamtel.com/*" }` if the tab reference becomes detached.

---

## 3. Priority 1: CRM DOM Automation & Performance

### 3.1 Eliminate Redundant `goHome()` Navigation
* **Current Issue**: `processCard` calls `await goHome()` (`location.hash = "#/home"` and awaits up to 4000ms) on **every card**.
* **Impact**: Introduces 1–3 seconds of DOM thrashing, re-renders, and network overhead per subscriber.
* **Solution**:
  - Check if `#idtype` and `#number` are already present and visible in the DOM.
  - Only invoke `goHome()` if the search controls are absent or detached.

### 3.2 Eliminate Full-Body Text Layout Reflows
* **Current Issue**: `content.js` calls `text(document.body)` every 150ms in `waitFor()`.
* **Impact**: Calling `innerText` on `document.body` forces the browser to recalculate layout/styles across the entire page repeatedly.
* **Solution**:
  - Target specific containers: `document.querySelector(".search-results, .customer-details, #subscriberSummary, .modal-content")`.
  - Check targeted elements rather than parsing the entire page text.

### 3.3 Guard Against Stale Search Results & Race Conditions
* **Current Issue**: When transitioning from card 1 to card 2, if the page still contains `"Summary for:"` from card 1, the mutation observer may prematurely mark card 2 as found before the CRM backend finishes querying.
* **Solution**:
  - Listen for the CRM's loading spinner/indicator (e.g. `.loading, .spinner, [role="progressbar"]`, or search button disabled state).
  - Ensure results explicitly match the active item's identifier before resolving `{ found: true }`.

### 3.4 Handle Intermediate Confirmation Dialogs
* **Current Issue**: Clicking `check_circle` (Activate) directly assumes the next modal is a success/fail message. Some CRM workflows show a confirmation dialog: *"Are you sure you want to activate this subscriber?"*
* **Solution**:
  - Detect and automatically confirm confirmation prompts:
    ```javascript
    const confirmBtn = buttonByText("Confirm") || buttonByText("Yes") || buttonByText("Activate");
    if (confirmBtn) confirmBtn.click();
    ```

---

## 4. Priority 2: Operator Experience & Workflow Controls

### 4.1 Pause & Resume Controls
* **Feature**: Replace the destructive "Stop Batch" with:
  - **Pause**: Halts after the currently active item finishes, keeping the remaining queue intact.
  - **Resume**: Continues execution from `state.currentIndex`.
  - Saves the queue and active index into `chrome.storage.local`.

### 4.2 Configurable Speed & Rate Limiting
* **Feature**: Add an execution speed selector to prevent triggering CRM DDoS / rate-limiting flags or session timeouts:
  - **Fast**: 300ms delay between items.
  - **Normal (Default)**: 800ms delay.
  - **Safe / Conservative**: 1500ms delay (recommended for unstable connections).

### 4.3 "Retry Failed / Skipped" Action
* **Feature**: In the summary report section, add a one-click **"Retry Failed Items"** button.
* **Behavior**: Extracts all records with status `NOT_FOUND`, `SKIPPED`, or `ERROR` and reloads them into the input queue for a second execution attempt.

### 4.4 Fix UI Mode Selector Synchronization
* **Current Issue**: In `popup.css`, `.segmented-control` is set to `display: none;`, but `popup.js` still binds events to `.mode-pill`. The dropdown `#searchTypeSelect` contains IMSI, Account ID, and Profile ID, but the pills only support 3 modes.
* **Solution**:
  - Expand the segmented pill selector or modernize the dropdown so all 5 ID types (MSISDN, IMSI, ICCID, Account ID, Profile ID) are readily accessible and clearly labeled.

---

## 5. Priority 3: Input Parsing & Data Hygiene

### 5.1 Smart Multi-Column & Excel Paste Handling
* **Feature**: Telecom operators often copy directly from spreadsheet tables (Excel / Google Sheets) containing multiple columns (e.g., `MSISDN\tCustomer Name\tStatus\tIMSI`).
* **Solution**:
  - Automatically detect tab delimiters (`\t`).
  - If multi-column data is detected, prompt the operator to choose which column to extract or auto-select the column matching numeric MSISDN/ICCID/IMSI patterns.

### 5.2 Deduplication Toggle
* **Feature**: Add a checkbox: *"Deduplicate identifiers before queueing"*.
* **Behavior**: Removes redundant entries from the batch queue and shows the deduplicated count in the item badge.

### 5.3 Live Input Validation Counter
* **Feature**: Display breakdown in the input header badge:
  - `Total lines: X | Valid: Y | Syntax Warnings: Z`

---

## 6. Priority 4: Audit, Reporting & Observability

### 6.1 Enriched CSV Audit Log
Extend `downloadCsvReport()` to include:
- `Index`
- `Identifier`
- `ID_Type`
- `Status` (`ACTIVATED`, `ALREADY_ACTIVE`, `NOT_FOUND`, `SKIPPED`, `ERROR`)
- `Message / Reason`
- `Processed_At` (ISO Timestamp)
- `Execution_Duration_ms`

### 6.2 JSON Export Option
* Add a `Download JSON` button for operators to upload audit logs directly to internal ticketing or ERP systems.

### 6.3 Completion Desktop & Audio Notification
* For large batches (100–500 items), operators switch to other work.
* Trigger a native browser notification (`chrome.notifications.create`) and an optional subtle sound effect when the queue reaches 100%.

---

## 7. Implementation Roadmap & Milestones

| Phase | Milestone | Primary Files Changed | Estimated Effort |
| :--- | :--- | :--- | :--- |
| **Phase 1** | **Lifecycle & Tab Locking**<br>- Add `side_panel` / background messaging<br>- Pin CRM `tabId` to prevent disconnections | `manifest.json`<br>`popup.js`<br>`popup.html` | 1–2 days |
| **Phase 2** | **DOM Performance & Safety**<br>- Eliminate redundant `goHome()` calls<br>- Scope mutation observers to result cards<br>- Add activation confirmation handler | `content.js` | 1 day |
| **Phase 3** | **Operator Controls**<br>- Add Pause / Resume functionality<br>- Add Speed throttle slider (Fast / Safe)<br>- Add "Retry Failed Items" button | `popup.html`<br>`popup.js`<br>`popup.css` | 1–2 days |
| **Phase 4** | **Data Ingestion & Reporting**<br>- Excel TSV column extractor<br>- Deduplication toggle<br>- Enriched CSV with timestamps & duration<br>- Completion sound/notification | `popup.js`<br>`popup.html` | 1 day |
