"""Admin lifecycle for the delegated browser agent (connect, disconnect, status)."""

import asyncio
import shutil
import subprocess
import sys
from dataclasses import dataclass

from luicode.config.loader import ManagedConfigStore, clear_settings_cache
from luicode.core.json_types import JsonObject

from ..browser_agent.service import BrowserAgentService

_INSTALL_TIMEOUT_SECONDS = 180.0
_JEV_DISTRIBUTION = "jev-ultrafast"
_JEV_GIT_URL = "https://github.com/kitasota/jev-ultrafast.git"

_STATUS_NOT_CONNECTED = "not_connected"
_STATUS_CONNECTED = "connected"
_STATUS_ERROR = "error"


@dataclass
class JevInstallResult:
    ok: bool
    message: str


def _uv_executable() -> str | None:
    """Return the uv binary, or None with an actionable explanation."""
    found = shutil.which("uv")
    if found:
        return found
    from luicode.runtime.browser_agent.jev import jev_available

    if jev_available():
        # Already importable, so a missing uv is not a blocker.
        return None
    return None


async def install_jev() -> JevInstallResult:
    """Install the Jev package into the running environment (FR-8).

    Jev is not published to PyPI, so it installs from its git repository. The
    distribution name differs from the import name, which is why FR-8's literal
    ``pip install jev_ultrafast`` cannot work as written.
    """
    uv = _uv_executable()
    if uv is None:
        return JevInstallResult(
            ok=False,
            message=(
                "uv was not found on PATH, and Jev is not installed. Install uv "
                "(https://docs.astral.sh/uv/) and run Connect again."
            ),
        )
    command = [
        uv,
        "pip",
        "install",
        "--python",
        sys.executable,
        f"git+{_JEV_GIT_URL}",
    ]
    try:
        completed = await asyncio.to_thread(
            subprocess.run,
            command,
            capture_output=True,
            text=True,
            timeout=_INSTALL_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return JevInstallResult(
            ok=False,
            message="Installing Jev timed out. Check your network and try again.",
        )
    except OSError as error:
        return JevInstallResult(
            ok=False, message=f"Could not start uv: {type(error).__name__}"
        )

    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip().splitlines()
        tail = detail[-1] if detail else "unknown error"
        return JevInstallResult(ok=False, message=f"Installing Jev failed: {tail}")
    return JevInstallResult(ok=True, message="Jev installed.")


class BrowserAgentAdminService:
    """Own browser-agent configuration state for the Admin API."""

    def __init__(
        self,
        *,
        store: ManagedConfigStore,
        service: BrowserAgentService,
    ) -> None:
        self._store = store
        self._service = service
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ status

    def status(self) -> JsonObject:
        from luicode.runtime.browser_agent.jev import jev_available, jev_version

        settings = self._service.settings
        installed = jev_available()
        if not settings.jev_enabled:
            state = _STATUS_NOT_CONNECTED
            detail = ""
        elif not installed:
            state = _STATUS_ERROR
            detail = "Jev is enabled but not installed. Run Connect again."
        elif not settings.typesafe_api_key:
            state = _STATUS_ERROR
            detail = "The TypeSafe key is missing. Run Connect again."
        else:
            state = _STATUS_CONNECTED
            detail = ""
        return {
            "state": state,
            "detail": detail,
            "installed": installed,
            "version": jev_version(),
            "text_model": settings.jev_text_model,
            "allowed_domains": list(self._service.allowed_domains()),
            "max_steps": settings.jev_max_steps,
            "timeout_seconds": settings.jev_timeout_seconds,
            "dedicated_profile": settings.jev_dedicated_profile,
            "has_typesafe_key": bool(settings.typesafe_api_key),
            "has_text_model_key": bool(settings.text_model_api_key),
        }

    def chrome_status(self) -> JsonObject:
        """Report whether browser-harness can reach a Chrome instance (FR-11)."""
        try:
            from browser_harness.admin import ensure_daemon
        except ImportError:
            return {
                "available": False,
                "detail": "browser-harness is not installed (uv sync --extra browser).",
            }
        try:
            ensure_daemon()
        except Exception as error:
            return {
                "available": False,
                "detail": f"Chrome is not reachable: {type(error).__name__}",
            }
        return {"available": True, "detail": ""}

    # ----------------------------------------------------------------- connect

    def _read_managed(self) -> dict[str, str]:
        return dict(self._store.read().managed)

    def _commit(self, values: dict[str, str]) -> None:
        self._store.commit(values)
        clear_settings_cache()

    async def connect(
        self,
        *,
        typesafe_api_key: str,
        text_model_api_key: str,
        allowed_domains: str,
    ) -> JsonObject:
        """Install if needed, then save keys and enable the feature (FR-8).

        Validation happens before any write so a failure leaves nothing
        half-configured (FR-9).
        """
        async with self._lock:
            if not typesafe_api_key.strip():
                return {
                    "ok": False,
                    "error": "A TypeSafe API key is required.",
                    "changed": [],
                }

            installed = await install_jev()
            if not installed.ok:
                return {"ok": False, "error": installed.message, "changed": []}

            changed: list[str] = []
            values = self._read_managed()
            values["TYPESAFE_API_KEY"] = typesafe_api_key.strip()
            changed.append("TYPESAFE_API_KEY")
            if text_model_api_key.strip():
                values["TEXT_MODEL_API_KEY"] = text_model_api_key.strip()
                changed.append("TEXT_MODEL_API_KEY")
            else:
                values.setdefault("TEXT_MODEL_API_KEY", "")
            values["JEV_ALLOWED_DOMAINS"] = allowed_domains.strip()
            changed.append("JEV_ALLOWED_DOMAINS")
            values["JEV_ENABLED"] = "true"
            changed.append("JEV_ENABLED")

            try:
                self._commit(values)
            except Exception as error:
                return {
                    "ok": False,
                    "error": f"Could not save the browser-agent settings: {type(error).__name__}",
                    "changed": [],
                }
            return {"ok": True, "changed": changed, "error": ""}

    async def disconnect(self) -> JsonObject:
        """Disable the feature and clear both keys, keeping the package (FR-10)."""
        async with self._lock:
            values = self._read_managed()
            values["JEV_ENABLED"] = "false"
            values.pop("TYPESAFE_API_KEY", None)
            values.pop("TEXT_MODEL_API_KEY", None)
            self._commit(values)
            return {"ok": True, "changed": ["JEV_ENABLED"]}

    def stop(self) -> JsonObject:
        """Cancel any running task (SEC-10)."""
        cancelled = self._service.cancel()
        return {"ok": True, "cancelled": cancelled}

    def runs(self, *, include_goal: bool = False) -> JsonObject:
        return {"runs": self._service.recent_runs(include_goal=include_goal)}
