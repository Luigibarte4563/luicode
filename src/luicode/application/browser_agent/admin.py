"""Admin lifecycle for the delegated browser agent (connect, disconnect, status)."""

import asyncio
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass

from luicode.application.errors import ApplicationError
from luicode.config.admin.state import ConfigInputValue
from luicode.core.json_types import JsonObject

from .ports import ConfigValuesWriter
from .service import BrowserAgentService

_INSTALL_TIMEOUT_SECONDS = 180.0
_JEV_GIT_URL = "https://github.com/kitasota/jev-ultrafast.git"

_STATUS_NOT_CONNECTED = "not_connected"
_STATUS_CONNECTED = "connected"
_STATUS_ERROR = "error"

_REJECTED_DEFAULT_MESSAGE = "The browser-agent settings were rejected."


@dataclass
class JevInstallResult:
    ok: bool
    message: str


def _jev_available() -> bool:
    """Ask the runtime adapter that owns the Jev probe."""

    from luicode.runtime.browser_agent.jev import jev_available

    return jev_available()


async def install_jev() -> JevInstallResult:
    """Install the Jev package into the running environment (FR-8).

    Jev is not published to PyPI, so it installs from its git repository. The
    distribution name differs from the import name, which is why FR-8's literal
    ``pip install jev_ultrafast`` cannot work as written.
    """
    if _jev_available():
        return JevInstallResult(ok=True, message="Jev is already installed.")
    uv = shutil.which("uv")
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
    """Own browser-agent configuration state for the Admin API.

    Configuration changes go through ``writer`` so the runtime stays the single
    owner of the managed file, and status is read from the live settings rather
    than a startup snapshot.
    """

    def __init__(
        self,
        *,
        service: BrowserAgentService,
        writer: ConfigValuesWriter,
    ) -> None:
        self._service = service
        self._writer = writer
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

    async def _save(self, updates: Mapping[str, ConfigInputValue]) -> str | None:
        """Write through the runtime owner; return a user-facing error, if any."""

        try:
            result = await self._writer.apply_config_values(updates)
        except ApplicationError as error:
            return error.message
        except Exception as error:
            return f"Could not save the browser-agent settings: {type(error).__name__}"
        if result.get("applied"):
            return None
        errors = result.get("errors")
        if isinstance(errors, list) and errors:
            return "; ".join(str(item) for item in errors)
        return _REJECTED_DEFAULT_MESSAGE

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

            updates: dict[str, ConfigInputValue] = {
                "TYPESAFE_API_KEY": typesafe_api_key.strip(),
            }
            changed = ["TYPESAFE_API_KEY"]
            if text_model_api_key.strip():
                updates["TEXT_MODEL_API_KEY"] = text_model_api_key.strip()
                changed.append("TEXT_MODEL_API_KEY")
            updates["JEV_ALLOWED_DOMAINS"] = allowed_domains.strip()
            changed.append("JEV_ALLOWED_DOMAINS")
            updates["JEV_ENABLED"] = "true"
            changed.append("JEV_ENABLED")

            failure = await self._save(updates)
            if failure is not None:
                return {"ok": False, "error": failure, "changed": []}
            return {"ok": True, "changed": changed, "error": ""}

    async def disconnect(self) -> JsonObject:
        """Disable the feature and clear both keys, keeping the package (FR-10)."""
        async with self._lock:
            failure = await self._save(
                {
                    "JEV_ENABLED": "false",
                    "TYPESAFE_API_KEY": None,
                    "TEXT_MODEL_API_KEY": None,
                }
            )
            if failure is not None:
                return {"ok": False, "error": failure, "changed": []}
            return {"ok": True, "changed": ["JEV_ENABLED"], "error": ""}

    def stop(self) -> JsonObject:
        """Cancel any running task (SEC-10)."""
        cancelled = self._service.cancel()
        return {"ok": True, "cancelled": cancelled}

    def runs(self, *, include_goal: bool = False) -> JsonObject:
        return {"runs": self._service.recent_runs(include_goal=include_goal)}
