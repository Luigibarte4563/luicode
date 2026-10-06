"""Provider stream commit-boundary and recovery policy."""

from luicode.providers.stream_recovery import (
    DEFAULT_HOLDBACK_SECONDS,
    EARLY_HOLDBACK_SECONDS,
    RecoveryController,
    RecoveryFailureAction,
    RecoveryHoldbackBuffer,
)


def _holding_controller() -> RecoveryController:
    """Build a controller with the invisible-retry window explicitly enabled.

    Holdback is opt-in (``PROVIDER_STREAM_HOLDBACK_SECONDS`` defaults to 0), so
    tests that exercise uncommitted-buffer recovery must ask for the window.
    """
    return RecoveryController(holdback_seconds=EARLY_HOLDBACK_SECONDS)


def test_early_retry_discards_uncommitted_holdback() -> None:
    controller = _holding_controller()

    assert controller.push("hidden") == []
    decision = controller.advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=False,
        attempts_remaining=2,
    )

    assert decision.action == RecoveryFailureAction.EARLY_RETRY
    assert decision.retryable
    assert decision.has_buffered
    assert not controller.committed
    assert not controller.has_buffered
    assert controller.flush() == []


def test_early_retry_requires_remaining_execution_budget() -> None:
    controller = _holding_controller()
    assert controller.push("hidden") == []

    decision = controller.advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=False,
        attempts_remaining=0,
    )

    assert decision.action == RecoveryFailureAction.FINAL_ERROR
    assert decision.retryable
    assert controller.has_buffered


def test_last_attempt_is_reserved_for_partial_output_recovery() -> None:
    controller = _holding_controller()
    assert controller.push("partial") == []

    decision = controller.advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=False,
        attempts_remaining=1,
    )

    assert decision.action == RecoveryFailureAction.MIDSTREAM_RECOVERY
    assert decision.has_buffered
    assert controller.has_buffered


def test_create_failure_is_owned_by_admission_not_stream_recovery() -> None:
    decision = RecoveryController().advance_failure(
        retryable=True,
        stream_opened=False,
        generated_output=False,
        complete_tool_salvageable=False,
        attempts_remaining=1,
    )

    assert decision.action == RecoveryFailureAction.FINAL_ERROR
    assert decision.retryable


def test_statusless_transient_api_error_allows_early_retry() -> None:
    decision = RecoveryController().advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=False,
        complete_tool_salvageable=False,
        attempts_remaining=1,
    )

    assert decision.action == RecoveryFailureAction.EARLY_RETRY
    assert decision.retryable


def test_committed_output_allows_midstream_recovery() -> None:
    controller = _holding_controller()

    assert controller.push("event: content_block_delta\n\n") == []
    assert controller.flush() == ["event: content_block_delta\n\n"]
    decision = controller.advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=False,
        attempts_remaining=1,
    )

    assert decision.action == RecoveryFailureAction.MIDSTREAM_RECOVERY
    assert decision.retryable
    assert decision.committed
    assert controller.flush_uncommitted(decision) == []


def test_uncommitted_complete_tool_can_be_salvaged() -> None:
    controller = _holding_controller()

    assert controller.push("event: content_block_delta\n\n") == []
    decision = controller.advance_failure(
        retryable=True,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=True,
        attempts_remaining=0,
    )

    assert decision.action == RecoveryFailureAction.MIDSTREAM_RECOVERY
    assert not decision.committed
    assert decision.has_buffered
    assert controller.flush_uncommitted(decision) == ["event: content_block_delta\n\n"]
    assert controller.committed
    assert not controller.has_buffered


def test_non_retryable_error_is_final() -> None:
    decision = RecoveryController().advance_failure(
        retryable=False,
        stream_opened=True,
        generated_output=True,
        complete_tool_salvageable=False,
        attempts_remaining=2,
    )

    assert decision.action == RecoveryFailureAction.FINAL_ERROR
    assert not decision.retryable


def test_holdback_buffers_until_delay_then_commits() -> None:
    now = [10.0]
    holdback = RecoveryHoldbackBuffer(holdback_seconds=0.75, now=lambda: now[0])

    assert holdback.push("event: content_block_start\n\n") == []
    now[0] += 0.74
    assert holdback.push("event: content_block_delta\n\n") == []
    assert not holdback.committed

    now[0] += 0.01
    assert holdback.push("event: content_block_stop\n\n") == [
        "event: content_block_start\n\n",
        "event: content_block_delta\n\n",
        "event: content_block_stop\n\n",
    ]
    assert holdback.committed
    assert holdback.push("event: message_stop\n\n") == ["event: message_stop\n\n"]


def test_holdback_flushes_at_internal_buffer_cap() -> None:
    holdback = RecoveryHoldbackBuffer(
        holdback_seconds=EARLY_HOLDBACK_SECONDS, max_bytes=5, now=lambda: 1.0
    )

    assert holdback.push("ab") == []
    assert holdback.push("cde") == ["ab", "cde"]
    assert holdback.committed


def test_holdback_discard_drops_uncommitted_events() -> None:
    holdback = RecoveryHoldbackBuffer(
        holdback_seconds=EARLY_HOLDBACK_SECONDS, now=lambda: 1.0
    )

    assert holdback.push("hidden") == []
    holdback.discard()

    assert holdback.flush() == []


def test_holdback_is_disabled_by_default() -> None:
    """Latency-first default: the first event reaches the client immediately."""
    assert DEFAULT_HOLDBACK_SECONDS == 0.0

    controller = RecoveryController()

    assert controller.push("first") == ["first"]
    assert controller.committed


def test_disabled_holdback_still_passes_through_later_events() -> None:
    controller = RecoveryController()

    assert controller.push("first") == ["first"]
    assert controller.push("second") == ["second"]


def test_disabled_holdback_rejects_negative_window() -> None:
    try:
        RecoveryController(holdback_seconds=-0.1)
    except ValueError as error:
        assert "holdback_seconds" in str(error)
    else:
        raise AssertionError("Negative holdback window must be rejected.")
