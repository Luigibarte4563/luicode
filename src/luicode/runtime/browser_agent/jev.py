"""Blocking Jev Ultrafast runner executed off the async request path.

Jev is synchronous: it drives CDP through ``browser_harness`` and polls with
``time.sleep``. It therefore runs in a worker thread so the event loop and the
agent session stay responsive (NFR-4), and every failure mode is converted into
a result rather than an exception (NFR-3).
"""

import asyncio
import contextlib
import importlib
import os
import threading
import time
from dataclasses import dataclass
from dataclasses import field as dataclass_field

from luicode.application.browser_agent.ports import BrowseTask
from luicode.core.browser_agent import (
    BrowseReason,
    BrowseRunResult,
    BrowseStatus,
)
from luicode.core.trace import trace_event

_JEV_MODULE = "jev_ultrafast"
_MAX_PAGE_TEXT_CHARS = 24_000


@dataclass
class _RunState:
    """Mutable handle shared between the worker thread and the cancel path."""

    cancel: threading.Event = dataclass_field(default_factory=threading.Event)


def jev_available() -> bool:
    """Whether the Jev package can be imported in this environment."""
    try:
        importlib.import_module(_JEV_MODULE)
    except Exception:
        return False
    return True


def jev_version() -> str:
    """Return the installed Jev version, or an empty string when absent."""
    try:
        from importlib.metadata import version

        return version("jev-ultrafast")
    except Exception:
        return ""


class JevBrowserAgent:
    """Run Jev tasks in a worker thread with hard caps and cooperative cancel."""

    def __init__(
        self,
        *,
        typesafe_api_key: str | None,
        text_model_api_key: str | None,
        text_model: str,
        max_steps: int,
        dedicated_profile: bool = True,
    ) -> None:
        self._typesafe_api_key = typesafe_api_key or ""
        self._text_model_api_key = text_model_api_key or ""
        self._text_model = text_model
        self._max_steps = max(1, int(max_steps))
        self._dedicated_profile = dedicated_profile
        self._state: _RunState | None = None
        self._guard = threading.Lock()

    # ------------------------------------------------------------------ public

    async def run(
        self, task: BrowseTask, *, cancel_token: object | None = None
    ) -> BrowseRunResult:
        """Delegate one task to a worker thread."""
        state = _RunState()
        with self._guard:
            self._state = state
        try:
            return await asyncio.to_thread(self._run_blocking, task, state)
        finally:
            with self._guard:
                self._state = None

    def cancel_running(self) -> bool:
        """Request cancellation of the active task (SEC-10)."""
        with self._guard:
            state = self._state
        if state is None:
            return False
        state.cancel.set()
        return True

    # ----------------------------------------------------------------- private

    def _run_blocking(self, task: BrowseTask, state: _RunState) -> BrowseRunResult:
        started = time.perf_counter()
        if not jev_available():
            return self._finish(
                BrowseRunResult(
                    status=BrowseStatus.ERROR,
                    reason=BrowseReason.NOT_INSTALLED,
                    message=(
                        "Jev Ultrafast is not installed. Use Connect in the Admin "
                        "Browser Agent tab to install it."
                    ),
                ),
                started,
            )

        self._apply_environment()
        agent_module = importlib.import_module(f"{_JEV_MODULE}.agent")
        agent = None
        try:
            agent = agent_module.Agent(task.url, task.goal)
            steps = 0
            last = None
            for last in agent.run():
                steps += 1
                if state.cancel.is_set():
                    return self._finish(
                        BrowseRunResult(
                            status=BrowseStatus.ERROR,
                            final_url=_page_url(last),
                            title=_page_title(last),
                            steps=steps,
                            reason=BrowseReason.CANCELLED,
                            message="browse_web was cancelled.",
                        ),
                        started,
                    )
                if steps >= self._max_steps:
                    return self._finish(
                        BrowseRunResult(
                            status=BrowseStatus.TIMEOUT,
                            final_url=_page_url(last),
                            title=_page_title(last),
                            steps=steps,
                            reason=BrowseReason.TIMEOUT,
                            message=(
                                f"browse_web reached its {self._max_steps} step limit."
                            ),
                        ),
                        started,
                    )
        except Exception as error:
            return self._finish(
                BrowseRunResult(
                    status=BrowseStatus.ERROR,
                    reason=_reason_for(error),
                    message=f"browse_web failed: {type(error).__name__}",
                ),
                started,
            )
        finally:
            _close_quietly(agent)

        status = _status_from(getattr(last, "get", lambda _k: None)("status"))
        text = _page_text(last)
        return self._finish(
            BrowseRunResult(
                status=status,
                final_url=_page_url(last),
                title=_page_title(last),
                text=text,
                steps=steps,
                reason=None if status is BrowseStatus.DONE else BrowseReason.JEV_ERROR,
                message=""
                if status is BrowseStatus.DONE
                else "Jev could not finish the task.",
            ),
            started,
        )

    def _apply_environment(self) -> None:
        """Expose the configured keys under the names Jev reads."""
        if self._typesafe_api_key:
            os.environ["TYPESAFE_API_KEY"] = self._typesafe_api_key
        if self._text_model_api_key:
            os.environ["TEXT_MODEL_API_KEY"] = self._text_model_api_key
        if self._text_model:
            os.environ["TEXT_MODEL"] = self._text_model
        # A dedicated profile keeps Jev out of the user's logged-in sessions (SEC-6).
        if self._dedicated_profile:
            os.environ.setdefault("JEV_DEDICATED_PROFILE", "1")

    def _finish(self, result: BrowseRunResult, started: float) -> BrowseRunResult:
        elapsed = int((time.perf_counter() - started) * 1000)
        trace_event(
            stage="execution",
            event="luicode.browser_agent.completed",
            source="api",
            status=result.status.value,
            steps=result.steps,
            elapsed_ms=elapsed,
            reason=result.reason.value if result.reason else None,
        )
        return BrowseRunResult(
            status=result.status,
            final_url=result.final_url,
            title=result.title,
            text=result.text,
            steps=result.steps,
            elapsed_ms=elapsed,
            reason=result.reason,
            message=result.message,
        )


def _close_quietly(agent: object | None) -> None:
    close = getattr(agent, "close", None)
    if callable(close):
        with contextlib.suppress(Exception):
            close()


def _page_url(state: object) -> str:
    page = _page(state)
    url = page.get("url") if isinstance(page, dict) else None
    return url if isinstance(url, str) else ""


def _page_title(state: object) -> str:
    page = _page(state)
    title = page.get("title") if isinstance(page, dict) else None
    return title if isinstance(title, str) else ""


def _page_text(state: object) -> str:
    page = _page(state)
    if not isinstance(page, dict):
        return ""
    for key in ("text", "content", "innerText"):
        value = page.get(key)
        if isinstance(value, str) and value:
            return value[:_MAX_PAGE_TEXT_CHARS]
    return ""


def _page(state: object) -> object:
    if isinstance(state, dict):
        return state.get("page")
    return getattr(state, "page", None)


def _status_from(raw: object) -> BrowseStatus:
    if raw == "done":
        return BrowseStatus.DONE
    if raw == "blocked":
        return BrowseStatus.BLOCKED
    return BrowseStatus.ERROR


def _reason_for(error: BaseException) -> BrowseReason:
    name = type(error).__name__
    message = str(error).lower()
    if "key" in message or "auth" in message or "401" in message or "403" in message:
        return BrowseReason.KEY_INVALID
    if "chrome" in message or "cdp" in message or "browser" in message:
        return BrowseReason.NO_CHROME
    if name in {"ConnectionError", "ConnectError", "TimeoutError"}:
        return BrowseReason.NO_CHROME
    return BrowseReason.JEV_ERROR
