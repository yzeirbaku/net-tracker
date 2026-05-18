from httpx import AsyncClient

from app import db


async def test_request_link_returns_204_for_any_email(client: AsyncClient) -> None:
    r = await client.post("/auth/request-link", json={"email": "new@example.com"})
    assert r.status_code == 204


async def test_request_link_creates_magic_link_row(client: AsyncClient) -> None:
    r = await client.post("/auth/request-link", json={"email": "new@example.com"})
    assert r.status_code == 204

    pool = db.pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT email, expires_at, used_at FROM magic_links WHERE email = $1",
            "new@example.com",
        )
    assert row is not None
    assert row["used_at"] is None


async def test_request_link_rate_limits_per_email(client: AsyncClient) -> None:
    for _ in range(3):
        await client.post("/auth/request-link", json={"email": "rl@example.com"})
    r = await client.post("/auth/request-link", json={"email": "rl@example.com"})
    # Returns 204 anyway (no email-existence leak), but the row count must not exceed 3.
    assert r.status_code == 204

    pool = db.pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM magic_links WHERE email = $1", "rl@example.com"
        )
    assert count == 3


async def test_request_link_rejects_invalid_email(client: AsyncClient) -> None:
    r = await client.post("/auth/request-link", json={"email": "not-an-email"})
    assert r.status_code == 422
