/* Browser Agent tab: Jev Ultrafast card, connect dialog, and run history. */

(function () {
  const byId = (id) => document.getElementById(id);

  const STATUS_TONE = {
    connected: "ok",
    not_connected: "",
    error: "error",
  };

  const STATUS_TEXT = {
    connected: "Connected",
    not_connected: "Not connected",
    error: "Error",
  };

  let connected = false;
  let consentGiven = false;

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || `${response.status} ${response.statusText}`);
    }
    return payload;
  }

  function text(id, value) {
    const node = byId(id);
    if (node) node.textContent = value;
  }

  function showMessage(id, message, isError) {
    const node = byId(id);
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
    node.classList.toggle("error", Boolean(isError));
  }

  function renderStatus(status) {
    const pill = byId("jevStatusPill");
    if (pill) {
      pill.textContent = STATUS_TEXT[status.state] || status.state;
      pill.classList.toggle("ok", STATUS_TONE[status.state] === "ok");
      pill.classList.toggle("error", STATUS_TONE[status.state] === "error");
    }
    showMessage("jevStatusMessage", status.detail || "", status.state === "error");

    const chrome = status.chrome || {};
    text(
      "jevChromeStatus",
      chrome.available ? "Available" : chrome.detail || "Unavailable",
    );
    text("jevTextModel", status.text_model || "-");
    const domains = status.allowed_domains || [];
    text("jevAllowedDomains", domains.length ? domains.join(", ") : "None (approval required)");

    connected = status.state === "connected";
    const connect = byId("jevConnect");
    const disconnect = byId("jevDisconnect");
    if (connect) {
      connect.textContent = connected ? "Manage" : "Connect";
      connect.hidden = false;
    }
    if (disconnect) disconnect.hidden = !connected;
    if (byId("jevStop")) byId("jevStop").hidden = !connected;
  }

  async function refreshStatus() {
    try {
      renderStatus(await api("/admin/api/browser/jev/status"));
    } catch (error) {
      showMessage("jevStatusMessage", error.message, true);
    }
  }

  function renderRuns(runs) {
    const body = byId("jevRunsBody");
    const empty = byId("jevRunsEmpty");
    if (!body) return;
    body.replaceChildren();
    if (!runs.length) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    runs.forEach((run) => {
      const row = document.createElement("tr");
      [
        run.status || "",
        run.goal || "",
        run.start_url || "",
        String(run.steps ?? ""),
        `${run.elapsed_ms ?? 0} ms`,
      ].forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.appendChild(cell);
      });
      body.appendChild(row);
    });
  }

  async function refreshRuns() {
    try {
      const payload = await api("/admin/api/browser/jev/runs");
      renderRuns(payload.runs || []);
    } catch (error) {
      showMessage("jevRunsEmpty", error.message, true);
    }
  }

  /* ------------------------------------------------------------------ dialog */

  function changePreview() {
    const domains = byId("jevDomains") ? byId("jevDomains").value.trim() : "";
    const items = [
      "Install the jev-ultrafast package if it is missing",
      "Set TYPESAFE_API_KEY in the managed environment",
      "Set TEXT_MODEL_API_KEY in the managed environment",
      `Set JEV_ALLOWED_DOMAINS to "${domains || "(empty)"}"`,
      "Set JEV_ENABLED=true, which offers browse_web to models",
    ];
    const list = byId("jevChangeList");
    if (!list) return;
    list.replaceChildren();
    items.forEach((text_) => {
      const item = document.createElement("li");
      item.textContent = text_;
      list.appendChild(item);
    });
  }

  function buildField(id, label, type, placeholder) {
    const wrapper = document.createElement("label");
    wrapper.className = "field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.id = id;
    input.type = type;
    if (placeholder) input.placeholder = placeholder;
    if (type === "password") input.autocomplete = "off";
    wrapper.append(caption, input);
    return wrapper;
  }

  function openDialog() {
    const fields = byId("jevFields");
    if (fields) {
      fields.replaceChildren(
        buildField("jevTypeSafeKey", "TypeSafe API key", "password", "Required"),
        buildField("jevTextKey", "Text model API key (optional)", "password", ""),
        buildField("jevDomains", "Allowed domains", "text", "example.com, localhost"),
      );
    }
    consentGiven = false;
    const consent = byId("jevConsent");
    if (consent) consent.checked = false;
    changePreview();
    showMessage("jevMessage", "", false);
    syncConnectButton();
    const dialog = byId("jevDialog");
    if (dialog && typeof dialog.showModal === "function") dialog.showModal();
  }

  function syncConnectButton() {
    const button = byId("confirmJevConnect");
    const key = byId("jevTypeSafeKey");
    if (!button) return;
    // SEC-2: explicit acknowledgement is required before anything is written.
    button.disabled = !(consentGiven && key && key.value.trim());
  }

  async function submitConnect() {
    const button = byId("confirmJevConnect");
    if (button) {
      button.disabled = true;
      button.textContent = "Connecting…";
    }
    showMessage("jevMessage", "", false);
    try {
      const result = await api("/admin/api/browser/jev/connect", {
        method: "POST",
        body: JSON.stringify({
          typesafe_api_key: byId("jevTypeSafeKey").value,
          text_model_api_key: byId("jevTextKey") ? byId("jevTextKey").value : "",
          allowed_domains: byId("jevDomains") ? byId("jevDomains").value : "",
          confirm_data_processing: true,
        }),
      });
      if (!result.ok) {
        showMessage("jevMessage", result.error || "Connect failed.", true);
        return;
      }
      const dialog = byId("jevDialog");
      if (dialog) dialog.close();
      await refreshStatus();
      await refreshRuns();
    } catch (error) {
      showMessage("jevMessage", error.message, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Connect";
      }
      syncConnectButton();
    }
  }

  async function disconnect() {
    showMessage("jevStatusMessage", "", false);
    try {
      await api("/admin/api/browser/jev/disconnect", { method: "POST" });
    } catch (error) {
      showMessage("jevStatusMessage", error.message, true);
    }
    await refreshStatus();
  }

  async function stop() {
    try {
      await api("/admin/api/browser/jev/stop", { method: "POST" });
    } catch (error) {
      showMessage("jevStatusMessage", error.message, true);
    }
  }

  function activate() {
    void refreshStatus();
    void refreshRuns();
  }

  function bind() {
    const connect = byId("jevConnect");
    if (connect) connect.addEventListener("click", openDialog);
    const disconnect = byId("jevDisconnect");
    if (disconnect) disconnect.addEventListener("click", disconnect);
    const stopButton = byId("jevStop");
    if (stopButton) stopButton.addEventListener("click", stop);
    const refresh = byId("jevRefreshRuns");
    if (refresh) refresh.addEventListener("click", () => void refreshRuns());
    const close = byId("closeJevDialog");
    if (close) close.addEventListener("click", () => byId("jevDialog").close());
    const cancel = byId("cancelJevDialog");
    if (cancel) cancel.addEventListener("click", () => byId("jevDialog").close());
    const consent = byId("jevConsent");
    if (consent) {
      consent.addEventListener("change", () => {
        consentGiven = consent.checked;
        syncConnectButton();
      });
    }
    const confirm = byId("confirmJevConnect");
    if (confirm) confirm.addEventListener("click", submitConnect);
    document.addEventListener("input", (event) => {
      if (event.target && event.target.id === "jevTypeSafeKey") syncConnectButton();
      if (event.target && event.target.id === "jevDomains") changePreview();
    });
  }

  window.BrowserAgent = { activate };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();