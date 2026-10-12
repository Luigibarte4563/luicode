"""Wire contracts for the Admin API that the browser client reads by key.

The Admin UI is plain JavaScript that reads these responses by property name, so
a rename in a Python payload silently breaks the page. These assertions pin the
key sets, and they fail on both a rename and an accidental addition.
"""

import pytest
from fastapi.testclient import TestClient

from tests.api.support import create_test_app


@pytest.fixture
def client() -> TestClient:
    app = create_test_app()
    return TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000))


def _get(client: TestClient, path: str) -> dict:
    response = client.get(path)
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, dict)
    return body


def test_status_payload_shape(client: TestClient) -> None:
    body = _get(client, "/admin/api/status")

    assert sorted(body) == [
        "cached_models",
        "host",
        "instance_id",
        "model",
        "pending_fields",
        "port",
        "provider",
        "provider_status",
        "startup",
        "status",
    ]
    assert sorted(body["startup"]) == [
        "catalog",
        "catalog_file",
        "catalog_revision",
        "code",
        "generation_id",
        "integrations",
        "messaging",
        "providers",
    ]
    assert sorted(body["startup"]["integrations"]) == [
        "claude-desktop",
        "claude-vscode",
        "codex",
        "jetbrains-acp",
    ]
    for integration in body["startup"]["integrations"].values():
        assert sorted(integration) == ["changed", "message", "state"]


def test_config_payload_shape(client: TestClient) -> None:
    body = _get(client, "/admin/api/config")

    assert sorted(body) == ["fields", "paths", "provider_status", "sections"]
    assert sorted(body["paths"]) == ["managed"]
    assert sorted(body["sections"][0]) == ["advanced", "description", "id", "label"]
    assert sorted(body["fields"][0]) == [
        "advanced",
        "configured",
        "description",
        "key",
        "label",
        "locked",
        "nullable",
        "options",
        "restart_required",
        "secret",
        "section",
        "session_sensitive",
        "source",
        "type",
        "value",
    ]


def test_models_payload_shape(client: TestClient) -> None:
    body = _get(client, "/admin/api/models")

    assert sorted(body) == ["failed_providers", "models"]
    assert isinstance(body["models"], list)
    assert isinstance(body["failed_providers"], list)


def test_usage_payload_shapes(client: TestClient) -> None:
    summary = _get(client, "/admin/api/usage/summary")
    requests = _get(client, "/admin/api/usage/requests")
    optimizations = _get(client, "/admin/api/usage/optimizations")

    assert sorted(summary) == [
        "by_agent",
        "by_optimization",
        "by_provider",
        "timeseries",
        "totals",
    ]
    assert sorted(summary["totals"]) == [
        "agents_used",
        "providers_used",
        "total_cost",
        "total_input",
        "total_output",
        "total_requests",
    ]
    assert sorted(requests) == ["limit", "offset", "requests"]
    assert sorted(optimizations) == ["limit", "optimizations"]


def test_rejected_apply_payload_shape(client: TestClient) -> None:
    """The form reads these keys to render inline validation errors."""

    response = client.post(
        "/admin/api/config/apply", json={"values": {"PORT": "not-a-port"}}
    )

    assert response.status_code == 200
    body = response.json()
    assert sorted(body) == [
        "applied",
        "credential_checks",
        "env_preview",
        "errors",
        "pending_fields",
        "valid",
    ]
    assert body["applied"] is False
    assert body["valid"] is False
    assert body["errors"]
