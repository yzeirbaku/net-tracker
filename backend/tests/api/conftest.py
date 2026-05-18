"""API-test fixtures: a clean Postgres schema per test plus an httpx AsyncClient.

We use a single test database (TEST_DATABASE_URL env, defaulting to local Docker).
Between tests, we TRUNCATE all user-data tables (cascade). Schema bootstrap runs
once at session start via the autouse `_bootstrap_schema` fixture.
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


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _bootstrap_schema() -> AsyncIterator[None]:
    await _ensure_test_db()
    os.environ["DATABASE_URL"] = _dsn()
    await db.init_pool()
    yield
    await db.close_pool()


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables() -> AsyncIterator[None]:
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE accounts, categories, sessions, magic_links, users "
            "RESTART IDENTITY CASCADE"
        )
    yield


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
