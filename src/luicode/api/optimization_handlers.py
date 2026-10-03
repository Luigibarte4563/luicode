"""Optimization handlers for fast-path API responses.

Each handler returns a MessagesResponse if the request matches and the
optimization is enabled, otherwise None.
"""

import uuid

from loguru import logger

from luicode.config.settings import Settings
from luicode.core.anthropic import (
    MessagesRequest,
    MessagesResponse,
    Usage,
)
from luicode.core.anthropic.tokens import get_token_count

from .command_utils import extract_command_prefix, extract_filepaths_from_command
from .detection import (
    is_filepath_extraction_request,
    is_prefix_detection_request,
    is_quota_check_request,
    is_suggestion_mode_request,
    is_title_generation_request,
)


def _text_response(
    request_data: MessagesRequest,
    text: str,
    *,
    input_tokens: int,
    output_tokens: int,
) -> MessagesResponse:
    return MessagesResponse(
        id=f"msg_{uuid.uuid4()}",
        model=request_data.model,
        content=[{"type": "text", "text": text}],
        stop_reason="end_turn",
        usage=Usage(input_tokens=input_tokens, output_tokens=output_tokens),
    )


def _calculate_input_tokens(request_data: MessagesRequest) -> int:
    """Calculate actual input tokens for a request."""
    return get_token_count(
        request_data.messages, request_data.system, request_data.tools
    )


def _record_optimization_saved(
    request_id: str,
    optimization: str,
    saved_input_tokens: int,
    provider_id: str,
    provider_model: str,
) -> None:
    """Record optimization savings via trace. DB write happens via sink on request completion."""
    from luicode.application.usage import PRICE_TABLE

    cost_usd, cost_source = PRICE_TABLE.calculate_cost(
        provider_id, provider_model, saved_input_tokens, 0
    )
    logger.trace(
        "Optimization saved: {} tokens={} cost={} source={}",
        optimization,
        saved_input_tokens,
        cost_usd,
        cost_source,
    )


def try_prefix_detection(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Fast prefix detection - return command prefix without API call."""
    if not settings.fast_prefix_detection:
        return None

    is_prefix_req, command = is_prefix_detection_request(request_data)
    if not is_prefix_req:
        return None

    logger.info("Optimization: Fast prefix detection request")
    actual_input = _calculate_input_tokens(request_data)
    if request_id and provider_id and provider_model:
        _record_optimization_saved(
            request_id, "prefix_detection", actual_input, provider_id, provider_model
        )
    return _text_response(
        request_data,
        extract_command_prefix(command),
        input_tokens=actual_input,
        output_tokens=5,
    )


def try_quota_mock(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Mock quota probe requests."""
    if not settings.enable_network_probe_mock:
        return None
    if not is_quota_check_request(request_data):
        return None

    logger.info("Optimization: Intercepted and mocked quota probe")
    actual_input = _calculate_input_tokens(request_data)
    if request_id and provider_id and provider_model:
        _record_optimization_saved(
            request_id, "quota_mock", actual_input, provider_id, provider_model
        )
    return _text_response(
        request_data,
        "Quota check passed.",
        input_tokens=actual_input,
        output_tokens=5,
    )


def try_title_skip(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Skip title generation requests."""
    if not settings.enable_title_generation_skip:
        return None
    if not is_title_generation_request(request_data):
        return None

    logger.info("Optimization: Skipped title generation request")
    actual_input = _calculate_input_tokens(request_data)
    if request_id and provider_id and provider_model:
        _record_optimization_saved(
            request_id, "title_skip", actual_input, provider_id, provider_model
        )
    return _text_response(
        request_data,
        "Conversation",
        input_tokens=actual_input,
        output_tokens=5,
    )


def try_suggestion_skip(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Skip suggestion mode requests."""
    if not settings.enable_suggestion_mode_skip:
        return None
    if not is_suggestion_mode_request(request_data):
        return None

    logger.info("Optimization: Skipped suggestion mode request")
    actual_input = _calculate_input_tokens(request_data)
    if request_id and provider_id and provider_model:
        _record_optimization_saved(
            request_id, "suggestion_skip", actual_input, provider_id, provider_model
        )
    return _text_response(
        request_data,
        "",
        input_tokens=actual_input,
        output_tokens=1,
    )


def try_filepath_mock(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Mock filepath extraction requests."""
    if not settings.enable_filepath_extraction_mock:
        return None

    is_fp, cmd, output = is_filepath_extraction_request(request_data)
    if not is_fp:
        return None

    filepaths = extract_filepaths_from_command(cmd, output)
    logger.info("Optimization: Mocked filepath extraction")
    actual_input = _calculate_input_tokens(request_data)
    if request_id and provider_id and provider_model:
        _record_optimization_saved(
            request_id, "filepath_mock", actual_input, provider_id, provider_model
        )
    return _text_response(
        request_data,
        filepaths,
        input_tokens=actual_input,
        output_tokens=10,
    )


# Cheapest/most common optimizations first for faster short-circuit.
OPTIMIZATION_HANDLERS = [
    try_quota_mock,
    try_prefix_detection,
    try_title_skip,
    try_suggestion_skip,
    try_filepath_mock,
]


def try_optimizations(
    request_data: MessagesRequest,
    settings: Settings,
    *,
    response_model: str | None = None,
    request_id: str = "",
    provider_id: str = "",
    provider_model: str = "",
) -> MessagesResponse | None:
    """Run optimization handlers in order. Returns first match or None."""
    for handler in OPTIMIZATION_HANDLERS:
        result = handler(
            request_data,
            settings,
            request_id=request_id,
            provider_id=provider_id,
            provider_model=provider_model,
        )
        if result is not None:
            if response_model is None:
                return result
            return result.model_copy(update={"model": response_model})
    return None
