"""Static contracts for the Admin Usage view's live update wiring."""

from pathlib import Path

STATIC = (
    Path(__file__).resolve().parents[2] / "src" / "luicode" / "api" / "admin_static"
)


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_admin_shell_activates_and_deactivates_the_usage_view():
    admin = _read("admin.js")
    assert 'if (activeView.id === "usage") window.UsageDashboard.activate();' in admin
    assert "else window.UsageDashboard.deactivate();" in admin


def test_usage_view_subscribes_to_the_live_feed():
    usage = _read("usage.js")
    assert "new EventSource(`${API_BASE}/usage/events`)" in usage
    assert 'feed.addEventListener("usage.updated"' in usage
    assert 'feed.addEventListener("feed.ready"' in usage
    assert 'feed.addEventListener("feed.resync_required"' in usage


def test_usage_view_closes_its_feed_when_deactivated():
    usage = _read("usage.js")
    deactivate = usage.split("function deactivate()")[1].split("function ")[0]
    assert "closeFeed()" in deactivate
    assert "stopPolling()" in deactivate
    assert "clearDebounce()" in deactivate
    assert "++generation" in deactivate


def test_usage_view_drops_in_flight_reads_on_deactivate():
    """A late response must never repaint a view the user has left."""
    usage = _read("usage.js")
    assert "if (token !== generation) return;" in usage
    assert usage.count("token !== generation") >= 3


def test_usage_view_debounces_bursts_of_commits():
    usage = _read("usage.js")
    assert "function scheduleRefresh()" in usage
    assert "LIVE_DEBOUNCE_MS" in usage


def test_usage_view_polls_for_state_that_has_no_usage_trigger():
    """Provider health and a missed event both need their own cadence."""
    usage = _read("usage.js")
    assert "HEALTH_POLL_MS" in usage
    assert "RECONCILE_POLL_MS" in usage
    assert "if (!document.hidden)" in usage


def test_usage_view_updates_the_chart_in_place():
    """Recreating the chart on every commit flickers and leaks animations."""
    usage = _read("usage.js")
    assert "usageChart.destroy()" not in usage
    assert 'usageChart.update("none")' in usage


def test_usage_view_survives_a_blocked_chart_cdn():
    """A CDN failure must not take the whole dashboard down with it."""
    usage = _read("usage.js")
    assert 'typeof Chart !== "function"' in usage


def test_usage_view_populates_its_filter_dropdowns():
    usage = _read("usage.js")
    assert "function syncFilterOptions()" in usage
    assert "function addOptions(" in usage
    assert "select.value = current" in usage


def test_usage_view_keeps_the_users_position_across_refreshes():
    usage = _read("usage.js")
    # Pagination and panel selection are read from state, never reset by a refresh.
    assert "currentRequestsPage = page;" in usage
    assert "activePanel = panelId;" in usage


def test_admin_page_ships_the_live_status_indicator():
    markup = _read("index.html")
    assert 'id="usageLiveState"' in markup
    assert 'id="usageLiveText"' in markup
    assert "usage-live-dot" in markup


def test_usage_styles_define_the_live_indicator():
    styles = _read("usage.css")
    assert ".usage-live" in styles
    assert ".usage-live.is-live .usage-live-dot" in styles
    assert ".usage-live.is-down .usage-live-dot" in styles
    assert "usage-stat-value.is-updated" in styles


def test_usage_styles_respect_reduced_motion():
    styles = _read("usage.css")
    assert "@media (prefers-reduced-motion: reduce)" in styles
