"""Immutable usage records emitted by the observer and consumed by sinks."""

import json
import uuid
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class RequestOutcome(StrEnum):
    """Terminal result of a routed provider request."""

    SUCCESS = "success"
    FALLBACK_SUCCESS = "fallback_success"
    FAILURE = "failure"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    RATE_LIMITED = "rate_limited"
    CONTEXT_WINDOW_EXCEEDED = "context_window_exceeded"
    AUTH_ERROR = "auth_error"
    INVALID_REQUEST = "invalid_request"
    UPSTREAM_ERROR = "upstream_error"
    UNKNOWN = "unknown"


class FailureKind(StrEnum):
    """Classifier for non-success outcomes."""

    TIMEOUT = "timeout"
    RATE_LIMIT = "rate_limit"
    CONTEXT_WINDOW = "context_window"
    AUTH = "auth"
    INVALID_REQUEST = "invalid_request"
    UPSTREAM_5XX = "upstream_5xx"
    UPSTREAM_4XX = "upstream_4xx"
    NETWORK = "network"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class RequestUsage:
    """One routed request and its resolved usage."""

    id: str = field(default_factory=lambda: f"ru_{uuid.uuid4().hex[:16]}")
    request_id: str = ""
    started_ms: int = 0
    ended_ms: int | None = None

    # Client identity
    agent: str = "unknown"
    gateway_model: str = ""

    # Resolved provider (primary or fallback)
    provider_id: str = ""
    provider_model: str = ""
    wire_api: str = "messages"  # "messages" | "responses"

    # Token counts
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    estimated_input_tokens: int = 0

    # Latency
    latency_ms: int = 0
    ttfb_ms: int = 0

    # Fallback chain
    attempt_count: int = 1
    fallback_path: tuple[str, ...] = field(default_factory=tuple)

    # Outcome
    outcome: RequestOutcome = RequestOutcome.SUCCESS
    failure_kind: FailureKind | None = None
    status_code: int | None = None
    error_message: str | None = None

    # Cost (NULL if unknown)
    cost_usd: float | None = None
    cost_source: str = "unknown"  # "provider" | "bundled" | "override" | "unknown"

    def to_row(self) -> dict[str, Any]:
        """Convert to a flat dict for SQLite INSERT."""
        return {
            "id": self.id,
            "request_id": self.request_id,
            "started_ms": self.started_ms,
            "ended_ms": self.ended_ms,
            "agent": self.agent,
            "gateway_model": self.gateway_model,
            "provider_id": self.provider_id,
            "provider_model": self.provider_model,
            "wire_api": self.wire_api,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "estimated_input_tokens": self.estimated_input_tokens,
            "latency_ms": self.latency_ms,
            "ttfb_ms": self.ttfb_ms,
            "attempt_count": self.attempt_count,
            "fallback_path": json.dumps(list(self.fallback_path)),
            "outcome": self.outcome.value,
            "failure_kind": self.failure_kind.value if self.failure_kind else None,
            "status_code": self.status_code,
            "error_message": self.error_message,
            "cost_usd": self.cost_usd,
            "cost_source": self.cost_source,
        }

    def as_dict(self) -> dict[str, Any]:
        """Convert to an API payload, keeping JSON values as JSON values.

        Storage needs the fallback chain as text; a reader needs a list.
        """
        row = self.to_row()
        row["fallback_path"] = list(self.fallback_path)
        return row

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> RequestUsage:
        return cls(
            id=row["id"],
            request_id=row["request_id"],
            started_ms=row["started_ms"],
            ended_ms=row["ended_ms"],
            agent=row["agent"],
            gateway_model=row["gateway_model"],
            provider_id=row["provider_id"],
            provider_model=row["provider_model"],
            wire_api=row["wire_api"],
            input_tokens=row["input_tokens"],
            output_tokens=row["output_tokens"],
            cache_read_input_tokens=row["cache_read_input_tokens"],
            cache_creation_input_tokens=row["cache_creation_input_tokens"],
            estimated_input_tokens=row["estimated_input_tokens"],
            latency_ms=row["latency_ms"],
            ttfb_ms=row["ttfb_ms"],
            attempt_count=row["attempt_count"],
            fallback_path=tuple(json.loads(row["fallback_path"] or "[]")),
            outcome=RequestOutcome(row["outcome"]),
            failure_kind=FailureKind(row["failure_kind"])
            if row["failure_kind"]
            else None,
            status_code=row["status_code"],
            error_message=row["error_message"],
            cost_usd=row["cost_usd"],
            cost_source=row["cost_source"],
        )


@dataclass(frozen=True, slots=True)
class OptimizationSaving:
    """One optimization handler interception and its measured savings."""

    id: str = field(default_factory=lambda: f"os_{uuid.uuid4().hex[:16]}")
    request_id: str = ""
    at_ms: int = 0
    optimization: str = ""
    saved_input_tokens: int = 0
    saved_output_tokens: int = 0
    saved_cost_usd: float | None = None
    cost_source: str = "unknown"

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "request_id": self.request_id,
            "at_ms": self.at_ms,
            "optimization": self.optimization,
            "saved_input_tokens": self.saved_input_tokens,
            "saved_output_tokens": self.saved_output_tokens,
            "saved_cost_usd": self.saved_cost_usd,
            "cost_source": self.cost_source,
        }

    def as_dict(self) -> dict[str, Any]:
        """Convert to an API payload; every field here is already JSON."""
        return self.to_row()

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> OptimizationSaving:
        return cls(
            id=row["id"],
            request_id=row["request_id"],
            at_ms=row["at_ms"],
            optimization=row["optimization"],
            saved_input_tokens=row["saved_input_tokens"],
            saved_output_tokens=row["saved_output_tokens"],
            saved_cost_usd=row["saved_cost_usd"],
            cost_source=row["cost_source"],
        )


@dataclass(frozen=True, slots=True)
class ProviderHealthSnapshot:
    """Read-only provider health for the Admin panel."""

    provider_id: str
    display_name: str
    is_healthy: bool
    success_rate: float  # 0.0 - 1.0
    p50_latency_ms: float | None
    p95_latency_ms: float | None
    current_episode: str | None  # "idle" | "probing" | "quarantined"
    last_error: str | None
    last_success_ms: int | None
    rate_limit_remaining: int | None
    rate_limit_reset_ms: int | None
    concurrency_used: int
    concurrency_limit: int
