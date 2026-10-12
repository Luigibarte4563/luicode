"""Outbound capability for delegated browser-agent tasks."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol

from luicode.config.admin.state import ConfigInputValue
from luicode.core.browser_agent import BrowseRunResult
from luicode.core.json_types import JsonObject


@dataclass(frozen=True, slots=True)
class BrowseTask:
    """One bounded delegation: start at ``url`` and pursue ``goal``."""

    url: str
    goal: str


class BrowserAgentPort(Protocol):
    """Run one browse task to completion, in a worker thread."""

    async def run(
        self, task: BrowseTask, *, cancel_token: object | None = None
    ) -> BrowseRunResult: ...

    def cancel_running(self) -> bool: ...


class ConfigValuesWriter(Protocol):
    """Apply a config update through the runtime's managed-config owner.

    The Admin card must not write the managed file itself: one owner serializes
    every write and lets the running resources adopt the change.
    """

    async def apply_config_values(
        self, updates: Mapping[str, ConfigInputValue]
    ) -> JsonObject: ...
