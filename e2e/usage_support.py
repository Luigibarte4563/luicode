"""Explicit barriers for Usage browser tests, on the application's own loop."""

import asyncio
import time
from collections.abc import Coroutine

from luicode.application.usage.record import RequestUsage
from luicode.runtime.application import ApplicationRuntime


class UsageControl:
    """Seeds usage records on the loop that owns the live feed."""

    def __init__(self, runtime: ApplicationRuntime) -> None:
        self.runtime = runtime
        self.loop: asyncio.AbstractEventLoop | None = None

    def run[T](self, work: Coroutine[object, object, T]) -> T:
        assert self.loop is not None
        return asyncio.run_coroutine_threadsafe(work, self.loop).result(timeout=10)

    async def record(
        self,
        request_id: str,
        *,
        input_tokens: int = 100,
        output_tokens: int = 50,
        agent: str = "claude-code",
    ) -> None:
        """Commit one usage record the way a finished request would."""
        now = int(time.time() * 1000)
        database = await self.runtime.usage_database()
        await database.write_batch(
            [
                RequestUsage(
                    id=f"id-{request_id}",
                    request_id=request_id,
                    started_ms=now,
                    ended_ms=now + 120,
                    agent=agent,
                    gateway_model="sonnet",
                    provider_id="open_router",
                    provider_model="vendor/model-a",
                    wire_api="anthropic",
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    cost_usd=0.01,
                    cost_source="table",
                )
            ],
            [],
        )
        for _ in range(400):
            if database.query_requests(since_ms=now - 60_000):
                return
            await asyncio.sleep(0.01)
        raise AssertionError("usage record was never committed")
