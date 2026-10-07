/**
 * Admin Usage View
 * Shows token usage, costs, optimization savings, and provider health.
 *
 * The view subscribes to the runtime's committed-usage feed while it is open, so
 * new requests appear without a reload. It refreshes only what the user is
 * looking at, never resets their filters or pagination, and falls back to
 * polling if the feed drops.
 */

(function () {
  "use strict";

  const API_BASE = "/admin/api";
  const LIVE_DEBOUNCE_MS = 250;
  const HEALTH_POLL_MS = 10000;
  const RECONCILE_POLL_MS = 60000;
  const RECONNECT_MS = 1000;
  const REQUESTS_PAGE_SIZE = 50;

  let usageChart = null;
  let currentRequestsPage = 0;
  let activePanel = "overview";
  let active = false;
  let connected = false;
  let lastUpdatedMs = 0;
  let generation = 0;
  let source = null;
  let retryTimer = null;
  let debounceTimer = null;
  let healthTimer = null;
  let reconcileTimer = null;
  let clockTimer = null;

  const OUTCOMES = [
    "success",
    "fallback_success",
    "failure",
    "timeout",
    "cancelled",
    "rate_limited",
    "context_window_exceeded",
    "auth_error",
    "invalid_request",
    "upstream_error",
    "unknown",
  ];

  async function fetchJSON(url) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  function formatNumber(n) {
    if (n === null || n === undefined) return "—";
    return new Intl.NumberFormat().format(n);
  }

  function formatCost(n) {
    if (n === null || n === undefined) return "—";
    if (n === 0) return "$0.00";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4 }).format(n);
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return "—";
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  function formatTimeAgo(ms) {
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ms).toLocaleString();
  }

  function outcomeBadge(outcome) {
    const colors = {
      success: "badge-success",
      fallback_success: "badge-warning",
      failure: "badge-error",
      timeout: "badge-error",
      cancelled: "badge-gray",
      rate_limited: "badge-warning",
      context_window_exceeded: "badge-error",
      auth_error: "badge-error",
      invalid_request: "badge-error",
      upstream_error: "badge-error",
      unknown: "badge-gray",
    };
    const label = outcome.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    return `<span class="badge ${colors[outcome] || "badge-gray"}">${label}</span>`;
  }

  // ---------------------------------------------------------------- lifecycle

  function activate() {
    if (active) return;
    active = true;
    ++generation;
    connected = false;
    renderLiveState();
    void refreshAll();
    connectFeed();
    startPolling();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    // Invalidate in-flight reads so a late response cannot repaint a hidden view.
    ++generation;
    closeFeed();
    stopPolling();
    clearDebounce();
    if (clockTimer !== null) {
      window.clearInterval(clockTimer);
      clockTimer = null;
    }
    connected = false;
    renderLiveState();
  }

  function startPolling() {
    stopPolling();
    // Provider health has no usage trigger, so it needs its own cadence.
    healthTimer = window.setInterval(() => {
      if (!document.hidden) void loadProvidersHealth();
    }, HEALTH_POLL_MS);
    // Safety net in case a committed event is ever missed.
    reconcileTimer = window.setInterval(() => {
      if (!document.hidden) void refreshAll();
    }, RECONCILE_POLL_MS);
    if (clockTimer === null) {
      clockTimer = window.setInterval(renderLiveState, 1000);
    }
  }

  function stopPolling() {
    if (healthTimer !== null) {
      window.clearInterval(healthTimer);
      healthTimer = null;
    }
    if (reconcileTimer !== null) {
      window.clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  }

  function closeFeed() {
    if (source) source.close();
    source = null;
    connected = false;
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function clearDebounce() {
    if (debounceTimer !== null) {
      window.clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // --------------------------------------------------------------------- feed

  function connectFeed() {
    if (!active || source || retryTimer !== null) return;
    if (typeof EventSource !== "function") return;
    const feed = new EventSource(`${API_BASE}/usage/events`);
    source = feed;
    feed.addEventListener("feed.ready", () => {
      if (source === feed) void refreshAll();
    });
    feed.addEventListener("usage.updated", () => {
      if (source === feed) scheduleRefresh();
    });
    const dropped = () => {
      if (source !== feed) return;
      connected = false;
      renderLiveState();
      closeFeed();
      // A stopped runtime cannot serve the feed; the reconcile poll still reads
      // the API, so the tab keeps working while the retry waits.
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        connectFeed();
      }, RECONNECT_MS);
    };
    feed.addEventListener("feed.resync_required", dropped);
    feed.onerror = dropped;
    feed.onopen = () => {
      if (source !== feed) return;
      connected = true;
      renderLiveState();
    };
  }

  function scheduleRefresh() {
    // Commits arrive in batches; one refetch per burst keeps the tables stable.
    clearDebounce();
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void refreshAll();
    }, LIVE_DEBOUNCE_MS);
  }

  // ------------------------------------------------------------------ loading

  async function refreshAll() {
    if (!active) return;
    const token = generation;
    const results = await Promise.allSettled([
      loadSummary(token),
      loadRequests(currentRequestsPage, token),
      loadProvidersHealth(),
    ]);
    if (token !== generation) return;
    if (results.some((result) => result.status === "rejected")) return;
    lastUpdatedMs = Date.now();
    renderLiveState();
  }

  function rangeHours() {
    return parseInt(document.getElementById("usageSinceHours").value, 10) || 24;
  }

  async function loadSummary(token = generation) {
    const data = await fetchJSON(`${API_BASE}/usage/summary?since_hours=${rangeHours()}`);
    // A late response must never overwrite a newer render.
    if (token !== generation) return;
    renderSummary(data);
    renderProvidersTable(data.by_provider || []);
    renderAgentsTable(data.by_agent || []);
    renderOptimizationsTable(data.by_optimization || []);
    renderTimeseriesChart(data.timeseries || []);
    syncFilterOptions();
    lastUpdatedMs = Date.now();
    renderLiveState();
  }

  function renderSummary(data) {
    const totals = data.totals || {};
    setStat("totalRequests", formatNumber(totals.total_requests));
    setStat("totalInputTokens", formatNumber(totals.total_input));
    setStat("totalOutputTokens", formatNumber(totals.total_output));
    setStat("totalTokens", formatNumber((totals.total_input || 0) + (totals.total_output || 0)));
    setStat("totalCost", formatCost(totals.total_cost));
    setStat("providersUsed", formatNumber(totals.providers_used));
    setStat("agentsUsed", formatNumber(totals.agents_used));
  }

  function setStat(id, value) {
    const element = document.getElementById(id);
    if (!element) return;
    // Flash only when the number actually moved, so an eye can catch it.
    if (element.textContent === value) return;
    element.textContent = value;
    element.classList.remove("is-updated");
    void element.offsetWidth;
    element.classList.add("is-updated");
  }

  function renderProvidersTable(providers) {
    const tbody = document.getElementById("providersTableBody");
    tbody.innerHTML = providers.map(p => `
      <tr>
        <td>${escapeHtml(p.provider_id)}</td>
        <td>${escapeHtml(p.provider_model)}</td>
        <td class="text-right">${formatNumber(p.requests)}</td>
        <td class="text-right">${formatNumber(p.input_tokens)}</td>
        <td class="text-right">${formatNumber(p.output_tokens)}</td>
        <td class="text-right">${formatCost(p.cost)}</td>
        <td class="text-right">${formatDuration(p.avg_latency)}</td>
      </tr>
    `).join("");
  }

  function renderAgentsTable(agents) {
    const tbody = document.getElementById("agentsTableBody");
    tbody.innerHTML = agents.map(a => `
      <tr>
        <td>${escapeHtml(a.agent)}</td>
        <td class="text-right">${formatNumber(a.requests)}</td>
        <td class="text-right">${formatNumber(a.input_tokens)}</td>
        <td class="text-right">${formatNumber(a.output_tokens)}</td>
        <td class="text-right">${formatCost(a.cost)}</td>
      </tr>
    `).join("");
  }

  function renderOptimizationsTable(opts) {
    const tbody = document.getElementById("optimizationsTableBody");
    tbody.innerHTML = opts.map(o => `
      <tr>
        <td>${escapeHtml(o.optimization)}</td>
        <td class="text-right">${formatNumber(o.count)}</td>
        <td class="text-right">${formatNumber(o.saved_input)}</td>
        <td class="text-right">${formatNumber(o.saved_output)}</td>
        <td class="text-right">${formatCost(o.saved_cost)}</td>
      </tr>
    `).join("");
  }

  function syncFilterOptions() {
    addOptions("filterProvider", "filterProviderData", collect(
      document.getElementById("providersTableBody"), 0));
    addOptions("filterAgent", "filterAgentData", collect(
      document.getElementById("agentsTableBody"), 0));
    addOptions("filterOutcome", "filterOutcomeData", OUTCOMES);
  }

  function collect(tbody, column) {
    const values = [];
    for (const row of tbody.rows) {
      const cell = row.cells[column];
      const text = cell && cell.textContent.trim();
      if (text && text !== "—" && !values.includes(text)) values.push(text);
    }
    return values;
  }

  function addOptions(selectId, cacheId, values) {
    const select = document.getElementById(selectId);
    if (!select) return;
    const cached = select.dataset[cacheId];
    const signature = values.join(" ");
    if (cached === signature) return;
    // Never disturb the current selection while live data streams in.
    const current = select.value;
    const existing = new Set(Array.from(select.options).map(o => o.value).filter(Boolean));
    for (const value of values) {
      if (existing.has(value)) continue;
      select.add(new Option(value, value));
      existing.add(value);
    }
    select.value = current;
    select.dataset[cacheId] = signature;
  }

  function renderTimeseriesChart(timeseries) {
    const canvas = document.getElementById("usageChart");
    // A blocked CDN must not stop the rest of the dashboard from updating.
    if (!canvas || typeof Chart !== "function") return;

    const multiDay = timeseries.some(d => new Date(d.bucket_ms).getDate() !==
      new Date(timeseries[0] ? timeseries[0].bucket_ms : d.bucket_ms).getDate());
    const labels = timeseries.map(d => new Date(d.bucket_ms).toLocaleString(
      [], multiDay
        ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
        : { hour: "2-digit", minute: "2-digit" }));
    const requests = timeseries.map(d => d.requests || 0);
    const tokens = timeseries.map(d => d.tokens || 0);
    const costs = timeseries.map(d => d.cost || 0);

    // Updating in place keeps the view stable instead of tearing down the
    // chart on every commit.
    if (usageChart) {
      usageChart.data.labels = labels;
      usageChart.data.datasets[0].data = requests;
      usageChart.data.datasets[1].data = tokens.map(t => t / 1000);
      usageChart.data.datasets[2].data = costs;
      usageChart.update("none");
      return;
    }

    usageChart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Requests",
            data: requests,
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            yAxisID: "y",
            tension: 0.3,
          },
          {
            label: "Tokens (×1000)",
            data: tokens.map(t => t / 1000),
            borderColor: "#10b981",
            backgroundColor: "rgba(16, 185, 129, 0.1)",
            yAxisID: "y1",
            tension: 0.3,
          },
          {
            label: "Cost ($)",
            data: costs,
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245, 158, 11, 0.1)",
            yAxisID: "y2",
            tension: 0.3,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { position: "top" } },
        scales: {
          y: { type: "linear", position: "left", title: { display: true, text: "Requests" } },
          y1: { type: "linear", position: "right", title: { display: true, text: "Tokens (K)" }, grid: { drawOnChartArea: false } },
          y2: { type: "linear", position: "right", title: { display: true, text: "Cost ($)" }, grid: { drawOnChartArea: false }, offset: true },
        },
      },
    });
  }

  async function loadRequests(page = 0, token = generation) {
    currentRequestsPage = page;
    const providerId = document.getElementById("filterProvider").value || null;
    const agent = document.getElementById("filterAgent").value || null;
    const outcome = document.getElementById("filterOutcome").value || null;

    const params = new URLSearchParams({
      limit: REQUESTS_PAGE_SIZE,
      offset: page * REQUESTS_PAGE_SIZE,
      since_hours: rangeHours(),
    });
    if (providerId) params.set("provider_id", providerId);
    if (agent) params.set("agent", agent);
    if (outcome) params.set("outcome", outcome);

    const data = await fetchJSON(`${API_BASE}/usage/requests?${params}`);
    if (token !== generation) return;
    renderRequestsTable(data.requests || []);
    renderPagination(data.limit, data.offset, data.requests?.length || 0);
  }

  function renderRequestsTable(requests) {
    const tbody = document.getElementById("requestsTableBody");
    tbody.innerHTML = requests.map(r => `
      <tr>
        <td class="font-mono text-xs">${escapeHtml(r.request_id.slice(0, 12))}…</td>
        <td>${formatTimeAgo(r.started_ms)}</td>
        <td>${escapeHtml(r.agent)}</td>
        <td>${escapeHtml(r.gateway_model)}</td>
        <td>${escapeHtml(r.provider_id)}/${escapeHtml(r.provider_model)}</td>
        <td class="text-right">${formatNumber(r.input_tokens)}</td>
        <td class="text-right">${formatNumber(r.output_tokens)}</td>
        <td class="text-right">${formatCost(r.cost_usd)}</td>
        <td class="text-right">${formatDuration(r.latency_ms)}</td>
        <td class="text-right">${formatDuration(r.ttfb_ms)}</td>
        <td>${outcomeBadge(r.outcome)}</td>
        <td class="text-right">${r.attempt_count}</td>
        <td>${escapeHtml(r.fallback_path?.join(" → ") || "—")}</td>
      </tr>
    `).join("");
  }

  function renderPagination(limit, offset, returnedCount) {
    const pagination = document.getElementById("requestsPagination");
    const currentPage = Math.floor(offset / limit);
    const hasNext = returnedCount === limit;
    pagination.innerHTML = `
      <button ${currentPage === 0 ? "disabled" : ""} onclick="loadRequests(${currentPage - 1})">← Prev</button>
      <span>Page ${currentPage + 1}</span>
      <button ${!hasNext ? "disabled" : ""} onclick="loadRequests(${currentPage + 1})">Next →</button>
    `;
  }

  async function loadProvidersHealth() {
    const data = await fetchJSON(`${API_BASE}/providers/health`);
    const tbody = document.getElementById("healthTableBody");
    tbody.innerHTML = (data.providers || []).map(p => `
      <tr>
        <td>${escapeHtml(p.provider_id)}</td>
        <td><span class="badge ${p.is_healthy ? "badge-success" : "badge-error"}">${p.is_healthy ? "Healthy" : "Degraded"}</span></td>
        <td>${p.current_episode}</td>
        <td class="text-right">${p.success_rate ? (p.success_rate * 100).toFixed(1) + "%" : "—"}</td>
        <td class="text-right">${formatDuration(p.p50_latency_ms)}</td>
        <td class="text-right">${formatDuration(p.p95_latency_ms)}</td>
        <td class="text-right">${p.rate_limit_remaining !== null ? formatNumber(p.rate_limit_remaining) : "—"}</td>
        <td>${p.last_error ? escapeHtml(p.last_error.slice(0, 50)) + "…" : "—"}</td>
      </tr>
    `).join("");
  }

  // -------------------------------------------------------------- live status

  function renderLiveState() {
    const container = document.getElementById("usageLiveState");
    const text = document.getElementById("usageLiveText");
    if (!container || !text) return;
    if (!active) {
      container.classList.remove("is-live", "is-down");
      text.textContent = "Paused";
      return;
    }
    if (connected) {
      container.classList.add("is-live");
      container.classList.remove("is-down");
      text.textContent = lastUpdatedMs
        ? `Live · updated ${formatTimeAgo(lastUpdatedMs)}`
        : "Live";
      return;
    }
    container.classList.remove("is-live");
    container.classList.add("is-down");
    text.textContent = "Reconnecting…";
  }

  const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
  }

  // Expose to global for inline handlers
  window.loadRequests = (page = 0) => {
    void refreshRequestsFromControl(page);
  };
  window.loadSummary = () => {
    void refreshSummaryFromControl();
  };
  window.loadProvidersHealth = loadProvidersHealth;

  async function refreshRequestsFromControl(page) {
    await loadRequests(page);
    lastUpdatedMs = Date.now();
    renderLiveState();
  }

  async function refreshSummaryFromControl() {
    await loadSummary();
    lastUpdatedMs = Date.now();
    renderLiveState();
  }

  // Tab switching
  window.showPanel = function (panelId) {
    document.querySelectorAll(".section-panel").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".section-tab").forEach(t => t.classList.remove("active"));
    const panel = document.getElementById("panel-" + panelId);
    const tab = document.querySelector('.section-tab[data-panel="' + panelId + '"]');
    if (panel) panel.classList.add("active");
    if (tab) tab.classList.add("active");
    activePanel = panelId;
    renderLiveState();
  };

  window.UsageDashboard = { activate, deactivate, refresh: refreshAll };

  window.addEventListener("pagehide", deactivate);

  document.addEventListener("visibilitychange", () => {
    if (!active) return;
    // A backgrounded browser tab should not hold an open feed.
    if (document.hidden) {
      closeFeed();
      clearDebounce();
      renderLiveState();
    } else {
      connectFeed();
      void refreshAll();
    }
  });

  // The admin shell calls activate/deactivate when the view is navigated to;
  // observe the section too so a direct visit to /admin/usage starts live.
  document.addEventListener("DOMContentLoaded", () => {
    const usageView = document.getElementById("view-usage");
    if (!usageView) return;
    const observer = new MutationObserver(() => {
      if (usageView.hidden) {
        deactivate();
      } else {
        activate();
      }
    });
    observer.observe(usageView, { attributes: true, attributeFilter: ["hidden"] });
    if (!usageView.hidden) activate();
  });
})();