"""Browser automation results shared by application operations and wire formatters."""

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class BrowserActionResult:
    """Result of a browser automation action."""
    action: str
    target: str | None
    success: bool
    message: str
    data: dict[str, Any] | None = None


@dataclass(frozen=True, slots=True)
class BrowserState:
    """Current browser state snapshot."""
    url: str
    title: str
    text: str
    elements: list[dict[str, Any]]
    fingerprint: str
