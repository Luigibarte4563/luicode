"""Gateway interception tests for the delegated browse_web tool.

Covers FR-13, FR-18, FR-20 and AC-5 with a scripted provider, so no Jev,
TypeSafe, or text-model call is made.
"""

import json
from collections.abc import AsyncIterator, Mapping

import pytest

from luicode.application.browser_agent.interception import (
    BROWSE_WEB_TOOL_NAME,
    BrowseWebInterceptor,
)
from luicode.application.browser_agent.service import BrowserAgentService
from luicode.application.execution import ProviderExecutor
from luicode.application.ports import ProviderPort, ProviderResolver
from luicode.application.routing import ModelRouter, RoutedMessagesRequest
from luicode.config.settings import Settings
from luicode.core.anthropic import (
    ContentBlockToolResult,
    Message,
    MessagesRequest,
    Tool,
)
from luicode.core.anthropic.streaming import format_sse_event
from luicode.core.reasoning import ReasoningPolicy
from tests.browser_agent_support import RecordingBrowserAgent

MODEL = "nvidia_nim/nvidia/nemotron-3-super-120b-a12b"


def _settings(**overrides) -> Settings:
    values = {
        "MODEL": MODEL,
        "JEV_ENABLED": "true",
        "TYPESAFE_API_KEY": "ts",
        "JEV_ALLOWED_DOMAINS": "example.com",
    }
    values.update(overrides)
    return Settings.model_validate(values)


def _request(**overrides) -> MessagesRequest:
    values = {
        "model": MODEL,
        "max_tokens": 512,
        "messages": [{"role": "user", "content": "look up the docs"}],
        "tools": [Tool(name="Read", input_schema={"type": "object"})],
    }
    values.update(overrides)
    return MessagesRequest.model_validate(values)


def _routed(request: MessagesRequest) -> RoutedMessagesRequest:
    return ModelRouter(_settings()).resolve_messages_request(request)


def _tool_use_stream(url: str, goal: str) -> list[str]:
    """SSE for an assistant turn that calls browse_web and then stops."""
    call_id = "toolu_browse_1"
    return [
        format_sse_event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_1",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": MODEL,
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 1},
                },
            },
        ),
        format_sse_event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {
                    "type": "tool_use",
                    "id": call_id,
                    "name": BROWSE_WEB_TOOL_NAME,
                    "input": {},
                },
            },
        ),
        format_sse_event(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps({"url": url, "goal": goal}),
                },
            },
        ),
        format_sse_event(
            "content_block_stop", {"type": "content_block_stop", "index": 0}
        ),
        format_sse_event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "tool_use", "stop_sequence": None},
                "usage": {"output_tokens": 5},
            },
        ),
        format_sse_event("message_stop", {"type": "message_stop"}),
    ]


def _text_stream(text: str) -> list[str]:
    return [
        format_sse_event(
            "message_start",
            {
                "type": "message_start",
                "message": {
                    "id": "msg_2",
                    "type": "message",
                    "role": "assistant",
                    "content": [],
                    "model": MODEL,
                    "stop_reason": None,
                    "stop_sequence": None,
                    "usage": {"input_tokens": 10, "output_tokens": 1},
                },
            },
        ),
        format_sse_event(
            "content_block_start",
            {
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "text", "text": ""},
            },
        ),
        format_sse_event(
            "content_block_delta",
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": text},
            },
        ),
        format_sse_event(
            "content_block_stop", {"type": "content_block_stop", "index": 0}
        ),
        format_sse_event(
            "message_delta",
            {
                "type": "message_delta",
                "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                "usage": {"output_tokens": 3},
            },
        ),
        format_sse_event("message_stop", {"type": "message_stop"}),
    ]


async def _collect(body) -> str:
    return "".join([chunk async for chunk in body])


# ----------------------------------------------------------------- FR-13/AC-1


@pytest.mark.asyncio
async def test_disabled_feature_is_not_intercepted():
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings(JEV_ENABLED="false"))
    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(_unused_resolver(), progress_timeout_seconds=5),
    )

    assert interceptor.try_stream_messages(_routed(_request()), request_id="r") is None


@pytest.mark.asyncio
async def test_forced_tool_choice_is_left_alone():
    """FR-20: an explicit forced tool_choice is never overridden."""
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(_unused_resolver(), progress_timeout_seconds=5),
    )
    request = _request(tool_choice={"type": "tool", "name": "Read"})

    assert interceptor.try_stream_messages(_routed(request), request_id="r") is None


@pytest.mark.asyncio
async def test_existing_browse_web_tool_is_not_duplicated():
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(_unused_resolver(), progress_timeout_seconds=5),
    )
    request = _request(tools=[Tool(name=BROWSE_WEB_TOOL_NAME, input_schema={})])

    assert interceptor.try_stream_messages(_routed(request), request_id="r") is None


# ----------------------------------------------------------------- FR-18/AC-5


@pytest.mark.asyncio
async def test_browse_call_is_answered_and_the_turn_continues():
    """AC-5: the gateway runs the task and continues the same turn."""
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    calls: list[list[Tool]] = []

    def stream_messages(_request, **kwargs):
        calls.append(list(_request.tools or []))
        if len(calls) == 1:
            return _iter(_tool_use_stream("https://example.com", "find install"))
        return _iter(_text_stream("The install command is uv sync."))

    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(
            _resolver(stream_messages), progress_timeout_seconds=5
        ),
    )

    body = interceptor.try_stream_messages(_routed(_request()), request_id="r")
    assert body is not None
    payload = await _collect(body)

    # Jev ran exactly once with the model's arguments.
    assert len(port.tasks) == 1
    assert port.tasks[0].url == "https://example.com"
    assert port.tasks[0].goal == "find install"

    # browse_web was offered on the first provider call.
    assert any(tool.name == BROWSE_WEB_TOOL_NAME for tool in calls[0])
    # The turn continued, and the model's final text reached the client.
    assert len(calls) == 2
    assert "uv sync" in payload


@pytest.mark.asyncio
async def test_continuation_carries_the_tool_result_back_to_the_model():
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    seen: list[list] = []

    def stream_messages(_request, **kwargs):
        seen.append(list(_request.messages))
        if len(seen) == 1:
            return _iter(_tool_use_stream("https://example.com", "find install"))
        return _iter(_text_stream("done"))

    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(
            _resolver(stream_messages), progress_timeout_seconds=5
        ),
    )
    body = interceptor.try_stream_messages(_routed(_request()), request_id="r")
    await _collect(body)

    follow_up = seen[1]
    # assistant tool_use turn, then a user tool_result turn.
    assert follow_up[-2].role == "assistant"
    assert follow_up[-1].role == "user"
    result_block = follow_up[-1].content[0]
    assert result_block.type == "tool_result"
    assert "untrusted_page_data" in result_block.content


@pytest.mark.asyncio
async def test_blocked_domain_is_reported_as_a_tool_result_not_a_crash():
    """AC-6: the model receives a blocked result instead of a failure."""
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    calls: list[list[Message]] = []

    def stream_messages(_request, **kwargs):
        calls.append(list(_request.messages))
        if len(calls) == 1:
            return _iter(_tool_use_stream("https://evil.test", "read"))
        return _iter(_text_stream("I could not open that page."))

    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(
            _resolver(stream_messages), progress_timeout_seconds=5
        ),
    )
    body = interceptor.try_stream_messages(_routed(_request()), request_id="r")
    payload = await _collect(body)

    assert port.tasks == []
    result_block = calls[1][-1].content[0]
    assert isinstance(result_block, ContentBlockToolResult)
    assert "blocked" in result_block.content
    assert result_block.model_extra is not None
    assert result_block.model_extra["is_error"] is True
    assert payload


@pytest.mark.asyncio
async def test_turn_without_browse_call_is_passed_through_once():
    port = RecordingBrowserAgent()
    service = BrowserAgentService(port=port, settings=_settings())
    calls: list[int] = []

    def stream_messages(_request, **kwargs):
        calls.append(1)
        return _iter(_text_stream("no browsing needed"))

    interceptor = BrowseWebInterceptor(
        service=service,
        executor=ProviderExecutor(
            _resolver(stream_messages), progress_timeout_seconds=5
        ),
    )
    body = interceptor.try_stream_messages(_routed(_request()), request_id="r")
    payload = await _collect(body)

    assert len(calls) == 1
    assert "no browsing needed" in payload
    assert port.tasks == []


async def _iter(chunks: list[str]):
    for chunk in chunks:
        yield chunk


class _ScriptedProvider:
    """Provider double exposing the one method ProviderExecutor calls.

    ``stream_messages`` must return an async iterator directly, not a coroutine,
    matching the real provider contract.
    """

    def __init__(self, script) -> None:
        self._script = script

    def stream_messages(
        self,
        request: MessagesRequest,
        *,
        input_tokens: int,
        request_id: str,
        response_model: str,
        reasoning: ReasoningPolicy,
        request_headers: Mapping[str, str] | None = None,
        model_info: object | None = None,
    ) -> AsyncIterator[str]:
        return self._script(request)

    def stream_responses(self, request, **kwargs) -> AsyncIterator[str]:
        """The interception tests only exercise the Messages protocol."""
        pytest.fail("stream_responses is not exercised by these tests")


def _unused_resolver() -> ProviderResolver:
    """A resolver for cases that must never reach the provider."""

    async def resolve(_provider_id: str) -> ProviderPort:
        pytest.fail("the provider must not be called in this case")

    return resolve


def _resolver(script) -> ProviderResolver:
    """Adapt a script into the ProviderResolver the executor expects."""

    async def resolve(_provider_id: str) -> ProviderPort:
        return _ScriptedProvider(script)

    return resolve
