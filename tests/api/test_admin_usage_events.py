"""Tests for the Admin Usage live event feed."""

import asyncio

import pytest
import pytest_asyncio
from fastapi.routing import APIRoute
from fastapi.sse import EventSourceResponse
from fastapi.testclient import TestClient

from luicode.api.admin_routes import router as admin_router
from luicode.api.admin_routes import usage_events
from luicode.application.session_events import EventOverflowError
from luicode.application.usage.record import RequestUsage
from luicode.runtime.application import USAGE_EVENT_QUEUE_SIZE, ApplicationRuntime
from luicode.runtime.usage_sqlite import UsageDatabase
from tests.api.support import create_test_app, runtime_for_app


class CommitCounter:
    """Records commit notifications so tests can await writer progress."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(self) -> None:
        self.count += 1

    async def wait_for(self, expected: int) -> None:
        for _ in range(400):
            if self.count >= expected:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"expected {expected} commits, saw {self.count}")


def _request_row(request_id: str) -> RequestUsage:
    return RequestUsage(
        id=f"id-{request_id}",
        request_id=request_id,
        started_ms=1,
        ended_ms=2,
        agent="claude-code",
        gateway_model="sonnet",
        provider_id="anthropic",
        provider_model="claude-sonnet-4",
        wire_api="anthropic",
        input_tokens=10,
        output_tokens=5,
        cost_usd=0.01,
        cost_source="table",
    )


def _runtime(app) -> ApplicationRuntime:
    runtime = runtime_for_app(app)
    assert isinstance(runtime, ApplicationRuntime)
    return runtime


@pytest_asyncio.fixture
async def isolated_usage_database(monkeypatch, tmp_path):
    """Keep the process-wide usage database out of the real user store."""
    database = UsageDatabase(
        db_path=tmp_path / "usage.db", lock_path=tmp_path / "usage.lock"
    )
    await database.initialize()

    async def provide() -> UsageDatabase:
        return database

    monkeypatch.setattr("luicode.runtime.usage_sqlite.get_usage_database", provide)
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_committed_rows_reach_subscribers_as_visible_data(
    isolated_usage_database,
):
    """A reader reacting to the event must never refetch stale state."""
    runtime = _runtime(create_test_app())
    subscription = runtime.subscribe_usage_events()
    assert subscription.cursor == 0

    database = await runtime.usage_database()
    assert database is isolated_usage_database
    await database.write_batch([_request_row("live-1")], [])

    events = []
    async for event in subscription:
        events.append(event)
        break

    assert [event.event for event in events] == ["usage.updated"]
    published_at = events[0].data["at_ms"]
    assert isinstance(published_at, int) and published_at > 0
    # The row the event announced is already queryable.
    assert len(database.query_requests(since_ms=0)) == 1
    await subscription.aclose()


@pytest.mark.asyncio
async def test_several_commits_are_all_announced_in_order(isolated_usage_database):
    runtime = _runtime(create_test_app())
    subscription = runtime.subscribe_usage_events()
    database = await runtime.usage_database()

    await database.write_batch([_request_row("a")], [])
    await database.write_batch([_request_row("b")], [])

    received = []
    for _ in range(2):
        async for event in subscription:
            received.append(event.id)
            break

    assert received == sorted(received)
    assert len(set(received)) == 2
    await subscription.aclose()


@pytest.mark.asyncio
async def test_a_slow_observer_is_told_to_resync(isolated_usage_database):
    """Overflow drops the subscriber instead of blocking the writer."""
    runtime = _runtime(create_test_app())
    subscription = runtime.subscribe_usage_events()
    publisher = runtime.usage_event_publisher
    assert publisher is not None

    for index in range(USAGE_EVENT_QUEUE_SIZE + 1):
        publisher.publish("usage.updated", {"at_ms": index})

    with pytest.raises(EventOverflowError):
        async for _ in subscription:
            pass

    await subscription.aclose()


@pytest.mark.asyncio
async def test_a_late_subscriber_sees_only_later_commits(isolated_usage_database):
    runtime = _runtime(create_test_app())
    database = await runtime.usage_database()
    counter = CommitCounter()
    database.on_committed = counter

    await database.write_batch([_request_row("before")], [])
    await counter.wait_for(1)

    subscription = runtime.subscribe_usage_events()
    # The new subscriber starts after committed history, so it catches up
    # through a fresh read rather than a replayed event.
    assert len(database.query_requests(since_ms=0)) == 1
    await subscription.aclose()


@pytest.mark.asyncio
async def test_closing_the_runtime_finishes_open_feeds(isolated_usage_database):
    runtime = _runtime(create_test_app())
    subscription = runtime.subscribe_usage_events()

    await runtime.close()

    assert [event async for event in subscription] == []


@pytest.mark.asyncio
async def test_usage_feed_opens_with_a_ready_frame(isolated_usage_database):
    """The opening frame lets the client synchronize before any event arrives."""
    app = create_test_app()

    frames = usage_events(services=app.state.services)
    ready = await frames.__anext__()
    await frames.aclose()

    assert ready.event == "feed.ready"
    assert ready.data == {"cursor": 0}
    assert ready.retry == 1000


def test_usage_feed_is_declared_as_an_event_stream():
    route = next(
        route
        for route in admin_router.routes
        if isinstance(route, APIRoute) and route.path == "/admin/api/usage/events"
    )
    assert route.response_class is EventSourceResponse


def test_usage_feed_is_rejected_before_the_stream_starts():
    """A 403 must be a real response, not an error inside an open stream."""
    app = create_test_app()
    client = TestClient(app, base_url="http://127.0.0.1", client=("10.0.0.5", 9))
    response = client.get("/admin/api/usage/events")
    assert response.status_code == 403
    assert "event-stream" not in response.headers.get("content-type", "")
