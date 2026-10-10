"""Outbound capability for delegated browser-agent tasks."""

from dataclasses import dataclass
from typing import Protocol

from luicode.core.browser_agent import BrowseRunResult


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
