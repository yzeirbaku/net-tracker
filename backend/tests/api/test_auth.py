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


async def test_verify_creates_session_and_user(client: AsyncClient) -> None:
    import hashlib
    import secrets
    from datetime import UTC, datetime, timedelta

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, created_ip) "
            "VALUES ($1, $2, $3, $4)",
            token_hash,
            "verify@example.com",
            datetime.now(UTC) + timedelta(minutes=15),
            "127.0.0.1",
        )

    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "verify@example.com"
    assert "user_id" in body and "token" in body


async def test_verify_rejects_used_token(client: AsyncClient) -> None:
    import hashlib
    import secrets
    from datetime import UTC, datetime, timedelta

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, used_at, created_ip) "
            "VALUES ($1, $2, $3, $4, $5)",
            token_hash,
            "used@example.com",
            datetime.now(UTC) + timedelta(minutes=15),
            datetime.now(UTC),
            "127.0.0.1",
        )
    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json()["detail"] == "token_used"


async def test_verify_rejects_expired_token(client: AsyncClient) -> None:
    import hashlib
    import secrets
    from datetime import UTC, datetime, timedelta

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, created_ip) "
            "VALUES ($1, $2, $3, $4)",
            token_hash,
            "exp@example.com",
            datetime.now(UTC) - timedelta(minutes=1),
            "127.0.0.1",
        )
    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json()["detail"] == "token_expired"


async def test_me_requires_bearer(client: AsyncClient) -> None:
    r = await client.get("/auth/me")
    assert r.status_code == 401


async def test_me_returns_user(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get(
        "/auth/me", headers={"Authorization": f"Bearer {authed_user['token']}"}
    )
    assert r.status_code == 200
    assert r.json()["email"] == authed_user["email"]


async def test_logout_deletes_session(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = {"Authorization": f"Bearer {authed_user['token']}"}
    r = await client.post("/auth/logout", headers=headers)
    assert r.status_code == 204

    r = await client.get("/auth/me", headers=headers)
    assert r.status_code == 401
