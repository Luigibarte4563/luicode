"""Support doubles for delegated browser-agent tests."""

from luicode.application.browser_agent.ports import BrowseTask
from luicode.core.browser_agent import (
    BrowseReason,
    BrowseRunResult,
    BrowseStatus,
)


class RecordingBrowserAgent:
    """Explicit Jev double: records tasks and returns scripted results."""

    def __init__(self, result: BrowseRunResult | None = None) -> None:
        self.result = result or BrowseRunResult(
            status=BrowseStatus.DONE,
            final_url="https://example.com/docs",
            title="Docs",
            text="Install with uv.",
            steps=4,
            elapsed_ms=1200,
        )
        self.tasks: list[BrowseTask] = []
        self.cancelled = 0

    async def run(self, task: BrowseTask, *, cancel_token: object | None = None):
        self.tasks.append(task)
        return self.result

    def cancel_running(self) -> bool:
        self.cancelled += 1
        return True


class ExplodingBrowserAgent:
    """Jev double that always fails, proving the session survives (NFR-3)."""

    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error or RuntimeError("Chrome went away")

    async def run(self, task: BrowseTask, *, cancel_token: object | None = None):
        raise self.error

    def cancel_running(self) -> bool:
        return True


def blocked_result(message: str = "not allowed") -> BrowseRunResult:
    return BrowseRunResult(
        status=BrowseStatus.BLOCKED,
        reason=BrowseReason.BLOCKED_DOMAIN,
        message=message,
    )
