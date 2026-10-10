"""Anthropic Messages interception for the delegated browse_web tool.

The gateway offers ``browse_web`` as an ordinary client tool, then intercepts the
model's call instead of returning it to the agent: Jev runs, and the result is fed
back to the model as a ``tool_result`` so the same turn continues (FR-18).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, replace

from luicode.application.browser_agent.service import BrowserAgentService
from luicode.application.execution import ProviderExecutor
from luicode.application.routing import RoutedMessagesRequest
from luicode.core.anthropic import (
    ContentBlockText,
    ContentBlockToolResult,
    ContentBlockToolUse,
    Message,
    MessagesRequest,
    Tool,
    aggregate_anthropic_sse_to_message,
)
from luicode.core.browser_agent import BrowseRunResult, untrusted_page_payload
from luicode.core.trace import close_stream_input, trace_event

BROWSE_WEB_TOOL_NAME = "browse_web"

# A turn that keeps re-entering the provider is bounded so a model that keeps
# asking for browse_web cannot loop forever.
MAX_CONTINUATIONS = 4

BROWSE_WEB_DESCRIPTION = (
    "Delegate a web task to a browser agent driving the user's real Chrome. Give a "
    "starting url and a concrete goal; the agent navigates, clicks, and types until "
    "the goal is met, then returns the final page text. Use this instead of guessing "
    "page contents. Example: url='https://docs.example.com', goal='find the pip "
    "install command for this library'."
)

BROWSE_WEB_INPUT_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "url": {"type": "string", "description": "http or https URL to start from."},
        "goal": {
            "type": "string",
            "description": "What to accomplish on the page, stated as a short task.",
        },
    },
    "required": ["url", "goal"],
    "additionalProperties": False,
}


@dataclass(frozen=True, slots=True)
class BrowseWebInterceptor:
    """Own one request's browse_web interception state."""

    service: BrowserAgentService
    executor: ProviderExecutor

    def try_stream_messages(
        self, routed: RoutedMessagesRequest, *, request_id: str
    ) -> AsyncIterator[str] | None:
        """Return a lazy body only when browse_web is offered and usable."""
        if not self.service.enabled:
            return None
        if not self._should_offer(routed.request):
            return None
        return self._stream_with_browse(routed, request_id=request_id)

    # ------------------------------------------------------------------ policy

    def _should_offer(self, request: MessagesRequest) -> bool:
        """Offer browse_web unless the client opted out or forced a tool choice."""
        if any(tool.name == BROWSE_WEB_TOOL_NAME for tool in request.tools or []):
            return False
        choice = request.tool_choice
        # A forced or disabled tool_choice is an explicit client instruction.
        return not (isinstance(choice, dict) and choice.get("type") in {"tool", "none"})

    def _with_browse_tool(self, request: MessagesRequest) -> MessagesRequest:
        return request.model_copy(
            update={
                "tools": [
                    *(request.tools or []),
                    Tool(
                        name=BROWSE_WEB_TOOL_NAME,
                        description=BROWSE_WEB_DESCRIPTION,
                        input_schema=dict(BROWSE_WEB_INPUT_SCHEMA),
                    ),
                ]
            },
            deep=True,
        )

    # --------------------------------------------------------------- streaming

    async def _stream_with_browse(
        self, routed: RoutedMessagesRequest, *, request_id: str
    ) -> AsyncIterator[str]:
        """Run the turn, answering any browse_web call locally and continuing."""
        request = self._with_browse_tool(routed.request)
        working = replace(routed, request=request)
        continuations = 0

        while True:
            message, chunks = await self._collect(working, request_id)
            if message is None:
                for chunk in chunks:
                    yield chunk
                return

            calls = _browse_calls(message)
            if not calls or continuations >= MAX_CONTINUATIONS:
                for chunk in chunks:
                    yield chunk
                return

            continuations += 1
            trace_event(
                stage="execution",
                event="luicode.browser_agent.continuation",
                source="api",
                request_id=request_id,
                call_count=len(calls),
                continuation=continuations,
            )

            # One assistant turn carrying the tool_use blocks, then one user turn
            # per tool_result, which is the shape the Anthropic protocol requires.
            result_blocks: list[ContentBlockToolResult] = []
            for call in calls:
                url, goal = _call_arguments(call)
                result = await self.service.run(
                    url=url, goal=goal, request_id=request_id
                )
                tool_use_id = call["id"]
                assert isinstance(tool_use_id, str)
                result_blocks.append(_tool_result_block(tool_use_id, result))

            working = replace(
                working,
                request=_append_turns(
                    working.request,
                    [
                        _assistant_turn(message.get("content")),
                        Message(role="user", content=result_blocks),
                    ],
                ),
            )

    async def _collect(
        self, routed: RoutedMessagesRequest, request_id: str
    ) -> tuple[dict[str, object] | None, list[str]]:
        """Buffer one provider stream and fold it into a Message, or replay it.

        Returns ``(None, chunks)`` when the turn must be passed through verbatim:
        a stream error, or a provider that never completed a message.
        """
        provider_stream = self.executor.stream_messages(
            routed,
            raw_log_payload=routed.request.model_dump(),
            request_id=request_id,
        )
        chunks: list[str] = []
        error: BaseException | None = None
        try:
            chunks.extend([chunk async for chunk in provider_stream])
        except BaseException as exc:
            error = exc
        finally:
            await close_stream_input(
                provider_stream,
                owner="browser_agent",
                source="api",
                preserved_error=error,
            )
        if error is not None:
            raise error

        message, stream_error, complete = await aggregate_anthropic_sse_to_message(
            _iterate(chunks)
        )
        if stream_error is not None or not complete:
            return None, chunks
        return message, chunks


async def _iterate(chunks: list[str]) -> AsyncIterator[str]:
    for chunk in chunks:
        yield chunk


def _browse_calls(message: dict[str, object]) -> list[dict[str, object]]:
    content = message.get("content")
    if not isinstance(content, list):
        return []
    return [
        block
        for block in content
        if isinstance(block, dict)
        and block.get("type") == "tool_use"
        and block.get("name") == BROWSE_WEB_TOOL_NAME
        and isinstance(block.get("id"), str)
    ]


def _call_arguments(call: dict[str, object]) -> tuple[str, str]:
    arguments = call.get("input")
    if isinstance(arguments, dict):
        url = arguments.get("url")
        goal = arguments.get("goal")
        return (
            url.strip() if isinstance(url, str) else "",
            goal.strip() if isinstance(goal, str) else "",
        )
    return "", ""


def _assistant_turn(content: object) -> Message:
    """Re-emit the provider's assistant content so the transcript stays valid."""
    blocks: list[ContentBlockText | ContentBlockToolUse] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")
            if kind == "tool_use":
                raw_input = block.get("input")
                blocks.append(
                    ContentBlockToolUse(
                        type="tool_use",
                        id=str(block.get("id", "")),
                        name=str(block.get("name", "")),
                        input=raw_input if isinstance(raw_input, dict) else {},
                    )
                )
            elif kind == "text":
                blocks.append(
                    ContentBlockText(type="text", text=str(block.get("text", "")))
                )
    return Message(role="assistant", content=blocks)


def _tool_result_block(
    tool_use_id: str, result: BrowseRunResult
) -> ContentBlockToolResult:
    return ContentBlockToolResult(
        type="tool_result",
        tool_use_id=tool_use_id,
        content=untrusted_page_payload(result),
        is_error=not result.ok,
    )


def _append_turns(request: MessagesRequest, turns: list[Message]) -> MessagesRequest:
    return request.model_copy(
        update={"messages": [*request.messages, *turns]},
        deep=True,
    )
