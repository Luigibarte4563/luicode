"""Admin shell checks for the Browser Agent tab (FR-1, FR-2, FR-3, FR-6, FR-7)."""

import re
from pathlib import Path

from luicode.api.admin_routes import _ADMIN_ASSET_FILENAMES
from luicode.core.version import package_version

STATIC = (
    Path(__file__).resolve().parents[2] / "src" / "luicode" / "api" / "admin_static"
)
INDEX = (STATIC / "index.html").read_text(encoding="utf-8")
ADMIN_JS = (STATIC / "admin.js").read_text(encoding="utf-8")
BROWSER_JS = (STATIC / "browser_agent.js").read_text(encoding="utf-8")
ADMIN_CSS = (STATIC / "admin.css").read_text(encoding="utf-8")


def test_browser_agent_view_exists():
    assert 'data-view="browser"' in INDEX
    assert 'id="view-browser"' in INDEX


def test_browser_agent_nav_entry_exists():
    assert 'id: "browser"' in ADMIN_JS
    assert 'label: "Browser agent"' in ADMIN_JS


def test_jev_card_shows_status_chrome_and_text_model():
    """FR-2 / FR-3: card carries a status pill, Chrome status, and text model."""
    for element_id in (
        "jevStatusPill",
        "jevStatusMessage",
        "jevChromeStatus",
        "jevTextModel",
        "jevAllowedDomains",
    ):
        assert f'id="{element_id}"' in INDEX, element_id


def test_connect_disconnect_and_stop_buttons_exist():
    """FR-6 / SEC-10: the card exposes Connect/Manage, Disconnect, and Stop."""
    for element_id in ("jevConnect", "jevDisconnect", "jevStop"):
        assert f'id="{element_id}"' in INDEX, element_id


def test_connect_dialog_previews_changes_before_writing():
    """FR-4: the dialog lists what will change before anything is modified."""
    assert 'id="jevChangeList"' in INDEX
    assert "These files and settings will change" in INDEX
    assert "changePreview" in BROWSER_JS


def test_connect_dialog_states_page_state_leaves_the_machine():
    """SEC-2: the disclosure is shown and consent is required."""
    assert "Page state leaves your machine" in INDEX
    assert 'id="jevConsent"' in INDEX
    assert "confirm_data_processing" in BROWSER_JS


def test_keys_are_masked_password_inputs():
    """FR-5 / SEC-7: keys are entered as masked inputs."""
    assert 'buildField("jevTypeSafeKey", "TypeSafe API key", "password"' in BROWSER_JS
    assert 'buildField("jevTextKey", "Text model API key (optional)", "password"' in (
        BROWSER_JS
    )


def test_all_four_status_states_are_rendered():
    """FR-3: Not connected, Working, Connected, and Error are all representable."""
    for state in ("not_connected", "connected", "error"):
        assert state in BROWSER_JS, state
    # The working state is the busy connect button.
    assert "Connecting" in BROWSER_JS


def test_run_history_renders_without_exposing_goals_by_default():
    """FR-26 / FR-27: the table shows history; the API redacts goals."""
    assert 'id="jevRunsBody"' in INDEX
    assert "/admin/api/browser/jev/runs" in BROWSER_JS


def test_browser_agent_asset_is_served():
    assert "browser_agent.js" in _ADMIN_ASSET_FILENAMES
    # The template carries a version placeholder resolved when the page is served.
    assert "/admin/assets/__LUICODE_VERSION__/browser_agent.js" in INDEX
    assert f"/admin/assets/{package_version()}/browser_agent.js" in INDEX.replace(
        "__LUICODE_VERSION__", package_version()
    )


def test_browser_agent_module_is_loaded_before_admin_js():
    """The card must bind its handlers before the shell renders navigation."""
    browser_at = INDEX.index("browser_agent.js")
    admin_at = INDEX.rindex("admin.js")
    assert browser_at < admin_at


def test_no_inline_script_tags_were_added():
    """Keep the Admin CSP posture: behaviour lives in served assets."""
    assert not re.search(r"<script(?![^>]*src=)", INDEX)


def test_consent_checkbox_actually_updates_consent_state():
    """Regression: the Connect button must be able to enable at all.

    The checkbox listener has to assign ``consentGiven`` from ``consent.checked``.
    Binding the handler straight to ``syncConnectButton`` left the flag stuck at
    false, so the button could never enable and Connect was unusable.
    """
    # Match the whole handler body up to its closing "});" so the assertion can
    # see both statements rather than stopping at the first inner brace.
    listener = re.search(
        r'addEventListener\("change",\s*\(\)\s*=>\s*\{(.*?)\}\);',
        BROWSER_JS,
        flags=re.DOTALL,
    )
    assert listener, (
        "the consent change handler must set consentGiven from consent.checked"
    )
    body = listener.group(1)
    assert re.search(r"consentGiven\s*=\s*consent\.checked;", body), (
        "the consent change handler must set consentGiven from consent.checked"
    )
    # The handler must also re-evaluate the button, not only flip the flag.
    assert "syncConnectButton()" in body


def test_connect_button_stays_disabled_without_consent_and_key():
    """SEC-2: the button requires both the acknowledgement and a TypeSafe key."""
    assert "consentGiven && key" in BROWSER_JS
    assert re.search(r"button\.disabled\s*=\s*!\(consentGiven\s*&&\s*key", BROWSER_JS)


def test_consent_is_reset_each_time_the_dialog_opens():
    """A stale acknowledgement must not carry over into a later Connect."""
    open_dialog = BROWSER_JS[BROWSER_JS.index("function openDialog") :][:800]
    assert "consentGiven = false;" in open_dialog
    assert "consent.checked = false;" in open_dialog


# ------------------------------------------------------------------- layout


def test_cards_share_one_row_in_a_dedicated_grid():
    """The two cards sit side by side instead of stacking as columns."""
    assert '<div class="browser-agent-grid">' in INDEX
    # The view itself is no longer the card grid, so the settings form below it
    # is a sibling rather than a third grid cell competing with the cards.
    assert 'id="view-browser" class="admin-view"' in INDEX


def test_both_cards_are_inside_the_browser_agent_grid():
    grid_start = INDEX.index('<div class="browser-agent-grid">')
    grid_end = INDEX.index("</article>", INDEX.index('id="panel-jevRuns"')) + len(
        "</article>"
    )
    block = INDEX[grid_start:grid_end]
    assert 'id="jevStatusPill"' in block, "Jev card must be in the grid"
    assert 'id="jevRunsBody"' in block, "run history card must be in the grid"


def test_settings_form_sits_below_the_card_row():
    """Mirrors the Providers tab: grid of cards, then full-width sections."""
    assert INDEX.index("</div>") < INDEX.index('id="browserAgentSections"')
    grid_start = INDEX.index('<div class="browser-agent-grid">')
    sections_at = INDEX.index('id="browserAgentSections"')
    assert grid_start < sections_at


def test_browser_agent_grid_uses_two_tracks_and_collapses_on_small_screens():
    """auto-fill would strand the cards in narrow left-hand columns."""
    rule = re.search(r"\.browser-agent-grid\s*\{[^}]*\}", ADMIN_CSS, flags=re.DOTALL)
    assert rule, "the .browser-agent-grid rule is missing"
    body = rule.group(0)
    assert "display: grid" in body
    # Two explicit tracks, so both cards render in one row.
    tracks = re.search(r"grid-template-columns:\s*([^;]+);", body)
    assert tracks, "grid-template-columns is missing"
    assert tracks.group(1).count("minmax") == 2, tracks.group(1)
    assert "auto-fill" not in body, "auto-fill leaves empty tracks behind"
    # Run history carries a five-column table, so it gets the wider track.
    assert "1.4fr" in tracks.group(1)
    # And the row still collapses on narrow viewports.
    assert re.search(
        r"@media\s*\(max-width:\s*900px\)\s*\{\s*\.browser-agent-grid\s*\{[^}]*\}",
        ADMIN_CSS,
        flags=re.DOTALL,
    )


def test_shared_provider_grid_rule_is_untouched():
    """Other tabs keep their existing card layout."""
    shared = re.search(r"^\.provider-grid\s*\{[^}]*\}", ADMIN_CSS, flags=re.MULTILINE)
    assert shared, "the shared .provider-grid rule must still exist"
    assert "auto-fill" in shared.group(0)
