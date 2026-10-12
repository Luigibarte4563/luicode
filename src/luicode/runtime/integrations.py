"""Shared execution shape for the editable coding-agent integrations.

Each integration edits one tool's configuration file through its harness module,
so they differ only in the file they touch and the errors that file can raise.
The lock, availability check, worker hop, error mapping, and status bookkeeping
live here once instead of in four near-identical handlers.

Codex keeps its own path: it must wait for a model-catalog generation before it
writes, which this sync shape does not model.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from luicode.application.errors import (
    ApplicationError,
    ApplicationUnavailableError,
    InvalidRequestError,
)
from luicode.config.paths import claude_desktop_disconnect_path
from luicode.config.server_urls import local_proxy_root_url
from luicode.config.settings import Settings
from luicode.core.json_types import JsonObject
from luicode.harnesses import (
    claude_desktop_integration,
    claude_integration,
    jetbrains_acp_integration,
)

type IntegrationAction = Literal["status", "connect", "disconnect", "refresh"]
"""The four operations every integration exposes."""

_MANAGED_DESKTOP_MESSAGE = (
    "Claude Desktop is managed by an organization, or its policy could not be "
    "read. LUICODE can configure only unmanaged Desktop installations."
)
_DESKTOP_JSON_MESSAGE = (
    "Could not configure Claude Desktop. Check its configuration JSON and "
    "LUICODE disconnect record, and ensure LUICODE uses a localhost address and "
    "a nonempty managed token."
)
_DESKTOP_FILES_MESSAGE = (
    "Could not access Claude Desktop settings or the LUICODE disconnect record. "
    "Fully quit Claude Desktop, check file permissions, and retry."
)
_VSCODE_JSON_MESSAGE = (
    "Could not read Claude integration settings. Check the JSON in VS Code "
    "settings.json and .claude.json."
)
_VSCODE_FILES_MESSAGE = (
    "Could not access VS Code settings.json or .claude.json. Check file "
    "permissions and try again."
)
_JETBRAINS_JSON_MESSAGE = (
    "Could not read JetBrains ACP configuration. Check the JSON in acp.json and "
    "the installed Claude Agent metadata."
)
_JETBRAINS_FILES_MESSAGE = (
    "Could not access JetBrains ACP files. Finish any configuration edits, check "
    "file permissions, and retry."
)


@dataclass
class IntegrationUpdate:
    """Progress of one background integration refresh."""

    state: Literal["starting", "ready", "failed"] = "ready"
    changed: bool = False
    message: str | None = None
    task: asyncio.Task[None] | None = None

    def snapshot(self) -> JsonObject:
        return {"state": self.state, "changed": self.changed, "message": self.message}

    def complete(self, changed: bool = False) -> None:
        self.state = "ready"
        self.changed = changed
        self.message = None


@dataclass(frozen=True, slots=True)
class ErrorResponse:
    """One ordered exception-to-response rule for an integration."""

    exceptions: tuple[type[Exception], ...]
    message: str | Callable[[Exception], str]
    error: type[ApplicationError] = InvalidRequestError

    def for_error(self, error: Exception) -> ApplicationError:
        text = self.message if isinstance(self.message, str) else self.message(error)
        return self.error(text)


IntegrationOperate = Callable[
    [IntegrationAction, Settings, IntegrationUpdate], JsonObject
]
IntegrationStatusHook = Callable[[JsonObject, IntegrationUpdate], None]


@dataclass(frozen=True, slots=True)
class IntegrationOperations:
    """One integration's synchronous operation, error rules, and status hook."""

    operate: IntegrationOperate
    errors: tuple[ErrorResponse, ...] = ()
    finalize_status: IntegrationStatusHook | None = None

    def translate(self, error: Exception) -> ApplicationError | None:
        """Return the response for a failed operation, or None when unmapped."""

        for rule in self.errors:
            if isinstance(error, rule.exceptions):
                return rule.for_error(error)
        return None


def _vscode_operate(
    action: IntegrationAction, settings: Settings, update: IntegrationUpdate
) -> JsonObject:
    path = claude_integration.settings_path()
    state_path = claude_integration.claude_state_path()
    if action == "status" and update.state != "ready":
        return {
            "connected": None,
            "paths": {
                "vscode_settings": str(path.resolve()),
                "claude_state": str(state_path.resolve()),
            },
        }
    url = local_proxy_root_url(settings)
    if action == "refresh":
        return {
            "changed": claude_integration.refresh_connected(
                path, state_path, url, settings.proxy_auth_token
            )
        }
    return claude_integration.configure(
        path,
        state_path,
        url,
        settings.proxy_auth_token,
        None if action == "status" else action == "connect",
    )


def _desktop_operate(
    action: IntegrationAction, settings: Settings, update: IntegrationUpdate
) -> JsonObject:
    root = claude_desktop_integration.config_root()
    url = local_proxy_root_url(settings)
    if action == "refresh":
        return {
            "changed": claude_desktop_integration.refresh_connected(
                root,
                url,
                settings.proxy_auth_token,
                disconnect_path=claude_desktop_disconnect_path(),
            )
        }
    return claude_desktop_integration.configure(
        root,
        url,
        settings.proxy_auth_token,
        None if action == "status" else action == "connect",
        disconnect_path=claude_desktop_disconnect_path(),
    )


def _desktop_finalize_status(result: JsonObject, update: IntegrationUpdate) -> None:
    # A refresh in flight makes the connect state unknowable, not false.
    if update.state != "ready":
        result["connected"] = None


def _jetbrains_operate(
    action: IntegrationAction, settings: Settings, update: IntegrationUpdate
) -> JsonObject:
    del update  # JetBrains ACP has no starting state to report.
    path = jetbrains_acp_integration.config_path()
    url = local_proxy_root_url(settings)
    if action == "refresh":
        return {
            "changed": jetbrains_acp_integration.refresh_connected(
                path, url, settings.proxy_auth_token
            )
        }
    return jetbrains_acp_integration.configure(
        path,
        url,
        settings.proxy_auth_token,
        None if action == "status" else action == "connect",
    )


VSCODE_OPERATIONS = IntegrationOperations(
    operate=_vscode_operate,
    errors=(
        ErrorResponse((ValueError, UnicodeError), _VSCODE_JSON_MESSAGE),
        ErrorResponse((OSError,), _VSCODE_FILES_MESSAGE, ApplicationUnavailableError),
    ),
)

DESKTOP_OPERATIONS = IntegrationOperations(
    operate=_desktop_operate,
    errors=(
        ErrorResponse(
            (claude_desktop_integration.ManagedDesktopError,),
            _MANAGED_DESKTOP_MESSAGE,
        ),
        ErrorResponse(
            (claude_desktop_integration.PendingDisconnectError,),
            "Finish disconnecting Claude Desktop before connecting again.",
        ),
        ErrorResponse(
            (claude_desktop_integration.PendingMigrationError,),
            "Claude Desktop has data in its previous Windows location. Launch "
            "Claude Desktop once so it can migrate that data, fully quit it, "
            "then retry Connect.",
        ),
        ErrorResponse((ValueError, UnicodeError), _DESKTOP_JSON_MESSAGE),
        ErrorResponse((OSError,), _DESKTOP_FILES_MESSAGE, ApplicationUnavailableError),
    ),
    finalize_status=_desktop_finalize_status,
)

JETBRAINS_OPERATIONS = IntegrationOperations(
    operate=_jetbrains_operate,
    errors=(
        ErrorResponse(
            (jetbrains_acp_integration.SetupError,), lambda error: str(error)
        ),
        ErrorResponse((ValueError, UnicodeError), _JETBRAINS_JSON_MESSAGE),
        ErrorResponse(
            (OSError,), _JETBRAINS_FILES_MESSAGE, ApplicationUnavailableError
        ),
    ),
)
