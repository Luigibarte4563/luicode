"""Tests for usage sink."""

from __future__ import annotations

import asyncio

import pytest

from luicode.application.usage.record import (
    FailureKind,
    OptimizationSaving,
    RequestOutcome,
    RequestUsage,
)
from luicode.application.usage.sink import NOOP_SINK, create_memory_sink


@pytest.mark.asyncio
async def test_memory_sink_basic():
    """Test basic sink operations."""
    sink = create_memory_sink()

    record = RequestUsage(
        request_id="req_1",
        started_ms=1000,
        agent="test",
        gateway_model="model",
        provider_id="provider",
        provider_model="model",
    )

    sink.record_request(record)
    requests = sink.snapshot_requests(limit=10)
    assert len(requests) == 1
    assert requests[0].request_id == "req_1"

    saving = OptimizationSaving(
        request_id="req_1",
        at_ms=1500,
        optimization="test",
        saved_input_tokens=100,
    )
    sink.record_optimization(saving)
    optimizations = sink.snapshot_optimizations(limit=10)
    assert len(optimizations) == 1
    assert optimizations[0].optimization == "test"

    await sink.close()


@pytest.mark.asyncio
async def test_memory_sink_ring_buffer():
    """Test that sink respects max size (ring buffer)."""
    sink = create_memory_sink(max_requests=3, max_optimizations=3)

    for i in range(5):
        record = RequestUsage(
            request_id=f"req_{i}",
            started_ms=1000 + i,
            agent="test",
            gateway_model="model",
            provider_id="provider",
            provider_model="model",
        )
        sink.record_request(record)

    requests = sink.snapshot_requests(limit=10)
    assert len(requests) == 3
    # Should keep the last 3
    assert requests[0].request_id == "req_2"
    assert requests[1].request_id == "req_3"
    assert requests[2].request_id == "req_4"

    await sink.close()


@pytest.mark.asyncio
async def test_memory_sink_flush():
    """Test flush callback."""
    flushed = []

    async def on_flush(reqs, opts):
        flushed.append((list(reqs), list(opts)))

    sink = create_memory_sink(flush_interval_seconds=0.01, flush_batch_size=2, on_flush=on_flush)

    for i in range(3):
        record = RequestUsage(
            request_id=f"req_{i}",
            started_ms=1000 + i,
            agent="test",
            gateway_model="model",
            provider_id="provider",
            provider_model="model",
        )
        sink.record_request(record)

    await asyncio.sleep(0.05)  # Wait for flush
    await sink.close()

    assert len(flushed) >= 1
    total_flushed = sum(len(r) for r, _ in flushed)
    assert total_flushed == 3


@pytest.mark.asyncio
async def test_noop_sink():
    """Test noop sink does nothing."""
    record = RequestUsage(
        request_id="req_1",
        started_ms=1000,
        agent="test",
        gateway_model="model",
        provider_id="provider",
        provider_model="model",
    )
    saving = OptimizationSaving(
        request_id="req_1",
        at_ms=1500,
        optimization="test",
        saved_input_tokens=100,
    )

    NOOP_SINK.record_request(record)
    NOOP_SINK.record_optimization(saving)

    requests = NOOP_SINK.snapshot_requests()
    assert len(requests) == 0

    optimizations = NOOP_SINK.snapshot_optimizations()
    assert len(optimizations) == 0

    await NOOP_SINK.flush()
    await NOOP_SINK.close()