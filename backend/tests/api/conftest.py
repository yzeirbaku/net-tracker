"""API-test fixtures: a clean Postgres schema per test plus an httpx AsyncClient.

The asyncpg pool is bound to the running event loop, so we init+close the pool
per test (function scope). Schema bootstrap is idempotent so re-running is cheap.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import asyncpg
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app import db
from app.main import app


def _dsn() -> str:
    return os.environ.get(
        "TEST_DATABASE_URL",
        "postgresql://net:net@localhost:5434/nettracker_test",
    )


async def _ensure_test_db() -> None:
    """Create the test database if missing (CREATE DATABASE can't run in a transaction)."""
    base_dsn = _dsn().rsplit("/", 1)[0] + "/postgres"
    target = _dsn().rsplit("/", 1)[1]
    conn = await asyncpg.connect(base_dsn)
    try:
        exists = await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", target)
        if not exists:
            await conn.execute(f'CREATE DATABASE "{target}"')
    finally:
        await conn.close()


@pytest_asyncio.fixture(autouse=True)
async def _db_per_test() -> AsyncIterator[None]:
    """Create test DB if needed, init pool (which runs idempotent schema bootstrap),
    truncate user tables, run the test, then close the pool.

    Function-scoped to keep the pool bound to the test's event loop.
    """
    await _ensure_test_db()
    os.environ["DATABASE_URL"] = _dsn()
    await db.init_pool()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE put_aside_items, budget_month_items, budget_month_categories, "
            "budget_months, budget_template_items, budget_template_categories, "
            "budget_templates, balance_entries, accounts, categories, sessions, "
            "magic_links, users RESTART IDENTITY CASCADE"
        )
    try:
        yield
    finally:
        await db.close_pool()


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def authed_user() -> AsyncIterator[dict[str, str]]:
    """Create a user + session directly in the DB and yield {user_id, email, token}."""
    pool = db.pool()
    async with pool.acquire() as conn:
        user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "test@example.com"
        )
        session_id = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", user_id
        )
    yield {"user_id": str(user_id), "email": "test@example.com", "token": str(session_id)}
