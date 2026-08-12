(() => {
  if (window.__AMTEL_BATCH_V1__) return;
  window.__AMTEL_BATCH_V1__ = true;

  const APP = "[Amtel Batch Activator]";

  // --- Visual On-Screen Status Overlay ---
  function showRunStatus(message, type = "running") {
    let panel = document.getElementById("amtel-batch-status-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "amtel-batch-status-panel";
      Object.assign(panel.style, {
        position: "fixed",
        right: "18px",
        bottom: "18px",
        zIndex: "2147483647",
        width: "320px",
        padding: "12px 14px",
        borderRadius: "10px",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: "13px",
        fontWeight: "600",
        lineHeight: "1.4",
        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        color: "#ffffff",
        transition: "all 0.2s ease"
      });
      document.documentElement.appendChild(panel);
    }
    panel.style.background = type === "error" ? "#dc2626" : type === "success" ? "#16a34a" : "#2563eb";
    panel.textContent = `Batch Activator — ${message}`;
    if (type !== "running") {
      setTimeout(() => panel?.remove(), 8000);
    }
  }

  // --- Utility Functions ---
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const digits = (value) => String(value || "").replace(/\D/g, "");
  const text = (node) => (node?.innerText || node?.textContent || "").trim();
  const visible = (node) => !!node && !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  const fire = (node, events = ["input", "change", "blur"]) => events.forEach((name) => node.dispatchEvent(new Event(name, { bubbles: true })));

  function setControl(node, value) {
    if (!node) throw new Error("Target input control was not found.");
    const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(node, value); else node.value = value;
    fire(node);
  }

  function selectByText(select, label) {
    const wanted = label.toLowerCase();
    const option = [...select.options].find((item) => text(item).toLowerCase() === wanted);
    if (!option) throw new Error(`Dropdown option "${label}" was not found.`);
    setControl(select, option.value);
  }

  async function waitFor(getter, { timeout = 8000, description = "CRM element" } = {}) {
    const first = getter();
    if (first) return first;
    return await new Promise((resolve, reject) => {
      const started = Date.now();
      const observer = new MutationObserver(check);
      const timer = setInterval(check, 150);
      function finish(value, error) {
        observer.disconnect();
        clearInterval(timer);
        error ? reject(error) : resolve(value);
      }
      function check() {
        let value = null;
        try { value = getter(); } catch {}
        if (value) return finish(value);
        if (Date.now() - started > timeout) finish(null, new Error(`${description} timed out.`));
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function buttonByText(label, root = document) {
    const wanted = label.trim().toLowerCase();
    return [...root.querySelectorAll("button, a.btn")].find((btn) => visible(btn) && text(btn).trim().toLowerCase() === wanted);
  }

  function modalContaining(pattern) {
    return [...document.querySelectorAll(".modal-content")].find((modal) => visible(modal) && pattern.test(text(modal)));
  }

  async function closeVisibleModal() {
    const modal = [...document.querySelectorAll(".modal-content")].find(visible);
    if (!modal) return;
    const closeBtn = buttonByText("Close", modal) || modal.querySelector("button.close, .close");
    if (closeBtn) closeBtn.click();
    await sleep(250);
  }

  async function goHome() {
    if (location.hash !== "#/home") {
      location.hash = "#/home";
      await waitFor(() => location.hash === "#/home" ? true : null, { timeout: 4000, description: "Home route" });
      await sleep(150);
    }
  }

  // --- Core Single Card Processing Logic ---
  async function processCard(item) {
    showRunStatus(`Searching ${item.type}: ${item.value}...`);

    try {
      await goHome();

      const idTypeSelect = await waitFor(() => document.querySelector("#idtype"), { description: "Search ID Type dropdown" });
      const numberInput = await waitFor(() => document.querySelector("#number"), { description: "Search Number input" });

      selectByText(idTypeSelect, item.type);
      setControl(numberInput, item.value);

      const form = numberInput.closest("form");
      const searchBtn = buttonByText("search", form || document) || [...document.querySelectorAll("button.btn-info")].find((b) => /search/i.test(text(b)));
      if (!searchBtn) throw new Error("Search button not found on page.");

      searchBtn.click();

      // Wait for either search result page OR subscriber not found modal
      const outcome = await waitFor(() => {
        const notFoundModal = modalContaining(/Subscriber not found|no (record|data)|not exist/i);
        if (notFoundModal) return { found: false, modal: notFoundModal };

        const bodyText = text(document.body);
        const hasSummary = bodyText.includes("Summary for:") || bodyText.includes("Customer Details");
        const hasValue = bodyText.includes(item.value);
        if (hasSummary && hasValue) return { found: true };

        return null;
      }, { timeout: 9000, description: `Search result for ${item.value}` });

      if (!outcome.found) {
        await closeVisibleModal();
        showRunStatus(`Card ${item.value} not found in CRM. Skipping...`, "error");
        return { ok: true, status: "NOT_FOUND", reason: "Subscriber record not found in CRM" };
      }

      // Card was found! Inspect page for Activation control
      await sleep(400);

      const activateIcon = [...document.querySelectorAll("span.material-icons")].find(
        (n) => visible(n) && text(n) === "check_circle" && /activate subscriber/i.test(n.title || "")
      );
      const activateControl = activateIcon?.closest("button,a") || activateIcon || buttonByText("Activate Subscriber", document);

      if (activateControl) {
        showRunStatus(`Found idle card ${item.value}. Clicking Activate...`);
        activateControl.click();

        const activationModal = await waitFor(
          () => modalContaining(/success|activated|completed|failed/i),
          { timeout: 10000, description: "Activation result modal" }
        );

        const modalMsg = text(activationModal);
        await closeVisibleModal();

        if (/success|activated|completed/i.test(modalMsg)) {
          showRunStatus(`Card ${item.value} activated successfully!`, "success");
          return { ok: true, status: "ACTIVATED", message: "Activated successfully" };
        } else {
          showRunStatus(`Activation returned: ${modalMsg.slice(0, 50)}`, "error");
          return { ok: true, status: "SKIPPED", reason: `Activation message: ${modalMsg.slice(0, 100)}` };
        }
      } else {
        // Activation control not present -> card is already active
        showRunStatus(`Card ${item.value} is already active. Skipping...`, "success");
        return { ok: true, status: "ALREADY_ACTIVE", message: "Subscriber is already active" };
      }

    } catch (err) {
      await closeVisibleModal();
      showRunStatus(`Skipped ${item.value}: ${err.message}`, "error");
      return { ok: true, status: "SKIPPED", reason: err.message };
    }
  }

  // --- Chrome Extension Message Listener ---
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.source !== "amtel-batch-v1") return;

    if (request.action === "inspect") {
      sendResponse({ ok: true, message: "Amtel Batch Activator script ready." });
      return true;
    }

    if (request.action === "processCard") {
      processCard(request.item)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, status: "SKIPPED", reason: err.message }));
      return true; // Keep message channel open for async response
    }
  });

  console.info(APP, "Ready on", location.href);
})();
