"""Usage sink protocol and in-memory implementation."""

import asyncio
from collections import deque
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Protocol

from luicode.application.usage.record import OptimizationSaving, RequestUsage


class UsageSink(Protocol):
    """Append-only sink for usage records. Must never raise into the request path."""

    def record_request(self, record: RequestUsage) -> None: ...
    def record_optimization(self, saving: OptimizationSaving) -> None: ...
    def snapshot_requests(self, limit: int = 1000) -> tuple[RequestUsage, ...]: ...
    def snapshot_optimizations(
        self, limit: int = 1000
    ) -> tuple[OptimizationSaving, ...]: ...
    async def flush(self) -> None: ...
    async def close(self) -> None: ...


@dataclass(slots=True)
class _BufferedUsageSink:
    """In-memory ring buffer with async flush hook."""

    max_requests: int = 10000
    max_optimizations: int = 5000
    flush_interval_seconds: float = 1.0
    flush_batch_size: int = 50
    on_flush: Callable[[list[RequestUsage], list[OptimizationSaving]], Any] | None = (
        None
    )

    _requests: deque[RequestUsage] = field(default_factory=deque, init=False)
    _optimizations: deque[OptimizationSaving] = field(default_factory=deque, init=False)
    _pending_requests: list[RequestUsage] = field(default_factory=list, init=False)
    _pending_optimizations: list[OptimizationSaving] = field(
        default_factory=list, init=False
    )
    _flush_task: asyncio.Task[None] | None = field(default=None, init=False)
    _closed: bool = field(default=False, init=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)

    def __post_init__(self) -> None:
        self._requests = deque(maxlen=self.max_requests)
        self._optimizations = deque(maxlen=self.max_optimizations)
        self._flush_task = asyncio.create_task(self._flush_loop())

    def record_request(self, record: RequestUsage) -> None:
        self._requests.append(record)
        self._pending_requests.append(record)

    def record_optimization(self, saving: OptimizationSaving) -> None:
        self._optimizations.append(saving)
        self._pending_optimizations.append(saving)

    def snapshot_requests(self, limit: int = 1000) -> tuple[RequestUsage, ...]:
        return tuple(list(self._requests)[-limit:])

    def snapshot_optimizations(
        self, limit: int = 1000
    ) -> tuple[OptimizationSaving, ...]:
        return tuple(list(self._optimizations)[-limit:])

    async def flush(self) -> None:
        # _drain_pending acquires the lock itself. Holding it here as well would
        # deadlock: asyncio.Lock is not reentrant.
        await self._drain_pending()

    async def close(self) -> None:
        self._closed = True
        if self._flush_task:
            self._flush_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._flush_task
        await self.flush()

    async def _flush_loop(self) -> None:
        while not self._closed:
            try:
                await asyncio.sleep(self.flush_interval_seconds)
                if not self._closed:
                    await self._drain_pending()
            except asyncio.CancelledError:
                break
            except Exception:
                # Never let flush errors propagate
                pass

    async def _drain_pending(self) -> None:
        if not self._pending_requests and not self._pending_optimizations:
            return
        async with self._lock:
            reqs = self._pending_requests[: self.flush_batch_size]
            opts = self._pending_optimizations[: self.flush_batch_size]
            if not reqs and not opts:
                return
            self._pending_requests = self._pending_requests[len(reqs) :]
            self._pending_optimizations = self._pending_optimizations[len(opts) :]
        if self.on_flush and (reqs or opts):
            # Swallow - flush failures must never affect the request path
            with suppress(Exception):
                await self.on_flush(reqs, opts)


def create_memory_sink(
    *,
    max_requests: int = 10000,
    max_optimizations: int = 5000,
    flush_interval_seconds: float = 1.0,
    flush_batch_size: int = 50,
    on_flush: Callable[[list[RequestUsage], list[OptimizationSaving]], Any]
    | None = None,
) -> UsageSink:
    """Create an in-memory sink with optional async flush callback."""
    return _BufferedUsageSink(
        max_requests=max_requests,
        max_optimizations=max_optimizations,
        flush_interval_seconds=flush_interval_seconds,
        flush_batch_size=flush_batch_size,
        on_flush=on_flush,
    )


class _NoOpSink:
    """Null sink for when usage recording is disabled."""

    def record_request(self, record: RequestUsage) -> None:
        pass

    def record_optimization(self, saving: OptimizationSaving) -> None:
        pass

    def snapshot_requests(self, limit: int = 1000) -> tuple[RequestUsage, ...]:
        return ()

    def snapshot_optimizations(
        self, limit: int = 1000
    ) -> tuple[OptimizationSaving, ...]:
        return ()

    async def flush(self) -> None:
        pass

    async def close(self) -> None:
        pass


NOOP_SINK: UsageSink = _NoOpSink()
