# Amtel Batch Subscriber Activator (Chrome Extension)

A lightweight, high-performance Manifest V3 Chrome extension designed strictly for bulk searching and activating existing idle subscriber cards in the Amtel CRM portal.

## Features

- **Bulk Input Support**: Paste multiple MSISDNs (`71xxxxxxx` or 7-digit suffixes) or ICCIDs (`89252...` or 7–8 digit suffixes).
- **Auto Detection**: Automatically detects whether an entry is an MSISDN or ICCID, with manual search mode overrides available.
- **Fail-Safe Worker Loop**: Searches each card in sequence. If a card is not found or has an issue, it is logged and skipped automatically so the batch process never crashes.
- **Smart Activation Check**:
  - If a subscriber is **Idle** / **Unactivated**: clicks the activation control (`check_circle`) and waits for confirmation.
  - If a subscriber is **Already Active**: logs as `ALREADY_ACTIVE` and moves to the next card.
  - If a card is **Not Found**: logs as `NOT_FOUND` and skips to the next card.
- **Real-Time Progress**:
  - Live progress bar showing exact percentage (`Processed X / Y`).
  - Real-time status panel overlay on the CRM page.
- **Detailed Summary Report**:
  - Summary metrics dashboard (Total, Activated, Already Active, Skipped).
  - Filterable detailed list of all processed items.
  - **Copy Report** to clipboard or **Download CSV** export.

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode** in the top right.
3. Click **Load unpacked**.
4. Select the directory: `C:\Users\dhom\Documents\crm tools\amtel-batch-activator`.
5. Open your Amtel CRM session (`https://www.crmamtel.com/`).
