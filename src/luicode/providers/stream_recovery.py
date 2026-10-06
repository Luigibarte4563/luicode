"""Provider-owned stream holdback and recovery decisions."""

import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum

from .failure_policy import RetryableProviderProtocolError

EARLY_HOLDBACK_SECONDS = 0.75
RECOVERY_BUFFER_MAX_BYTES = 65_536
DEFAULT_HOLDBACK_SECONDS = 0.0
"""Holdback applied when an operator configures none.

Disabled by default: the window protects against rare early upstream cutoffs
but is charged on every request, so it is opt-in via
``PROVIDER_STREAM_HOLDBACK_SECONDS``. ``EARLY_HOLDBACK_SECONDS`` remains the
reference value for operators who opt back in.
"""


class TruncatedProviderStreamError(RetryableProviderProtocolError):
    """An upstream stream ended without its required terminal marker."""


class RecoveryFailureAction(StrEnum):
    """How one provider stream should respond to an upstream failure."""

    EARLY_RETRY = "early_retry"
    MIDSTREAM_RECOVERY = "midstream_recovery"
    FINAL_ERROR = "final_error"


@dataclass(frozen=True, slots=True)
class RecoveryDecision:
    """Failure decision for one provider stream attempt."""

    action: RecoveryFailureAction
    retryable: bool
    committed: bool
    has_buffered: bool


class RecoveryHoldbackBuffer:
    """Briefly retain SSE so early cutoffs can be retried invisibly.

    ``holdback_seconds=0`` commits on the first pushed event, so callers pay no
    latency for the invisible-retry window unless they explicitly ask for one.
    """

    def __init__(
        self,
        *,
        holdback_seconds: float = DEFAULT_HOLDBACK_SECONDS,
        max_bytes: int = RECOVERY_BUFFER_MAX_BYTES,
        now: Callable[[], float] | None = None,
    ) -> None:
        if holdback_seconds < 0:
            raise ValueError("holdback_seconds must be >= 0")
        if max_bytes <= 0:
            raise ValueError("max_bytes must be > 0")
        self._holdback_seconds = holdback_seconds
        self._max_bytes = max_bytes
        self._now = now or time.monotonic
        self._events: list[str] = []
        self._bytes = 0
        self._started_at: float | None = None
        self.committed = False

    def push(self, event: str) -> list[str]:
        if self.committed:
            return [event]
        if self._started_at is None:
            self._started_at = self._now()
        self._events.append(event)
        self._bytes += len(event.encode("utf-8", errors="replace"))
        if (
            self._bytes >= self._max_bytes
            or self._now() - self._started_at >= self._holdback_seconds
        ):
            return self.flush()
        return []

    def flush(self) -> list[str]:
        if self.committed:
            return []
        self.committed = True
        events = self._events
        self._events = []
        self._bytes = 0
        self._started_at = None
        return events

    def discard(self) -> None:
        self._events = []
        self._bytes = 0
        self._started_at = None

    @property
    def has_buffered(self) -> bool:
        return bool(self._events)


class RecoveryController:
    """Own commit-boundary holdback for one provider stream lifecycle.

    ``holdback_seconds`` is the invisible-retry window. It defaults to ``0.0``
    so no request pays a latency tax for a retry that rarely happens; operators
    who want early-cutoff retries can raise it via configuration.
    """

    def __init__(self, *, holdback_seconds: float = DEFAULT_HOLDBACK_SECONDS) -> None:
        if holdback_seconds < 0:
            raise ValueError("holdback_seconds must be >= 0")
        self._holdback_seconds = holdback_seconds
        self._holdback = self._new_holdback()

    def _new_holdback(self) -> RecoveryHoldbackBuffer:
        """Build a buffer honoring this controller's configured window."""
        return RecoveryHoldbackBuffer(holdback_seconds=self._holdback_seconds)

    @property
    def committed(self) -> bool:
        return self._holdback.committed

    @property
    def has_buffered(self) -> bool:
        return self._holdback.has_buffered

    def push(self, event: str) -> list[str]:
        return self._holdback.push(event)

    def flush(self) -> list[str]:
        return self._holdback.flush()

    def discard(self) -> None:
        self._holdback.discard()

    def flush_uncommitted(self, decision: RecoveryDecision) -> list[str]:
        if not decision.committed and decision.has_buffered:
            return self.flush()
        return []

    def advance_failure(
        self,
        *,
        retryable: bool,
        stream_opened: bool,
        generated_output: bool,
        complete_tool_salvageable: bool,
        attempts_remaining: int,
    ) -> RecoveryDecision:
        committed = self._holdback.committed
        has_buffered = self._holdback.has_buffered
        retry_available = attempts_remaining > 0
        reserve_last_attempt_for_recovery = generated_output and attempts_remaining == 1

        if (
            retryable
            and retry_available
            and stream_opened
            and not committed
            and not complete_tool_salvageable
            and not reserve_last_attempt_for_recovery
        ):
            self._holdback.discard()
            self._holdback = self._new_holdback()
            return RecoveryDecision(
                action=RecoveryFailureAction.EARLY_RETRY,
                retryable=True,
                committed=False,
                has_buffered=has_buffered,
            )

        if (
            retryable
            and generated_output
            and (retry_available or complete_tool_salvageable)
        ):
            return RecoveryDecision(
                action=RecoveryFailureAction.MIDSTREAM_RECOVERY,
                retryable=True,
                committed=committed,
                has_buffered=has_buffered,
            )

        return RecoveryDecision(
            action=RecoveryFailureAction.FINAL_ERROR,
            retryable=retryable,
            committed=committed,
            has_buffered=has_buffered,
        )
