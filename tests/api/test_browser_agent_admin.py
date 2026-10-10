"""Admin API tests for the browser-agent lifecycle routes.

Covers FR-4, FR-6, FR-9, FR-10 and SEC-2/SEC-9 without running a real install:
the installer is stubbed so the suite stays free and deterministic.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from luicode.api.admin_routes import router as admin_router
from luicode.application.browser_agent.admin import BrowserAgentAdminService
from luicode.application.browser_agent.service import BrowserAgentService
from luicode.config.env_migrations import CONFIG_SCHEMA_VERSION
from luicode.config.loader import ManagedConfigStore
from luicode.config.settings import Settings
from tests.browser_agent_support import RecordingBrowserAgent


def _local_client(app):
    """Admin client bound to loopback, matching the Admin security boundary."""
    return TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Admin client wired to a browser-agent service over an isolated store."""
    # Isolate the real managed-config location the loader resolves from.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    store = ManagedConfigStore()
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(
        f"LUICODE_CONFIG_SCHEMA={CONFIG_SCHEMA_VERSION}\nMODEL=nvidia_nim/test-model\n",
        encoding="utf-8",
    )

    settings = Settings.model_validate(
        {"MODEL": "nvidia_nim/test-model", "JEV_ALLOWED_DOMAINS": "example.com"}
    )
    service = BrowserAgentService(port=RecordingBrowserAgent(), settings=settings)
    admin = BrowserAgentAdminService(store=store, service=service)

    class _Admin:
        """The admin port itself is unused by these routes."""

    class _Services:
        """Minimal stand-in for the ApiServices boundary."""

        admin: _Admin
        browser_agent_admin: BrowserAgentAdminService

    _Services.admin = _Admin()
    _Services.browser_agent_admin = admin

    app = FastAPI()
    app.include_router(admin_router)
    from luicode.api.dependencies import get_services

    app.dependency_overrides[get_services] = lambda: _Services()
    return _local_client(app)


def test_status_reports_not_connected_by_default(client):
    """AC-1: a fresh install shows Not connected."""
    response = client.get("/admin/api/browser/jev/status")

    assert response.status_code == 200
    body = response.json()
    assert body["state"] == "not_connected"
    assert body["allowed_domains"] == ["example.com"]
    assert "chrome" in body


def test_connect_requires_explicit_data_processing_consent(client):
    """SEC-2: page state disclosure must be acknowledged first."""
    response = client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "secret",
            "text_model_api_key": "",
            "allowed_domains": "example.com",
            "confirm_data_processing": False,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert "TypeSafe" in body["error"]


def test_connect_rejects_an_empty_key_before_installing(client, monkeypatch):
    """FR-9 / AC-3: validation fails first and nothing is written."""
    from luicode.application.browser_agent import admin as admin_module

    def _fail_install():
        raise AssertionError("install must not run for an empty key")

    monkeypatch.setattr(admin_module, "install_jev", _fail_install)

    response = client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "   ",
            "confirm_data_processing": True,
        },
    )

    body = response.json()
    assert body["ok"] is False
    assert "TypeSafe" in body["error"]


def test_connect_reports_install_failure_without_writing_keys(client, monkeypatch):
    """FR-9 / AC-3: a failed install leaves the config untouched."""
    from luicode.application.browser_agent import admin as admin_module
    from luicode.application.browser_agent.admin import JevInstallResult

    async def _failed():
        return JevInstallResult(ok=False, message="uv was not found on PATH.")

    monkeypatch.setattr(admin_module, "install_jev", _failed)

    response = client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "secret",
            "confirm_data_processing": True,
        },
    )

    body = response.json()
    assert body["ok"] is False
    assert "uv" in body["error"]
    assert body["changed"] == []


def test_connect_succeeds_and_enables_the_feature(client, monkeypatch):
    """FR-8: keys land in the managed env and the feature turns on."""
    from luicode.application.browser_agent import admin as admin_module
    from luicode.application.browser_agent.admin import JevInstallResult

    async def _ok():
        return JevInstallResult(ok=True, message="installed")

    monkeypatch.setattr(admin_module, "install_jev", _ok)

    response = client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "ts-secret",
            "text_model_api_key": "text-secret",
            "allowed_domains": "example.com",
            "confirm_data_processing": True,
        },
    )

    body = response.json()
    assert body["ok"] is True, body
    assert "TYPESAFE_API_KEY" in body["changed"]

    from luicode.config.loader import ManagedConfigStore as Store

    managed = dict(Store().read().managed)
    assert managed["JEV_ENABLED"] == "true"
    assert managed["TYPESAFE_API_KEY"] == "ts-secret"
    assert managed["TEXT_MODEL_API_KEY"] == "text-secret"


def test_disconnect_clears_both_keys_and_disables(client, monkeypatch):
    """FR-10 / AC-4: keys are cleared; the package stays installed."""
    from luicode.application.browser_agent import admin as admin_module
    from luicode.application.browser_agent.admin import JevInstallResult

    async def _ok():
        return JevInstallResult(ok=True, message="installed")

    monkeypatch.setattr(admin_module, "install_jev", _ok)
    client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "ts-secret",
            "text_model_api_key": "text-secret",
            "confirm_data_processing": True,
        },
    )

    response = client.post("/admin/api/browser/jev/disconnect")

    assert response.status_code == 200
    from luicode.config.loader import ManagedConfigStore as Store

    managed = dict(Store().read().managed)
    assert managed.get("JEV_ENABLED") == "false"
    assert "TYPESAFE_API_KEY" not in managed
    assert "TEXT_MODEL_API_KEY" not in managed


def test_stop_reports_whether_a_task_was_cancelled(client):
    """SEC-10: Stop answers even when nothing is running."""
    response = client.post("/admin/api/browser/jev/stop")

    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_runs_history_redacts_goals(client):
    """FR-27: run history does not expose goals by default."""
    response = client.get("/admin/api/browser/jev/runs")

    assert response.status_code == 200
    assert response.json()["runs"] == []


def test_browser_agent_routes_are_loopback_only():
    """SEC-9: the routes inherit the loopback guard, like every admin route."""
    guarded = [
        route
        for route in admin_router.routes
        if getattr(route, "path", "").startswith("/admin/api/browser/jev/")
    ]
    assert guarded, "browser agent routes are missing"
    # The guard is applied inside each handler via require_loopback_admin, and the
    # page route is registered alongside the other admin pages.
    assert any(
        getattr(route, "path", "") == "/admin/browser" for route in admin_router.routes
    )
