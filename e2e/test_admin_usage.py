"""Browser contracts for the Admin Usage tab's live updates."""

from playwright.sync_api import Page, expect

from e2e.usage_support import UsageControl

CONTROL_FEED = """(() => {
  const Native = window.EventSource;
  window.openFeeds = 0;
  window.EventSource = class extends Native {
    constructor(...args) {
      super(...args);
      if (String(args[0]).includes('/api/usage/events')) window.openFeeds += 1;
    }
  };
})();"""


def _open(page: Page, admin_base_url: str) -> None:
    page.add_init_script(CONTROL_FEED)
    page.goto(f"{admin_base_url}/admin/usage")
    expect(page.locator("#view-usage")).to_be_visible()
    expect(page.locator("#usageLiveState")).to_have_class(
        "usage-live is-live", timeout=15_000
    )


def test_usage_tab_connects_its_live_feed(page: Page, admin_base_url: str) -> None:
    _open(page, admin_base_url)
    expect(page.locator("#usageLiveText")).to_contain_text("Live")
    assert page.evaluate("() => window.openFeeds") == 1


def test_committed_usage_appears_without_a_reload(
    page: Page, admin_base_url: str, usage_control: UsageControl
) -> None:
    _open(page, admin_base_url)
    expect(page.locator("#totalRequests")).to_have_text("0")

    usage_control.run(usage_control.record("live-request-1"))

    # No navigation and no reload: the committed batch arrives over the feed.
    expect(page.locator("#totalRequests")).to_have_text("1", timeout=15_000)


def test_live_updates_keep_the_open_request_log_panel(
    page: Page, admin_base_url: str, usage_control: UsageControl
) -> None:
    _open(page, admin_base_url)
    page.get_by_role("tab", name="Request Log").click()
    expect(page.locator("#panel-requests")).to_be_visible()
    expect(page.locator("#filterOutcome")).to_have_value("")

    usage_control.run(usage_control.record("live-request-2"))

    # The new row lands without discarding the panel, page, or filters.
    expect(page.locator("#requestsTableBody tr")).to_have_count(1, timeout=15_000)
    expect(page.locator("#requestsPagination")).to_contain_text("Page 1")
    expect(page.locator("#panel-requests")).to_be_visible()


def test_filters_offer_the_providers_and_agents_in_the_window(
    page: Page, admin_base_url: str, usage_control: UsageControl
) -> None:
    usage_control.run(usage_control.record("live-request-3"))
    _open(page, admin_base_url)

    expect(page.locator("#filterProvider")).to_contain_text("open_router")
    expect(page.locator("#filterAgent")).to_contain_text("claude-code")
    # Outcomes are a fixed vocabulary, so they exist before any traffic.
    expect(page.locator("#filterOutcome")).to_contain_text("success")


def test_leaving_the_tab_closes_the_feed_and_returning_reopens_it(
    page: Page, admin_base_url: str
) -> None:
    _open(page, admin_base_url)

    page.get_by_role("button", name="Providers", exact=True).click()
    expect(page.locator("#view-usage")).to_be_hidden()
    assert page.evaluate("() => window.openFeeds") == 1

    page.get_by_role("button", name="Usage", exact=True).click()
    expect(page.locator("#view-usage")).to_be_visible()
    expect(page.locator("#usageLiveState")).to_have_class(
        "usage-live is-live", timeout=15_000
    )
    assert page.evaluate("() => window.openFeeds") == 2


def test_a_hidden_browser_tab_does_not_hold_the_feed(
    page: Page, admin_base_url: str
) -> None:
    _open(page, admin_base_url)

    page.evaluate(
        """() => {
          Object.defineProperty(document, 'hidden', { value: true, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        }"""
    )
    # A backgrounded tab must release its connection rather than idle on it.
    assert page.evaluate("() => window.openFeeds") == 1
    expect(page.locator("#usageLiveState")).to_have_class("usage-live is-down")

    page.evaluate(
        """() => {
          Object.defineProperty(document, 'hidden', { value: false, configurable: true });
          document.dispatchEvent(new Event('visibilitychange'));
        }"""
    )
    expect(page.locator("#usageLiveState")).to_have_class(
        "usage-live is-live", timeout=15_000
    )
    assert page.evaluate("() => window.openFeeds") == 2
