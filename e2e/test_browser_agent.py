"""Browser contracts for the Admin Browser Agent card.

These exercise the real page, the real Admin API, and the real single-writer
config path. The Jev installer and environment probes are stubbed by the shared
fixture, so no network, Chrome, or package install is involved.
"""

from playwright.sync_api import Page, expect


def _open(page: Page, admin_base_url: str) -> None:
    page.goto(f"{admin_base_url}/admin/browser")
    expect(page.locator("#view-browser")).to_be_visible()
    expect(page.locator("#jevStatusPill")).to_have_text("Not connected", timeout=15_000)


def _connect(
    page: Page, *, key: str = "ts-secret", domains: str = "example.com"
) -> None:
    page.locator("#jevConnect").click()
    expect(page.locator("#jevDialog")).to_be_visible()
    page.locator("#jevTypeSafeKey").fill(key)
    page.locator("#jevDomains").fill(domains)
    page.locator("#jevConsent").check()
    expect(page.locator("#confirmJevConnect")).to_be_enabled()
    page.locator("#confirmJevConnect").click()


def test_connect_updates_the_card_without_a_reload(
    page: Page, admin_base_url: str
) -> None:
    """Regression: the card used to keep rendering its startup snapshot.

    Connecting saved the keys, yet the pill stayed "Not connected" and the
    allowlist stayed stale until the server restarted.
    """
    _open(page, admin_base_url)

    _connect(page, domains="other.test")

    expect(page.locator("#jevStatusPill")).to_have_text("Connected", timeout=15_000)
    expect(page.locator("#jevAllowedDomains")).to_have_text("other.test")
    expect(page.locator("#jevDisconnect")).to_be_visible()


def test_disconnect_returns_the_card_to_not_connected(
    page: Page, admin_base_url: str
) -> None:
    _open(page, admin_base_url)
    _connect(page)
    expect(page.locator("#jevStatusPill")).to_have_text("Connected", timeout=15_000)

    page.locator("#jevDisconnect").click()

    expect(page.locator("#jevStatusPill")).to_have_text("Not connected", timeout=15_000)
    expect(page.locator("#jevDisconnect")).to_be_hidden()
    expect(page.locator("#jevStatusMessage")).to_be_hidden()


def test_connect_requires_the_data_processing_acknowledgement(
    page: Page, admin_base_url: str
) -> None:
    """SEC-2: a key alone must not enable the tool."""
    _open(page, admin_base_url)

    page.locator("#jevConnect").click()
    expect(page.locator("#jevDialog")).to_be_visible()
    page.locator("#jevTypeSafeKey").fill("ts-secret")

    expect(page.locator("#confirmJevConnect")).to_be_disabled()
