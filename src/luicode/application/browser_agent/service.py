"""Browser-agent workflow: policy, delegation, and run bookkeeping."""

import asyncio
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from luicode.application.errors import InvalidRequestError
from luicode.config.settings import Settings
from luicode.core.browser_agent import (
    BrowseReason,
    BrowseRunResult,
    BrowseStatus,
)
from luicode.core.json_types import JsonObject
from luicode.core.trace import trace_event

from .ports import BrowserAgentPort, BrowseTask


@dataclass(frozen=True, slots=True)
class BrowseDecision:
    """Policy outcome for one requested URL, resolved before Chrome is touched."""

    allowed: bool
    reason: BrowseReason | None = None
    message: str = ""


@dataclass
class BrowseRunRecord:
    """One delegated task retained for run history (FR-25, FR-26)."""

    request_id: str
    goal: str
    start_url: str
    status: str
    steps: int
    elapsed_ms: int
    reason: str | None = None


@dataclass
class BrowserAgentService:
    """Apply browse policy, delegate to Jev, and record every attempt."""

    port: BrowserAgentPort
    settings: Settings
    _records: list[BrowseRunRecord] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _running: bool = False

    @property
    def enabled(self) -> bool:
        return bool(self.settings.jev_enabled)

    def allowed_domains(self) -> tuple[str, ...]:
        raw = self.settings.jev_allowed_domains
        return tuple(
            part.strip().lower() for part in (raw or "").split(",") if part.strip()
        )

    def check_url(self, url: str) -> BrowseDecision:
        """Validate scheme and allowlist before any browser work (SEC-3/4/5).

        This check is deliberately string-only: it never resolves DNS. The
        allowlist is the authoritative gate, and Jev drives a real Chrome that
        performs its own resolution, so a lookup here would add request-path
        latency (NFR-1) and race the browser's own resolution rather than
        constrain it.
        """
        scheme = (urlsplit(url).scheme or "").lower()
        permitted = {
            part.strip().lower()
            for part in self.settings.web_fetch_allowed_schemes.split(",")
            if part.strip()
        }
        if scheme not in permitted:
            return BrowseDecision(
                allowed=False,
                reason=BrowseReason.BLOCKED_DOMAIN,
                message=(
                    f"URL scheme {scheme!r} is not allowed for browse_web. "
                    "Only http and https are accepted."
                ),
            )

        host = _hostname(url)
        if host is None:
            return BrowseDecision(
                allowed=False,
                reason=BrowseReason.BLOCKED_DOMAIN,
                message="browse_web requires a URL with a host.",
            )

        allowed = self.allowed_domains()
        if not allowed:
            # Empty allowlist: every domain needs explicit approval (SEC-3).
            return BrowseDecision(
                allowed=False,
                reason=BrowseReason.BLOCKED_DOMAIN,
                message=(
                    "No browse allowlist is configured. Approve this domain in the "
                    "Admin Browser Agent tab before browsing it."
                ),
            )
        if not _host_in_domains(host, allowed):
            return BrowseDecision(
                allowed=False,
                reason=BrowseReason.BLOCKED_DOMAIN,
                message=(
                    f"{host} is not in the browse allowlist. Add it in the Admin "
                    "Browser Agent tab to allow this domain."
                ),
            )

        # SEC-4: private and loopback hosts are reachable only because the user
        # listed them explicitly, which is what keeps local testing possible.
        return BrowseDecision(allowed=True)

    async def run(self, *, url: str, goal: str, request_id: str) -> BrowseRunResult:
        """Execute one delegated task under a single-flight lock (FR-17)."""
        decision = self.check_url(url)
        if not decision.allowed:
            result = BrowseRunResult(
                status=BrowseStatus.BLOCKED,
                final_url=url,
                reason=decision.reason,
                message=decision.message,
            )
            self._record(request_id, goal, url, result)
            trace_event(
                stage="execution",
                event="luicode.browser_agent.blocked",
                source="api",
                request_id=request_id,
                reason=decision.reason.value if decision.reason else None,
            )
            return result

        async with self._lock:
            if self._running:
                result = BrowseRunResult(
                    status=BrowseStatus.ERROR,
                    reason=BrowseReason.BUSY,
                    message="Another browse task is already running in this Chrome profile.",
                )
                self._record(request_id, goal, url, result)
                return result
            self._running = True
        try:
            result = await asyncio.wait_for(
                self.port.run(BrowseTask(url=url, goal=goal)),
                timeout=max(1, self.settings.jev_timeout_seconds),
            )
        except TimeoutError:
            result = BrowseRunResult(
                status=BrowseStatus.TIMEOUT,
                reason=BrowseReason.TIMEOUT,
                message=(
                    f"browse_web exceeded its {self.settings.jev_timeout_seconds}s "
                    "time limit."
                ),
            )
        except asyncio.CancelledError:
            self.port.cancel_running()
            raise
        except Exception as error:  # Jev failure must not kill the session (NFR-3).
            result = BrowseRunResult(
                status=BrowseStatus.ERROR,
                reason=BrowseReason.JEV_ERROR,
                message=f"browse_web failed: {type(error).__name__}",
            )
        finally:
            async with self._lock:
                self._running = False

        self._record(request_id, goal, url, result)
        return result

    def cancel(self) -> bool:
        return self.port.cancel_running()

    def _record(
        self, request_id: str, goal: str, url: str, result: BrowseRunResult
    ) -> None:
        self._records.append(
            BrowseRunRecord(
                request_id=request_id,
                goal=goal,
                start_url=url,
                status=result.status.value,
                steps=result.steps,
                elapsed_ms=result.elapsed_ms,
                reason=result.reason.value if result.reason else None,
            )
        )
        del self._records[:-200]

    def recent_runs(self, *, include_goal: bool = False) -> list[JsonObject]:
        """Return run history; goals stay redacted unless explicitly requested (FR-27)."""
        runs: list[JsonObject] = []
        for record in reversed(self._records):
            entry: JsonObject = {
                "request_id": record.request_id,
                "goal": record.goal if include_goal else "<redacted>",
                "start_url": record.start_url,
                "status": record.status,
                "steps": record.steps,
                "elapsed_ms": record.elapsed_ms,
                "reason": record.reason,
            }
            runs.append(entry)
        return runs


def _hostname(url: str) -> str | None:
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    if not host:
        return None
    try:
        return host.encode("idna").decode("ascii").lower()
    except UnicodeError:
        return None


def _host_in_domains(host: str, domains: tuple[str, ...]) -> bool:
    return any(host == domain or host.endswith(f".{domain}") for domain in domains)


def require_browsable_url(goal: str, url: str) -> None:
    """Validate the tool's own arguments before any delegation."""
    if not url or not url.strip():
        raise InvalidRequestError("browse_web requires a url.")
    if not goal or not goal.strip():
        raise InvalidRequestError("browse_web requires a goal.")
