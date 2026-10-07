"""Local admin UI routes and APIs."""

import asyncio
from collections.abc import AsyncGenerator, Awaitable, Callable, Mapping
from pathlib import Path

import httpx
from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.sse import EventSourceResponse, ServerSentEvent
from loguru import logger
from pydantic import BaseModel, Field

from luicode.application.connected_accounts import (
    ConnectedAccountLoginMode,
)
from luicode.application.errors import ApplicationError
from luicode.application.model_catalog import read_model_catalog
from luicode.application.model_metadata import ProviderModelRefreshResult
from luicode.application.session_events import EventOverflowError
from luicode.config.admin.manifest import FIELD_BY_KEY
from luicode.config.provider_catalog import (
    PROVIDER_CATALOG,
    ProviderAuthKind,
    ProviderDescriptor,
)
from luicode.core.json_types import JsonObject, JsonValue
from luicode.core.version import package_version

from .admin_security import require_loopback_admin
from .dependencies import get_services
from .ports import ApiServices

router = APIRouter()

STATIC_DIR = Path(__file__).resolve().parent / "admin_static"
PACKAGE_ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"
_ADMIN_ASSET_VERSION_PLACEHOLDER = "__LUICODE_VERSION__"
_ADMIN_ASSET_MEDIA_TYPES = {
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}
_ADMIN_ASSET_FILENAMES = frozenset(
    {
        "admin.css",
        "admin.js",
        "form_controls.js",
        "app-icon.svg",
        "luicode-wordmark-dark.svg",
        "code_sessions.css",
        "code_sessions.js",
        "session_layout.css",
        "session_ui.js",
        "model_combobox.js",
        "usage.css",
        "usage.js",
        *(
            f"providers/{provider.logo_filename}"
            for provider in PROVIDER_CATALOG.values()
        ),
    }
)
LOCAL_PROVIDER_PATHS = {
    "lmstudio": "/models",
    "llamacpp": "/models",
    "ollama": "/api/tags",
}
_LOCAL_PROVIDER_CHECK_FAILURE_MESSAGE = (
    "Could not connect. Verify the URL and that the local provider is running."
)


class AdminConfigPayload(BaseModel):
    """Partial config update submitted by the admin UI."""

    values: JsonObject = Field(default_factory=dict)


class ConnectedAccountLoginPayload(BaseModel):
    """Interactive connected-account login selection."""

    mode: ConnectedAccountLoginMode | None = None


def _asset_path(filename: str) -> Path:
    asset_dir = PACKAGE_ASSETS_DIR if filename == "app-icon.svg" else STATIC_DIR
    path = asset_dir / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Admin asset not found")
    return path


def _asset_response(filename: str) -> FileResponse:
    path = _asset_path(filename)
    return FileResponse(path, media_type=_ADMIN_ASSET_MEDIA_TYPES[path.suffix])


def admin_page_response() -> HTMLResponse:
    template = _asset_path("index.html").read_text(encoding="utf-8")
    return HTMLResponse(
        template.replace(_ADMIN_ASSET_VERSION_PLACEHOLDER, package_version())
    )


@router.get("/admin", include_in_schema=False)
@router.get("/admin/model_config", include_in_schema=False)
@router.get("/admin/messaging", include_in_schema=False)
@router.get("/admin/usage", include_in_schema=False)
@router.get("/admin/integrations", include_in_schema=False)
def admin_page(request: Request):
    require_loopback_admin(request)
    return admin_page_response()


@router.get("/admin/assets/{version}/{filename:path}", include_in_schema=False)
async def admin_asset(version: str, filename: str, request: Request):
    require_loopback_admin(request)
    if version != package_version() or filename not in _ADMIN_ASSET_FILENAMES:
        raise HTTPException(status_code=404, detail="Admin asset not found")
    return _asset_response(filename)


@router.get("/admin/api/config")
async def get_admin_config(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await services.admin.admin_config()


@router.post("/admin/api/config/apply")
async def apply_admin_config(
    payload: AdminConfigPayload,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    result = await services.admin.apply_admin_config(_filtered_values(payload.values))
    return result


@router.get("/admin/api/status")
async def admin_status(
    request: Request,
    response: Response,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    # A local Admin page may reconnect after Apply changes the listening port.
    # The existing security check admits only loopback callers and origins.
    if origin := request.headers.get("origin"):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Vary"] = "Origin"
    return await services.admin.admin_status()


@router.get("/admin/api/providers/local-status")
async def local_provider_status(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    values = {
        key: entry.value or ""
        for key, entry in (await services.admin.admin_values()).items()
    }
    checks = await asyncio.gather(
        *(
            _check_local_provider(
                provider_id,
                _local_provider_url(provider_id, values),
                path,
            )
            for provider_id, path in LOCAL_PROVIDER_PATHS.items()
        )
    )
    return {"providers": checks}


@router.post("/admin/api/providers/{provider_id}/test")
async def test_provider(
    provider_id: str,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await services.admin.test_provider(provider_id)


@router.get("/admin/api/providers/{provider_id}/auth")
async def connected_account_status(
    provider_id: str,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    _require_connected_account_provider(provider_id)
    status = await services.admin.connected_account_status(provider_id)
    return _no_store(status.as_dict())


@router.post("/admin/api/providers/{provider_id}/auth/login")
async def start_connected_account_login(
    provider_id: str,
    payload: ConnectedAccountLoginPayload,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    _require_connected_account_provider(provider_id)
    account = await services.admin.connected_account_status(provider_id)
    mode = payload.mode or account.default_login_mode
    if mode not in account.supported_login_modes:
        raise HTTPException(
            status_code=422,
            detail="Login mode is not supported by this provider.",
        )
    try:
        status = await services.admin.start_connected_account_login(provider_id, mode)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=(f"Could not start connected-account login ({type(exc).__name__})."),
        ) from exc
    return _no_store(status.as_dict())


@router.post("/admin/api/providers/{provider_id}/auth/cancel")
async def cancel_connected_account_login(
    provider_id: str,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    _require_connected_account_provider(provider_id)
    status = await services.admin.cancel_connected_account_login(provider_id)
    return _no_store(status.as_dict())


@router.delete("/admin/api/providers/{provider_id}/auth")
async def disconnect_connected_account(
    provider_id: str,
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    _require_connected_account_provider(provider_id)
    status = await services.admin.disconnect_connected_account(provider_id)
    return _no_store(status.as_dict())


@router.get("/admin/api/models")
async def models(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return _model_options(services)


@router.get("/admin/api/integrations/claude-vscode")
async def claude_vscode_status(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.claude_vscode_status)


@router.post("/admin/api/integrations/claude-vscode/connect")
async def connect_claude_vscode(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.connect_claude_vscode)


@router.post("/admin/api/integrations/claude-vscode/refresh")
async def refresh_claude_vscode(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.refresh_claude_vscode)


@router.post("/admin/api/integrations/claude-vscode/disconnect")
async def disconnect_claude_vscode(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.disconnect_claude_vscode)


@router.get("/admin/api/integrations/claude-desktop")
async def claude_desktop_status(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.claude_desktop_status)


@router.post("/admin/api/integrations/claude-desktop/connect")
async def connect_claude_desktop(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.connect_claude_desktop)


@router.post("/admin/api/integrations/claude-desktop/disconnect")
async def disconnect_claude_desktop(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.disconnect_claude_desktop)


@router.post("/admin/api/integrations/claude-desktop/refresh")
async def refresh_claude_desktop(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.refresh_claude_desktop)


@router.get("/admin/api/integrations/jetbrains-acp")
async def jetbrains_acp_status(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.jetbrains_acp_status)


@router.post("/admin/api/integrations/jetbrains-acp/connect")
async def connect_jetbrains_acp(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.connect_jetbrains_acp)


@router.post("/admin/api/integrations/jetbrains-acp/disconnect")
async def disconnect_jetbrains_acp(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.disconnect_jetbrains_acp)


@router.post("/admin/api/integrations/jetbrains-acp/refresh")
async def refresh_jetbrains_acp(
    request: Request, services: ApiServices = Depends(get_services)
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.refresh_jetbrains_acp)


@router.get("/admin/api/integrations/codex")
async def codex_integration_status(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.codex_integration_status)


@router.post("/admin/api/integrations/codex/connect")
async def connect_codex(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.connect_codex)


@router.post("/admin/api/integrations/codex/refresh")
async def refresh_codex_integration(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.refresh_codex_integration)


@router.post("/admin/api/integrations/codex/disconnect")
async def disconnect_codex(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    return await _integration_response(services.admin.disconnect_codex)


async def _integration_response(
    operation: Callable[[], Awaitable[JsonObject]],
) -> JSONResponse:
    try:
        return _no_store(await operation())
    except ApplicationError as exc:
        return JSONResponse(
            {"detail": exc.message},
            status_code=exc.status_code,
            headers={"Cache-Control": "no-store"},
        )


@router.post("/admin/api/models/refresh")
async def refresh_models(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    result = await services.admin.refresh_models()
    return _model_options(services, refresh_result=result)


def _model_options(
    services: ApiServices,
    *,
    refresh_result: ProviderModelRefreshResult | None = None,
) -> dict[str, list[str]]:
    catalog = read_model_catalog(services.requests)
    failed_provider_ids = (
        refresh_result.failed_provider_ids if refresh_result is not None else ()
    )
    return {
        "models": [model.provider_model_ref for model in catalog.models],
        "failed_providers": list(failed_provider_ids),
    }


def _filtered_values(values: Mapping[str, JsonValue]) -> JsonObject:
    return {key: value for key, value in values.items() if key in FIELD_BY_KEY}


def _local_provider_url(provider_id: str, values: dict[str, str]) -> str:
    if provider_id == "lmstudio":
        return values.get("LM_STUDIO_BASE_URL", "")
    if provider_id == "llamacpp":
        return values.get("LLAMACPP_BASE_URL", "")
    if provider_id == "ollama":
        return values.get("OLLAMA_BASE_URL", "")
    return ""


async def _check_local_provider(
    provider_id: str, base_url: str, path: str
) -> JsonObject:
    clean_url = base_url.strip().rstrip("/")
    if not clean_url:
        return {
            "provider_id": provider_id,
            "status": "missing_url",
            "label": "Missing URL",
            "base_url": base_url,
        }

    url = f"{clean_url}{path}"
    try:
        async with httpx.AsyncClient(timeout=1.5) as client:
            response = await client.get(url)
        ok = 200 <= response.status_code < 300
        return {
            "provider_id": provider_id,
            "status": "reachable" if ok else "offline",
            "label": "Reachable" if ok else "Offline",
            "base_url": base_url,
            "status_code": response.status_code,
        }
    except Exception as exc:
        logger.debug(
            "Admin local provider check failed: provider={} exc_type={}",
            provider_id,
            type(exc).__name__,
        )
        return {
            "provider_id": provider_id,
            "status": "offline",
            "label": "Offline",
            "base_url": base_url,
            "message": _LOCAL_PROVIDER_CHECK_FAILURE_MESSAGE,
        }


def _require_connected_account_provider(provider_id: str) -> None:
    descriptor = PROVIDER_CATALOG.get(provider_id)
    if (
        descriptor is None
        or descriptor.auth_kind is not ProviderAuthKind.CONNECTED_ACCOUNT
    ):
        raise HTTPException(
            status_code=404,
            detail="Provider does not support connected-account login.",
        )


@router.get("/admin/api/usage/summary")
async def usage_summary(
    request: Request,
    services: ApiServices = Depends(get_services),
    since_hours: int = 24,
):
    require_loopback_admin(request)
    return _no_store(await services.admin.usage_summary(since_hours))


@router.get("/admin/api/usage/requests")
async def usage_requests(
    request: Request,
    services: ApiServices = Depends(get_services),
    limit: int = 100,
    offset: int = 0,
    since_hours: int = 24,
    provider_id: str | None = None,
    agent: str | None = None,
    outcome: str | None = None,
):
    require_loopback_admin(request)
    return _no_store(
        await services.admin.usage_requests(
            since_hours=since_hours,
            limit=limit,
            offset=offset,
            provider_id=provider_id,
            agent=agent,
            outcome=outcome,
        )
    )


@router.get("/admin/api/usage/optimizations")
async def usage_optimizations(
    request: Request,
    services: ApiServices = Depends(get_services),
    limit: int = 100,
    since_hours: int = 24,
    optimization: str | None = None,
):
    require_loopback_admin(request)
    return _no_store(
        await services.admin.usage_optimizations(
            since_hours=since_hours,
            limit=limit,
            optimization=optimization,
        )
    )


@router.get(
    "/admin/api/usage/events",
    response_class=EventSourceResponse,
    # The loopback check must run as a dependency: raising once the stream has
    # started cannot be converted into a 403 response.
    dependencies=[Depends(require_loopback_admin)],
)
async def usage_events(
    services: ApiServices = Depends(get_services),
) -> AsyncGenerator[ServerSentEvent]:
    """Stream committed usage writes so the Admin Usage tab can refresh live."""
    subscription = services.admin.subscribe_usage_events()
    try:
        yield ServerSentEvent(
            event="feed.ready",
            id=str(subscription.cursor),
            retry=1000,
            data={"cursor": subscription.cursor},
        )
        try:
            async for event in subscription:
                yield ServerSentEvent(
                    event=event.event,
                    id=str(event.id),
                    data={**event.data, "cursor": event.id},
                )
        except EventOverflowError as exc:
            # A slow observer must reconnect from an authoritative snapshot.
            yield ServerSentEvent(
                event="feed.resync_required",
                id=str(exc.cursor),
                data={"cursor": exc.cursor},
            )
    finally:
        await subscription.aclose()


@router.get("/admin/api/providers/health")
async def providers_health(
    request: Request,
    services: ApiServices = Depends(get_services),
):
    require_loopback_admin(request)
    lease = await services.requests.acquire()
    try:
        health_data = []
        for provider_id, descriptor in PROVIDER_CATALOG.items():
            # Only report providers the user has actually configured.
            if not descriptor.is_configured(lease.settings):
                continue
            try:
                provider = await lease.resolve_provider(provider_id)
            except Exception:
                health_data.append(_unconfigured_health(provider_id, descriptor))
                continue
            admission = getattr(provider, "admission_controller", lambda: None)()
            snapshot = getattr(admission, "health_snapshot", None)
            if snapshot is None:
                health_data.append(_unconfigured_health(provider_id, descriptor))
                continue
            entry = dict(snapshot())
            entry["display_name"] = descriptor.display_name
            health_data.append(entry)
        return _no_store({"providers": health_data})
    finally:
        await lease.release()


def _unconfigured_health(
    provider_id: str, descriptor: ProviderDescriptor
) -> JsonObject:
    """Return a placeholder health row for a provider with no live controller."""
    return {
        "provider_id": provider_id,
        "display_name": descriptor.display_name,
        "is_healthy": False,
        "success_rate": 0.0,
        "p50_latency_ms": None,
        "p95_latency_ms": None,
        "current_episode": "not_configured",
        "last_error": "Provider not configured",
        "last_success_ms": None,
        "rate_limit_remaining": None,
        "rate_limit_reset_ms": None,
        "concurrency_used": 0,
        "concurrency_limit": 5,
    }


def _no_store(payload: JsonValue) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})
