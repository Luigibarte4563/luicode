/**
 * Admin Usage View
 * Shows token usage, costs, optimization savings, and provider health.
 */

(function () {
  "use strict";

  const API_BASE = "/admin/api";
  let usageChart = null;
  let requestsTable = null;
  let currentRequestsPage = 0;
  const REQUESTS_PAGE_SIZE = 50;

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

  async function loadSummary() {
    const sinceHours = parseInt(document.getElementById("usageSinceHours").value, 10) || 24;
    const data = await fetchJSON(`${API_BASE}/usage/summary?since_hours=${sinceHours}`);
    renderSummary(data);
    renderProvidersTable(data.by_provider || []);
    renderAgentsTable(data.by_agent || []);
    renderOptimizationsTable(data.by_optimization || []);
    renderTimeseriesChart(data.timeseries || []);
  }

  function renderSummary(data) {
    const totals = data.totals || {};
    document.getElementById("totalRequests").textContent = formatNumber(totals.total_requests);
    document.getElementById("totalInputTokens").textContent = formatNumber(totals.total_input);
    document.getElementById("totalOutputTokens").textContent = formatNumber(totals.total_output);
    document.getElementById("totalTokens").textContent = formatNumber((totals.total_input || 0) + (totals.total_output || 0));
    document.getElementById("totalCost").textContent = formatCost(totals.total_cost);
    document.getElementById("providersUsed").textContent = formatNumber(totals.providers_used);
    document.getElementById("agentsUsed").textContent = formatNumber(totals.agents_used);
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

  function renderTimeseriesChart(timeseries) {
    const canvas = document.getElementById("usageChart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const labels = timeseries.map(d => new Date(d.bucket_ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    const requests = timeseries.map(d => d.requests || 0);
    const tokens = timeseries.map(d => d.tokens || 0);
    const costs = timeseries.map(d => d.cost || 0);

    if (usageChart) usageChart.destroy();

    usageChart = new Chart(ctx, {
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

  async function loadRequests(page = 0) {
    currentRequestsPage = page;
    const sinceHours = parseInt(document.getElementById("usageSinceHours").value, 10) || 24;
    const providerId = document.getElementById("filterProvider").value || null;
    const agent = document.getElementById("filterAgent").value || null;
    const outcome = document.getElementById("filterOutcome").value || null;

    const params = new URLSearchParams({
      limit: REQUESTS_PAGE_SIZE,
      offset: page * REQUESTS_PAGE_SIZE,
      since_hours: sinceHours,
    });
    if (providerId) params.set("provider_id", providerId);
    if (agent) params.set("agent", agent);
    if (outcome) params.set("outcome", outcome);

    const data = await fetchJSON(`${API_BASE}/usage/requests?${params}`);
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

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, c => ({ "&": "&", "<": "<", ">": ">", '"': """, "'": "'" }[c]));
  }

  // Expose to global for inline handlers
  window.loadRequests = loadRequests;
  window.loadSummary = loadSummary;
  window.loadProvidersHealth = loadProvidersHealth;

  // Tab switching
  window.showPanel = function (panelId) {
    document.querySelectorAll(".section-panel").forEach(p => p.classList.remove("active"));
    document.querySelectorAll(".section-tab").forEach(t => t.classList.remove("active"));
    const panel = document.getElementById("panel-" + panelId);
    const tab = document.querySelector('.section-tab[data-panel="' + panelId + '"]');
    if (panel) panel.classList.add("active");
    if (tab) tab.classList.add("active");
  };

  // Initialize when view becomes active
  document.addEventListener("DOMContentLoaded", () => {
    const usageView = document.getElementById("view-usage");
    if (!usageView) return;

    const observer = new MutationObserver(() => {
      if (!usageView.hidden && !usageView.dataset.loaded) {
        usageView.dataset.loaded = "true";
        loadSummary();
        loadRequests(0);
        loadProvidersHealth();
      }
    });
    observer.observe(usageView, { attributes: true, attributeFilter: ["hidden"] });
  });
})();