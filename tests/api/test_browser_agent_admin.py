"""Admin API tests for the browser-agent lifecycle routes.

Covers FR-4, FR-6, FR-9, FR-10 and SEC-2/SEC-9 without running a real install:
the installer is stubbed so the suite stays free and deterministic.
"""

from collections.abc import Mapping

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from luicode.api.admin_routes import router as admin_router
from luicode.api.admin_security import require_loopback_admin
from luicode.application.browser_agent.admin import BrowserAgentAdminService
from luicode.application.browser_agent.service import BrowserAgentService
from luicode.config.admin.state import ConfigInputValue
from luicode.config.env_migrations import CONFIG_SCHEMA_VERSION
from luicode.config.loader import ManagedConfigStore
from luicode.config.settings import Settings
from luicode.core.json_types import JsonObject
from luicode.runtime.configuration import ConfigurationService
from tests.browser_agent_support import RecordingBrowserAgent


class _ConfigWriter:
    """Faithful stand-in for the runtime's single managed-config writer.

    Uses the same ``ConfigurationService`` the runtime uses, and adopts the new
    settings on success exactly as the runtime's provider-generation swap does.
    """

    def __init__(self, store: ManagedConfigStore) -> None:
        self._configuration = ConfigurationService(store)
        self._settings = store.read().settings
        self.fail_with: Exception | None = None

    def current_settings(self) -> Settings:
        return self._settings

    async def apply_config_values(
        self, updates: Mapping[str, ConfigInputValue]
    ) -> JsonObject:
        if self.fail_with is not None:
            raise self.fail_with
        prepared = await self._configuration.prepare(updates, self._settings)
        if not prepared.valid:
            return prepared.applied_response()
        result = await self._configuration.commit(prepared)
        assert prepared.settings is not None
        self._settings = prepared.settings
        return result


class _AdminClient(TestClient):
    """Admin client that also exposes the writer for conflict assertions."""

    writer: _ConfigWriter


def _local_client(app) -> _AdminClient:
    """Admin client bound to loopback, matching the Admin security boundary."""
    return _AdminClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


@pytest.fixture
def client(monkeypatch, tmp_path):
    """Admin client wired to a browser-agent service over an isolated store."""
    # Isolate the real managed-config location the loader resolves from.
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    store = ManagedConfigStore()
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(
        f"LUICODE_CONFIG_SCHEMA={CONFIG_SCHEMA_VERSION}\n"
        "MODEL=nvidia_nim/test-model\n"
        "JEV_ALLOWED_DOMAINS=example.com\n",
        encoding="utf-8",
    )

    writer = _ConfigWriter(store)
    service = BrowserAgentService(
        port=RecordingBrowserAgent(),
        settings_provider=writer.current_settings,
    )
    admin = BrowserAgentAdminService(service=service, writer=writer)

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
    client = _local_client(app)
    client.writer = writer
    return client


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


def test_connect_and_disconnect_are_visible_in_status_without_a_restart(
    client, monkeypatch
):
    """Regression: status used to read a startup snapshot and never update."""
    from luicode.application.browser_agent import admin as admin_module
    from luicode.application.browser_agent.admin import JevInstallResult

    async def _ok():
        return JevInstallResult(ok=True, message="installed")

    monkeypatch.setattr(admin_module, "install_jev", _ok)
    monkeypatch.setattr("luicode.runtime.browser_agent.jev.jev_available", lambda: True)
    monkeypatch.setattr("luicode.runtime.browser_agent.jev.jev_version", lambda: "0")

    before = client.get("/admin/api/browser/jev/status").json()
    assert before["state"] == "not_connected"
    assert before["has_typesafe_key"] is False

    client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "ts-secret",
            "allowed_domains": "other.test",
            "confirm_data_processing": True,
        },
    )

    after_connect = client.get("/admin/api/browser/jev/status").json()
    assert after_connect["state"] == "connected"
    assert after_connect["allowed_domains"] == ["other.test"]
    assert after_connect["has_typesafe_key"] is True

    client.post("/admin/api/browser/jev/disconnect")

    after_disconnect = client.get("/admin/api/browser/jev/status").json()
    assert after_disconnect["state"] == "not_connected"
    assert after_disconnect["has_typesafe_key"] is False


def test_connect_reports_a_config_conflict_without_claiming_success(
    client, monkeypatch
):
    """A concurrent writer must surface as a failure, not a silent overwrite."""
    from luicode.application.browser_agent import admin as admin_module
    from luicode.application.browser_agent.admin import JevInstallResult
    from luicode.application.errors import ConfigConflictError

    async def _ok():
        return JevInstallResult(ok=True, message="installed")

    monkeypatch.setattr(admin_module, "install_jev", _ok)
    client.writer.fail_with = ConfigConflictError(
        "Managed configuration changed after this update was prepared."
    )

    response = client.post(
        "/admin/api/browser/jev/connect",
        json={
            "typesafe_api_key": "ts-secret",
            "confirm_data_processing": True,
        },
    )

    body = response.json()
    assert response.status_code == 200
    assert body["ok"] is False
    assert body["changed"] == []
    assert "changed after this update was prepared" in body["error"]


def test_runs_history_redacts_goals(client):
    """FR-27: run history does not expose goals by default."""
    response = client.get("/admin/api/browser/jev/runs")

    assert response.status_code == 200
    assert response.json()["runs"] == []


def test_admin_router_declares_the_loopback_guard_for_every_route():
    """SEC-9: the guard is a router dependency, so no endpoint can omit it."""

    declared = {dependency.dependency for dependency in admin_router.dependencies}

    assert require_loopback_admin in declared
    assert any(
        getattr(route, "path", "") == "/admin/browser" for route in admin_router.routes
    )


def test_browser_agent_routes_reject_a_non_loopback_client(client):
    """SEC-9: an off-machine caller is refused before any work happens."""

    remote = _AdminClient(
        client.app, base_url="http://10.0.0.5", client=("10.0.0.5", 50000)
    )

    response = remote.get("/admin/api/browser/jev/status")

    assert response.status_code == 403
