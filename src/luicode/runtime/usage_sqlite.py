"""SQLite persistence for usage records, mirroring code_sessions_sqlite.py patterns."""

import asyncio
import sqlite3
import time
from collections.abc import Callable
from contextlib import closing, suppress
from pathlib import Path
from typing import Any

import anyio.to_thread

from luicode.application.usage.record import (
    OptimizationSaving,
    RequestUsage,
)
from luicode.config.paths import usage_database_path, usage_lock_path
from luicode.core.interprocess_lock import InterprocessFileLock

_SCHEMA_VERSION = 1

_CREATE_SQL = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS request_usage (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    ended_ms INTEGER,
    agent TEXT NOT NULL,
    gateway_model TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_model TEXT NOT NULL,
    wire_api TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttfb_ms INTEGER NOT NULL DEFAULT 0,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    fallback_path TEXT NOT NULL DEFAULT '[]',
    outcome TEXT NOT NULL,
    failure_kind TEXT,
    status_code INTEGER,
    error_message TEXT,
    cost_usd REAL,
    cost_source TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_request_usage_started ON request_usage(started_ms);
CREATE INDEX IF NOT EXISTS idx_request_usage_provider ON request_usage(provider_id);
CREATE INDEX IF NOT EXISTS idx_request_usage_agent ON request_usage(agent);
CREATE INDEX IF NOT EXISTS idx_request_usage_request_id ON request_usage(request_id);

CREATE TABLE IF NOT EXISTS optimization_savings (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    optimization TEXT NOT NULL,
    saved_input_tokens INTEGER NOT NULL DEFAULT 0,
    saved_output_tokens INTEGER NOT NULL DEFAULT 0,
    saved_cost_usd REAL,
    cost_source TEXT NOT NULL DEFAULT 'unknown'
);

CREATE INDEX IF NOT EXISTS idx_opt_savings_request ON optimization_savings(request_id);
CREATE INDEX IF NOT EXISTS idx_opt_savings_at ON optimization_savings(at_ms);
CREATE INDEX IF NOT EXISTS idx_opt_savings_optimization ON optimization_savings(optimization);
"""

_RETENTION_SQL = """
DELETE FROM request_usage
WHERE started_ms < ?
AND id NOT IN (
    SELECT id FROM request_usage ORDER BY started_ms DESC LIMIT ?
);
DELETE FROM optimization_savings
WHERE at_ms < ?
AND id NOT IN (
    SELECT id FROM optimization_savings ORDER BY at_ms DESC LIMIT ?
);
"""

# Chart buckets, smallest first. The widest window that stays under the point
# budget wins, so a one-hour view resolves per minute while a month resolves
# per day instead of drawing an unusable 720-point line.
_TIMESERIES_BUCKETS_MS = (
    60_000,
    5 * 60_000,
    15 * 60_000,
    60 * 60_000,
    6 * 3600_000,
    24 * 3600_000,
)
_TIMESERIES_MAX_POINTS = 120


class UsageDatabase:
    """Async SQLite writer with background flush, matching code_sessions_sqlite.py."""

    def __init__(
        self,
        db_path: Path | None = None,
        lock_path: Path | None = None,
        max_rows: int = 100000,
        retention_days: int = 90,
    ) -> None:
        # Resolve paths per instance rather than at import, so the store always
        # follows the current configuration instead of the process start-up one.
        self._db_path = db_path if db_path is not None else usage_database_path()
        self._lock_path = lock_path if lock_path is not None else usage_lock_path()
        self._max_rows = max_rows
        self._retention_ms = retention_days * 24 * 60 * 60 * 1000
        self._queue: asyncio.Queue[
            tuple[list[RequestUsage], list[OptimizationSaving]]
        ] = asyncio.Queue()
        self._writer_task: asyncio.Task[None] | None = None
        self._closed = False
        self._lock = InterprocessFileLock(self._lock_path)
        # Live Admin observers subscribe to committed rows, not queued ones, so
        # they never refetch before the batch they were told about is visible.
        self.on_committed: Callable[[], None] | None = None
        self.commit_count = 0

    async def initialize(self) -> None:
        await self._run_migrations()
        self._writer_task = asyncio.create_task(self._writer_loop())

    async def _run_migrations(self) -> None:
        await anyio.to_thread.run_sync(self._locked_migrate)

    def _locked_migrate(self) -> None:
        with self._lock:
            self._sync_migrate()

    def _sync_migrate(self) -> None:
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self._db_path)) as conn:
            conn.executescript(_CREATE_SQL)
            cursor = conn.execute("SELECT version FROM schema_version")
            row = cursor.fetchone()
            current_version = row[0] if row else 0
            if current_version < _SCHEMA_VERSION:
                conn.execute(
                    "INSERT OR REPLACE INTO schema_version (version) VALUES (?)",
                    (_SCHEMA_VERSION,),
                )
            conn.commit()

    async def write_batch(
        self,
        requests: list[RequestUsage],
        optimizations: list[OptimizationSaving],
    ) -> None:
        if self._closed:
            return
        await self._queue.put((requests, optimizations))

    async def close(self) -> None:
        self._closed = True
        if self._writer_task:
            self._writer_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._writer_task
        # Drain remaining
        while not self._queue.empty():
            reqs, opts = self._queue.get_nowait()
            await anyio.to_thread.run_sync(self._sync_write_batch, reqs, opts)

    async def _writer_loop(self) -> None:
        while not self._closed:
            try:
                reqs, opts = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                await anyio.to_thread.run_sync(self._sync_write_batch, reqs, opts)
                self._notify_committed()
                # Periodic retention cleanup
                if self._should_cleanup():
                    await anyio.to_thread.run_sync(self._sync_retention)
            except TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception:
                # Swallow - never let persistence errors affect request path
                pass

    def _notify_committed(self) -> None:
        """Announce visible rows to observers. Never raise into the writer loop."""
        self.commit_count += 1
        callback = self.on_committed
        if callback is None:
            return
        with suppress(Exception):
            callback()

    def _should_cleanup(self) -> bool:
        # Run retention ~once per hour
        return int(time.time()) % 3600 < 2

    def _sync_write_batch(
        self,
        requests: list[RequestUsage],
        optimizations: list[OptimizationSaving],
    ) -> None:
        if not requests and not optimizations:
            return
        with closing(sqlite3.connect(self._db_path, timeout=5.0)) as conn:
            if requests:
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO request_usage (
                        id, request_id, started_ms, ended_ms, agent, gateway_model,
                        provider_id, provider_model, wire_api, input_tokens, output_tokens,
                        cache_read_input_tokens, cache_creation_input_tokens,
                        estimated_input_tokens, latency_ms, ttfb_ms, attempt_count,
                        fallback_path, outcome, failure_kind, status_code, error_message,
                        cost_usd, cost_source
                    ) VALUES (
                        :id, :request_id, :started_ms, :ended_ms, :agent, :gateway_model,
                        :provider_id, :provider_model, :wire_api, :input_tokens, :output_tokens,
                        :cache_read_input_tokens, :cache_creation_input_tokens,
                        :estimated_input_tokens, :latency_ms, :ttfb_ms, :attempt_count,
                        :fallback_path, :outcome, :failure_kind, :status_code, :error_message,
                        :cost_usd, :cost_source
                    )
                    """,
                    [r.to_row() for r in requests],
                )
            if optimizations:
                conn.executemany(
                    """
                    INSERT OR REPLACE INTO optimization_savings (
                        id, request_id, at_ms, optimization, saved_input_tokens,
                        saved_output_tokens, saved_cost_usd, cost_source
                    ) VALUES (
                        :id, :request_id, :at_ms, :optimization, :saved_input_tokens,
                        :saved_output_tokens, :saved_cost_usd, :cost_source
                    )
                    """,
                    [o.to_row() for o in optimizations],
                )
            conn.commit()

    def _sync_retention(self) -> None:
        cutoff = int(time.time() * 1000) - self._retention_ms
        with closing(sqlite3.connect(self._db_path, timeout=5.0)) as conn:
            conn.executescript(
                _RETENTION_SQL.replace("?", str(cutoff)).replace(
                    "?", str(self._max_rows)
                )
            )
            conn.commit()

    # Read methods for Admin API
    def query_requests(
        self,
        *,
        since_ms: int | None = None,
        until_ms: int | None = None,
        provider_id: str | None = None,
        agent: str | None = None,
        outcome: str | None = None,
        limit: int = 1000,
        offset: int = 0,
    ) -> list[RequestUsage]:
        conditions = []
        params: list[Any] = []
        if since_ms is not None:
            conditions.append("started_ms >= ?")
            params.append(since_ms)
        if until_ms is not None:
            conditions.append("started_ms <= ?")
            params.append(until_ms)
        if provider_id:
            conditions.append("provider_id = ?")
            params.append(provider_id)
        if agent:
            conditions.append("agent = ?")
            params.append(agent)
        if outcome:
            conditions.append("outcome = ?")
            params.append(outcome)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        sql = f"""
            SELECT * FROM request_usage
            {where}
            ORDER BY started_ms DESC
            LIMIT ? OFFSET ?
        """
        params.extend([limit, offset])

        with closing(sqlite3.connect(self._db_path)) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(sql, params)
            return [RequestUsage.from_row(dict(row)) for row in cursor]

    def query_optimizations(
        self,
        *,
        since_ms: int | None = None,
        optimization: str | None = None,
        limit: int = 1000,
    ) -> list[OptimizationSaving]:
        conditions = []
        params: list[Any] = []
        if since_ms is not None:
            conditions.append("at_ms >= ?")
            params.append(since_ms)
        if optimization:
            conditions.append("optimization = ?")
            params.append(optimization)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""
        sql = f"""
            SELECT * FROM optimization_savings
            {where}
            ORDER BY at_ms DESC
            LIMIT ?
        """
        params.append(limit)

        with closing(sqlite3.connect(self._db_path)) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.execute(sql, params)
            return [OptimizationSaving.from_row(dict(row)) for row in cursor]

    def get_summary(self, since_ms: int | None = None) -> dict[str, Any]:
        conditions = []
        params: list[Any] = []
        if since_ms is not None:
            conditions.append("started_ms >= ?")
            params.append(since_ms)

        where = "WHERE " + " AND ".join(conditions) if conditions else ""

        with closing(sqlite3.connect(self._db_path)) as conn:
            conn.row_factory = sqlite3.Row

            # Totals
            cursor = conn.execute(
                f"""
                SELECT
                    COUNT(*) as total_requests,
                    SUM(input_tokens) as total_input,
                    SUM(output_tokens) as total_output,
                    SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as total_cost,
                    COUNT(DISTINCT provider_id) as providers_used,
                    COUNT(DISTINCT agent) as agents_used
                FROM request_usage
                {where}
            """,
                params,
            )
            totals = dict(cursor.fetchone() or {})

            # By provider
            cursor = conn.execute(
                f"""
                SELECT provider_id, provider_model,
                    COUNT(*) as requests,
                    SUM(input_tokens) as input_tokens,
                    SUM(output_tokens) as output_tokens,
                    SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as cost,
                    AVG(latency_ms) as avg_latency,
                    MAX(latency_ms) as max_latency
                FROM request_usage
                {where}
                GROUP BY provider_id, provider_model
                ORDER BY requests DESC
            """,
                params,
            )
            by_provider = [dict(r) for r in cursor]

            # By agent
            cursor = conn.execute(
                f"""
                SELECT agent,
                    COUNT(*) as requests,
                    SUM(input_tokens) as input_tokens,
                    SUM(output_tokens) as output_tokens,
                    SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as cost
                FROM request_usage
                {where}
                GROUP BY agent
                ORDER BY requests DESC
            """,
                params,
            )
            by_agent = [dict(r) for r in cursor]

            # Optimization savings
            opt_where = (
                where.replace("request_usage", "optimization_savings").replace(
                    "started_ms", "at_ms"
                )
                if where
                else ""
            )
            cursor = conn.execute(
                f"""
                SELECT optimization,
                    COUNT(*) as count,
                    SUM(saved_input_tokens) as saved_input,
                    SUM(saved_output_tokens) as saved_output,
                    SUM(CASE WHEN saved_cost_usd IS NOT NULL THEN saved_cost_usd ELSE 0 END) as saved_cost
                FROM optimization_savings
                {opt_where}
                GROUP BY optimization
                ORDER BY saved_input DESC
            """,
                params,
            )
            by_optimization = [dict(r) for r in cursor]

            # Time series over the same window as the totals
            bucket_ms = _timeseries_bucket_ms(since_ms)
            cursor = conn.execute(
                f"""
                SELECT
                    (started_ms / {bucket_ms}) * {bucket_ms} as bucket_ms,
                    COUNT(*) as requests,
                    SUM(input_tokens + output_tokens) as tokens,
                    SUM(CASE WHEN cost_usd IS NOT NULL THEN cost_usd ELSE 0 END) as cost
                FROM request_usage
                WHERE started_ms >= ?
                GROUP BY bucket_ms
                ORDER BY bucket_ms
            """,
                [since_ms if since_ms is not None else 0],
            )
            timeseries = [dict(r) for r in cursor]

            return {
                "totals": totals,
                "by_provider": by_provider,
                "by_agent": by_agent,
                "by_optimization": by_optimization,
                "timeseries": timeseries,
            }

    def get_first_record_ms(self) -> int | None:
        with closing(sqlite3.connect(self._db_path)) as conn:
            cursor = conn.execute("SELECT MIN(started_ms) FROM request_usage")
            row = cursor.fetchone()
            return row[0] if row and row[0] is not None else None


def _timeseries_bucket_ms(since_ms: int | None) -> int:
    """Pick the finest bucket that keeps a window under the point budget."""
    if since_ms is None:
        window_ms = 24 * 60 * 60 * 1000
    else:
        window_ms = max(int(time.time() * 1000) - since_ms, 0)
    for bucket_ms in _TIMESERIES_BUCKETS_MS:
        if window_ms // bucket_ms <= _TIMESERIES_MAX_POINTS:
            return bucket_ms
    return _TIMESERIES_BUCKETS_MS[-1]


_USAGE_DB_INSTANCE: UsageDatabase | None = None
# Concurrent Admin reads must not observe an instance whose migration has not
# finished, so creation is serialized rather than checked and awaited.
_USAGE_DB_LOCK = asyncio.Lock()


async def get_usage_database() -> UsageDatabase:
    global _USAGE_DB_INSTANCE
    if _USAGE_DB_INSTANCE is None:
        async with _USAGE_DB_LOCK:
            if _USAGE_DB_INSTANCE is None:
                database = UsageDatabase()
                await database.initialize()
                _USAGE_DB_INSTANCE = database
    return _USAGE_DB_INSTANCE


async def close_usage_database() -> None:
    global _USAGE_DB_INSTANCE
    async with _USAGE_DB_LOCK:
        if _USAGE_DB_INSTANCE:
            await _USAGE_DB_INSTANCE.close()
            _USAGE_DB_INSTANCE = None
