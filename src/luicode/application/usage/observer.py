"""SSE stream observer that extracts usage without buffering content."""

import time
from collections.abc import AsyncGenerator, AsyncIterator
from dataclasses import dataclass
from typing import Any

from luicode.application.usage.pricing import PRICE_TABLE
from luicode.application.usage.record import (
    FailureKind,
    OptimizationSaving,
    RequestOutcome,
    RequestUsage,
)
from luicode.application.usage.sink import UsageSink
from luicode.core.anthropic.sse_aggregation import AnthropicSSEDecoder
from luicode.core.anthropic.stream_contracts import SSEEvent
from luicode.core.trace import trace_event


@dataclass(slots=True)
class _ObservedUsage:
    """Usage extracted from a single provider stream."""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    ttfb_ms: int = 0
    first_chunk_ms: int = 0
    ended_ms: int = 0
    latency_ms: int = 0
    outcome: RequestOutcome = RequestOutcome.SUCCESS
    failure_kind: FailureKind | None = None
    status_code: int | None = None
    error_message: str | None = None


class UsageObserver:
    """
    Wraps an outbound SSE stream and observes usage + latency.

    Does not buffer chunks - yields them immediately after decoding.
    """

    def __init__(
        self,
        sink: UsageSink,
        request_id: str,
        agent: str,
        gateway_model: str,
        provider_id: str,
        provider_model: str,
        wire_api: str,
        estimated_input_tokens: int,
        fallback_path: tuple[str, ...],
        attempt_count: int = 1,
    ) -> None:
        self._sink = sink
        self._request_id = request_id
        self._agent = agent
        self._gateway_model = gateway_model
        self._provider_id = provider_id
        self._provider_model = provider_model
        self._wire_api = wire_api
        self._estimated_input_tokens = estimated_input_tokens
        self._fallback_path = fallback_path
        self._attempt_count = attempt_count
        self._started_ms = int(time.time() * 1000)
        self._observed = _ObservedUsage()
        self._decoder = AnthropicSSEDecoder()
        self._first_chunk = True
        self._completed = False

    async def observe(self, stream: AsyncIterator[str]) -> AsyncGenerator[str]:
        """Consume the provider stream, yield chunks, emit usage on completion."""
        try:
            async for chunk in stream:
                if self._first_chunk:
                    self._observed.first_chunk_ms = int(time.time() * 1000)
                    self._observed.ttfb_ms = (
                        self._observed.first_chunk_ms - self._started_ms
                    )
                    self._first_chunk = False
                yield chunk
                self._decode_chunk(chunk)
        except Exception as e:
            self._observed.outcome = RequestOutcome.FAILURE
            self._observed.failure_kind = self._classify_failure(e)
            self._observed.status_code = self._extract_status(e)
            self._observed.error_message = str(e)[:500]
            raise
        finally:
            if not self._completed:
                self._finalize()

    def _decode_chunk(self, chunk: str) -> None:
        for event in self._decoder.feed(chunk):
            self._handle_event(event)
        for event in self._decoder.finish():
            self._handle_event(event)

    def _handle_event(self, event: SSEEvent) -> None:
        if event.event != "message":
            return
        payload = event.data
        ptype = payload.get("type")

        if ptype == "message_delta":
            usage = payload.get("usage")
            if isinstance(usage, dict):
                self._observed.output_tokens = usage.get(
                    "output_tokens", self._observed.output_tokens
                )
                # input_tokens in message_delta is cumulative
                if "input_tokens" in usage:
                    self._observed.input_tokens = usage["input_tokens"]
                if "cache_read_input_tokens" in usage:
                    self._observed.cache_read_input_tokens = usage[
                        "cache_read_input_tokens"
                    ]
                if "cache_creation_input_tokens" in usage:
                    self._observed.cache_creation_input_tokens = usage[
                        "cache_creation_input_tokens"
                    ]

        elif ptype == "error":
            err = payload.get("error")
            if isinstance(err, dict):
                self._observed.outcome = RequestOutcome.FAILURE
                self._observed.failure_kind = self._classify_error_dict(err)
                self._observed.status_code = err.get("status_code") or err.get("code")
                self._observed.error_message = err.get("message", "")[:500]

        elif ptype == "message_stop":
            self._observed.ended_ms = int(time.time() * 1000)
            self._observed.outcome = (
                RequestOutcome.FALLBACK_SUCCESS
                if self._attempt_count > 1
                else RequestOutcome.SUCCESS
            )
            self._finalize()

    def _finalize(self) -> None:
        if self._completed:
            return
        self._completed = True
        self._observed.ended_ms = self._observed.ended_ms or int(time.time() * 1000)
        self._observed.latency_ms = self._observed.ended_ms - self._started_ms

        cost_usd, cost_source = PRICE_TABLE.calculate_cost(
            self._provider_id,
            self._provider_model,
            self._observed.input_tokens,
            self._observed.output_tokens,
        )

        record = RequestUsage(
            request_id=self._request_id,
            started_ms=self._started_ms,
            ended_ms=self._observed.ended_ms,
            agent=self._agent,
            gateway_model=self._gateway_model,
            provider_id=self._provider_id,
            provider_model=self._provider_model,
            wire_api=self._wire_api,
            input_tokens=self._observed.input_tokens,
            output_tokens=self._observed.output_tokens,
            cache_read_input_tokens=self._observed.cache_read_input_tokens,
            cache_creation_input_tokens=self._observed.cache_creation_input_tokens,
            estimated_input_tokens=self._estimated_input_tokens,
            latency_ms=self._observed.latency_ms,
            ttfb_ms=self._observed.ttfb_ms,
            attempt_count=self._attempt_count,
            fallback_path=self._fallback_path,
            outcome=self._observed.outcome,
            failure_kind=self._observed.failure_kind,
            status_code=self._observed.status_code,
            error_message=self._observed.error_message,
            cost_usd=cost_usd,
            cost_source=cost_source,
        )
        self._sink.record_request(record)

        trace_event(
            stage="usage",
            event="luicode.usage.recorded",
            source="application",
            request_id=self._request_id,
            provider_id=self._provider_id,
            provider_model=self._provider_model,
            input_tokens=record.input_tokens,
            output_tokens=record.output_tokens,
            latency_ms=record.latency_ms,
            outcome=record.outcome.value,
            cost_usd=cost_usd,
            cost_source=cost_source,
        )

    @staticmethod
    def _classify_failure(error: Exception) -> FailureKind:
        status = getattr(error, "status_code", None)
        if status is None:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None) if response else None

        if status == 429:
            return FailureKind.RATE_LIMIT
        if status == 401 or status == 403:
            return FailureKind.AUTH
        if status == 400:
            return FailureKind.INVALID_REQUEST
        if status and 500 <= status < 600:
            return FailureKind.UPSTREAM_5XX
        if status and 400 <= status < 500:
            return FailureKind.UPSTREAM_4XX

        msg = str(error).lower()
        if "timeout" in msg:
            return FailureKind.TIMEOUT
        if "rate limit" in msg or "429" in msg:
            return FailureKind.RATE_LIMIT
        if "context window" in msg or "context_window" in msg:
            return FailureKind.CONTEXT_WINDOW
        if "auth" in msg or "unauthorized" in msg or "api key" in msg:
            return FailureKind.AUTH
        if "cancelled" in msg:
            return FailureKind.CANCELLED
        if "connection" in msg or "network" in msg or "dns" in msg:
            return FailureKind.NETWORK
        return FailureKind.UNKNOWN

    @staticmethod
    def _classify_error_dict(err: dict[str, Any]) -> FailureKind:
        code = err.get("code") or err.get("type") or ""
        code_str = str(code).lower()
        if "rate_limit" in code_str or "429" in code_str:
            return FailureKind.RATE_LIMIT
        if "auth" in code_str or "unauthorized" in code_str or "401" in code_str:
            return FailureKind.AUTH
        if "context_window" in code_str or "context_window_exceeded" in code_str:
            return FailureKind.CONTEXT_WINDOW
        if "invalid" in code_str or "400" in code_str:
            return FailureKind.INVALID_REQUEST
        if isinstance(code, int) and 500 <= code < 600:
            return FailureKind.UPSTREAM_5XX
        if isinstance(code, int) and 400 <= code < 500:
            return FailureKind.UPSTREAM_4XX
        return FailureKind.UNKNOWN

    @staticmethod
    def _extract_status(error: Exception) -> int | None:
        status = getattr(error, "status_code", None)
        if status is None:
            response = getattr(error, "response", None)
            status = getattr(response, "status_code", None) if response else None
        return status if isinstance(status, int) else None


async def observe_optimization(
    sink: UsageSink,
    request_id: str,
    optimization: str,
    saved_input_tokens: int,
    saved_output_tokens: int,
    provider_id: str,
    provider_model: str,
) -> None:
    """Record an optimization saving with real token counts."""
    cost_usd, cost_source = PRICE_TABLE.calculate_cost(
        provider_id,
        provider_model,
        saved_input_tokens,
        saved_output_tokens,
    )
    saving = OptimizationSaving(
        request_id=request_id,
        at_ms=int(time.time() * 1000),
        optimization=optimization,
        saved_input_tokens=saved_input_tokens,
        saved_output_tokens=saved_output_tokens,
        saved_cost_usd=cost_usd,
        cost_source=cost_source,
    )
    sink.record_optimization(saving)

    trace_event(
        stage="usage",
        event="luicode.optimization.saved",
        source="application",
        request_id=request_id,
        optimization=optimization,
        saved_input_tokens=saved_input_tokens,
        saved_output_tokens=saved_output_tokens,
        cost_usd=cost_usd,
        cost_source=cost_source,
    )
