"""Tests for usage record dataclasses."""

from luicode.application.usage.record import (
    FailureKind,
    OptimizationSaving,
    RequestOutcome,
    RequestUsage,
)


def test_request_usage_roundtrip():
    """Test RequestUsage serialization roundtrip."""
    original = RequestUsage(
        id="test_123",
        request_id="req_456",
        started_ms=1000,
        ended_ms=2000,
        agent="test-agent",
        gateway_model="sonnet",
        provider_id="anthropic",
        provider_model="claude-3-5-sonnet",
        wire_api="messages",
        input_tokens=100,
        output_tokens=50,
        cache_read_input_tokens=10,
        cache_creation_input_tokens=5,
        estimated_input_tokens=95,
        latency_ms=1000,
        ttfb_ms=200,
        attempt_count=1,
        fallback_path=("anthropic/claude-3-5-sonnet",),
        outcome=RequestOutcome.SUCCESS,
        failure_kind=None,
        status_code=200,
        error_message=None,
        cost_usd=0.0015,
        cost_source="bundled",
    )

    row = original.to_row()
    restored = RequestUsage.from_row(row)

    assert restored.id == original.id
    assert restored.request_id == original.request_id
    assert restored.started_ms == original.started_ms
    assert restored.ended_ms == original.ended_ms
    assert restored.agent == original.agent
    assert restored.gateway_model == original.gateway_model
    assert restored.provider_id == original.provider_id
    assert restored.provider_model == original.provider_model
    assert restored.wire_api == original.wire_api
    assert restored.input_tokens == original.input_tokens
    assert restored.output_tokens == original.output_tokens
    assert restored.cache_read_input_tokens == original.cache_read_input_tokens
    assert restored.cache_creation_input_tokens == original.cache_creation_input_tokens
    assert restored.estimated_input_tokens == original.estimated_input_tokens
    assert restored.latency_ms == original.latency_ms
    assert restored.ttfb_ms == original.ttfb_ms
    assert restored.attempt_count == original.attempt_count
    assert restored.fallback_path == original.fallback_path
    assert restored.outcome == original.outcome
    assert restored.failure_kind == original.failure_kind
    assert restored.status_code == original.status_code
    assert restored.error_message == original.error_message
    assert restored.cost_usd == original.cost_usd
    assert restored.cost_source == original.cost_source


def test_request_usage_fallback_path_json():
    """Test fallback_path serialization to JSON."""
    usage = RequestUsage(
        request_id="req_1",
        started_ms=1000,
        agent="agent",
        gateway_model="model",
        provider_id="provider",
        provider_model="model",
        fallback_path=("a/b", "c/d", "e/f"),
    )
    row = usage.to_row()
    assert row["fallback_path"] == '["a/b", "c/d", "e/f"]'

    restored = RequestUsage.from_row(row)
    assert restored.fallback_path == ("a/b", "c/d", "e/f")


def test_optimization_saving_roundtrip():
    """Test OptimizationSaving serialization roundtrip."""
    original = OptimizationSaving(
        id="opt_123",
        request_id="req_456",
        at_ms=1500,
        optimization="title_skip",
        saved_input_tokens=100,
        saved_output_tokens=5,
        saved_cost_usd=0.0005,
        cost_source="bundled",
    )

    row = original.to_row()
    restored = OptimizationSaving.from_row(row)

    assert restored.id == original.id
    assert restored.request_id == original.request_id
    assert restored.at_ms == original.at_ms
    assert restored.optimization == original.optimization
    assert restored.saved_input_tokens == original.saved_input_tokens
    assert restored.saved_output_tokens == original.saved_output_tokens
    assert restored.saved_cost_usd == original.saved_cost_usd
    assert restored.cost_source == original.cost_source


def test_request_outcome_enum():
    """Test RequestOutcome enum values."""
    assert RequestOutcome.SUCCESS.value == "success"
    assert RequestOutcome.FALLBACK_SUCCESS.value == "fallback_success"
    assert RequestOutcome.FAILURE.value == "failure"
    assert RequestOutcome.TIMEOUT.value == "timeout"
    assert RequestOutcome.CANCELLED.value == "cancelled"
    assert RequestOutcome.RATE_LIMITED.value == "rate_limited"
    assert RequestOutcome.CONTEXT_WINDOW_EXCEEDED.value == "context_window_exceeded"
    assert RequestOutcome.AUTH_ERROR.value == "auth_error"
    assert RequestOutcome.INVALID_REQUEST.value == "invalid_request"
    assert RequestOutcome.UPSTREAM_ERROR.value == "upstream_error"
    assert RequestOutcome.UNKNOWN.value == "unknown"


def test_failure_kind_enum():
    """Test FailureKind enum values."""
    assert FailureKind.TIMEOUT.value == "timeout"
    assert FailureKind.RATE_LIMIT.value == "rate_limit"
    assert FailureKind.CONTEXT_WINDOW.value == "context_window"
    assert FailureKind.AUTH.value == "auth"
    assert FailureKind.INVALID_REQUEST.value == "invalid_request"
    assert FailureKind.UPSTREAM_5XX.value == "upstream_5xx"
    assert FailureKind.UPSTREAM_4XX.value == "upstream_4xx"
    assert FailureKind.NETWORK.value == "network"
    assert FailureKind.CANCELLED.value == "cancelled"
    assert FailureKind.UNKNOWN.value == "unknown"
