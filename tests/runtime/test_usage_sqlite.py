"""Tests for usage SQLite persistence, commit notification, and time series."""

import asyncio
import time

import pytest
import pytest_asyncio

from luicode.application.usage.record import RequestUsage
from luicode.runtime.usage_sqlite import UsageDatabase, _timeseries_bucket_ms


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


def _request_row(request_id: str, started_ms: int) -> RequestUsage:
    return RequestUsage(
        id=f"id-{request_id}",
        request_id=request_id,
        started_ms=started_ms,
        ended_ms=started_ms + 100,
        agent="claude-code",
        gateway_model="sonnet",
        provider_id="anthropic",
        provider_model="claude-sonnet-4",
        wire_api="anthropic",
        input_tokens=100,
        output_tokens=50,
        cost_usd=0.01,
        cost_source="table",
        fallback_path=("primary", "secondary"),
    )


@pytest.fixture
def database(tmp_path):
    return UsageDatabase(
        db_path=tmp_path / "usage.db", lock_path=tmp_path / "usage.lock"
    )


@pytest_asyncio.fixture
async def initialized_database(database):
    await database.initialize()
    yield database
    await database.close()


@pytest.mark.asyncio
async def test_each_committed_batch_announces_exactly_once(initialized_database):
    counter = CommitCounter()
    initialized_database.on_committed = counter

    now = int(time.time() * 1000)
    await initialized_database.write_batch([_request_row("a", now)], [])
    await initialized_database.write_batch([_request_row("b", now)], [])
    await counter.wait_for(2)
    await initialized_database.close()

    assert counter.count == 2
    assert len(initialized_database.query_requests(since_ms=0)) == 2


@pytest.mark.asyncio
async def test_notification_lands_after_the_rows_are_visible(initialized_database):
    """A reader reacting to the event must never refetch stale state."""
    visible_at_notify: list[int] = []
    counter = CommitCounter()

    def observe() -> None:
        visible_at_notify.append(len(initialized_database.query_requests(since_ms=0)))
        counter()

    initialized_database.on_committed = observe

    now = int(time.time() * 1000)
    await initialized_database.write_batch([_request_row("a", now)], [])
    await counter.wait_for(1)
    await initialized_database.close()

    assert visible_at_notify == [1]


@pytest.mark.asyncio
async def test_empty_batch_announces_nothing(initialized_database):
    counter = CommitCounter()
    initialized_database.on_committed = counter

    await initialized_database.write_batch([], [])
    await initialized_database.close()

    assert counter.count == 0


@pytest.mark.asyncio
async def test_raising_observer_does_not_stop_the_writer(initialized_database):
    def explode() -> None:
        raise RuntimeError("observer failed")

    initialized_database.on_committed = explode
    now = int(time.time() * 1000)

    await initialized_database.write_batch([_request_row("a", now)], [])
    await initialized_database.write_batch([_request_row("b", now)], [])
    # A second batch only commits if the first failure did not kill the loop.
    for _ in range(400):
        if len(initialized_database.query_requests(since_ms=0)) == 2:
            break
        await asyncio.sleep(0.01)
    await initialized_database.close()

    assert len(initialized_database.query_requests(since_ms=0)) == 2


@pytest.mark.asyncio
async def test_no_observer_registered_is_not_an_error(database):
    await database.initialize()
    now = int(time.time() * 1000)
    await database.write_batch([_request_row("a", now)], [])
    for _ in range(400):
        if database.query_requests(since_ms=0):
            break
        await asyncio.sleep(0.01)
    await database.close()

    assert len(database.query_requests(since_ms=0)) == 1


@pytest.mark.asyncio
@pytest.mark.asyncio
async def test_request_payload_keeps_the_fallback_chain_as_a_list(
    initialized_database,
):
    """Storage text must not leak into the Admin API as a JSON string."""
    now = int(time.time() * 1000)
    record = _request_row("chained", now)
    await initialized_database.write_batch([record], [])
    for _ in range(400):
        if initialized_database.query_requests(since_ms=0):
            break
        await asyncio.sleep(0.01)

    stored = initialized_database.query_requests(since_ms=0)[0]
    assert isinstance(stored.to_row()["fallback_path"], str)

    payload = stored.as_dict()
    assert payload["fallback_path"] == ["primary", "secondary"]
    assert payload["outcome"] == "success"


@pytest.mark.asyncio
async def test_concurrent_readers_never_see_an_unmigrated_store(monkeypatch, tmp_path):
    """Two Admin reads arriving together must not race the migration."""
    import luicode.runtime.usage_sqlite as usage_sqlite

    class SlowStore:
        instances = 0

        def __init__(self, *_args, **_kwargs) -> None:
            SlowStore.instances += 1
            self.initialized = False

        async def initialize(self) -> None:
            # Yield control so a second caller could slip in mid-migration.
            await asyncio.sleep(0.01)
            self.initialized = True

        async def close(self) -> None:
            self.initialized = False

    monkeypatch.setattr(usage_sqlite, "UsageDatabase", SlowStore)
    monkeypatch.setattr(usage_sqlite, "_USAGE_DB_INSTANCE", None)

    stores = await asyncio.gather(
        usage_sqlite.get_usage_database(), usage_sqlite.get_usage_database()
    )

    assert SlowStore.instances == 1
    # One shared store, already migrated by the time either caller received it.
    assert stores[0] is stores[1]
    assert isinstance(stores[0], SlowStore)
    assert stores[0].initialized

    await usage_sqlite.close_usage_database()


@pytest.mark.asyncio
async def test_timeseries_and_totals_share_the_requested_window(initialized_database):
    now = int(time.time() * 1000)
    recent = _request_row("recent", now - 60_000)
    old = _request_row("old", now - 10 * 24 * 3600_000)
    await initialized_database.write_batch([recent, old], [])
    for _ in range(400):
        if len(initialized_database.query_requests(since_ms=0)) == 2:
            break
        await asyncio.sleep(0.01)

    summary = initialized_database.get_summary(since_ms=now - 3600_000)
    await initialized_database.close()

    assert summary["totals"]["total_requests"] == 1
    assert len(summary["timeseries"]) == 1


def test_bucket_width_scales_with_the_window():
    """Each offered range lands on the finest bucket within its point budget."""
    now = int(time.time() * 1000)
    # 1h range: 60 one-minute buckets.
    assert _timeseries_bucket_ms(now) == 60_000
    # 6h range: one minute would need 360 points, so it widens to 5 minutes.
    assert _timeseries_bucket_ms(now - 6 * 3600_000) == 5 * 60_000
    # 24h range: 5-minute buckets would need 288, so it widens to 15 minutes.
    assert _timeseries_bucket_ms(now - 24 * 3600_000) == 15 * 60_000
    # 7d range: hourly buckets would need 168, so it widens to 6 hours.
    assert _timeseries_bucket_ms(now - 7 * 24 * 3600_000) == 6 * 3600_000
    # 30d range keeps 6-hour buckets at 120 points.
    assert _timeseries_bucket_ms(now - 30 * 24 * 3600_000) == 6 * 3600_000


def test_bucket_keeps_the_point_budget_for_every_offered_range():
    now = int(time.time() * 1000)
    for hours in (1, 6, 24, 168, 720):
        bucket = _timeseries_bucket_ms(now - hours * 3600_000)
        points = (hours * 3600_000) // bucket
        assert 0 < points <= 120, hours


def test_absent_window_defaults_to_the_last_day():
    now = int(time.time() * 1000)
    assert _timeseries_bucket_ms(None) == _timeseries_bucket_ms(now - 24 * 3600_000)
