"""Outbound capabilities consumed by the browser automation workflow."""

from dataclasses import dataclass
from typing import Any, Protocol

from luicode.core.browser_tools import BrowserActionResult, BrowserState


@dataclass(frozen=True, slots=True)
class BrowserAutomationConfig:
    """Configuration for browser automation."""
    headless: bool = False
    default_timeout: float = 30.0
    screenshot_on_error: bool = False


class BrowserToolsPort(Protocol):
    """Browser automation operations."""

    async def navigate(self, url: str) -> BrowserActionResult: ...

    async def observe(self) -> BrowserState: ...

    async def click(self, node_id: int) -> BrowserActionResult: ...

    async def fill(self, node_id: int, text: str) -> BrowserActionResult: ...

    async def select(self, node_id: int, value: str) -> BrowserActionResult: ...

    async def scroll(self, delta: int) -> BrowserActionResult: ...

    async def wait(self, timeout: float = 2.0) -> BrowserActionResult: ...

    async def close(self) -> None: ...

    async def run_task(self, steps: list[dict[str, Any]]) -> list[BrowserActionResult]: ...
