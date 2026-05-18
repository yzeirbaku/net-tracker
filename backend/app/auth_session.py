"""Magic-link auth + bearer-token sessions.

Magic links: SHA-256-hashed tokens with 15-min TTL, one-use, rate-limited.
Sessions: opaque UUIDs in `sessions.id`, 90-day sliding TTL, 1-h debounce on last_seen_at.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response

from app import db, email
from app.models import MagicLinkRequest, MagicLinkVerify, SessionOut, UserOut

router = APIRouter(prefix="/auth", tags=["auth"])

MAGIC_LINK_TTL_MIN = 15
SESSION_LAST_SEEN_DEBOUNCE = timedelta(hours=1)
SESSION_MAX_AGE = timedelta(days=90)

RATE_PER_EMAIL_WINDOW = timedelta(minutes=10)
RATE_PER_EMAIL_MAX = 3
RATE_PER_IP_WINDOW = timedelta(hours=1)
RATE_PER_IP_MAX = 30


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


@router.post("/request-link", status_code=204)
async def request_link(payload: MagicLinkRequest, request: Request) -> Response:
    ip = _client_ip(request)
    pool = db.pool()
    async with pool.acquire() as conn:
        now = datetime.now(UTC)
        per_email = await conn.fetchval(
            "SELECT COUNT(*) FROM magic_links WHERE email = $1 AND created_at > $2",
            payload.email,
            now - RATE_PER_EMAIL_WINDOW,
        )
        if per_email >= RATE_PER_EMAIL_MAX:
            return Response(status_code=204)
        per_ip = await conn.fetchval(
            "SELECT COUNT(*) FROM magic_links WHERE created_ip = $1 AND created_at > $2",
            ip,
            now - RATE_PER_IP_WINDOW,
        )
        if per_ip >= RATE_PER_IP_MAX:
            return Response(status_code=204)

        token = secrets.token_urlsafe(32)
        expires_at = now + timedelta(minutes=MAGIC_LINK_TTL_MIN)
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, created_ip) "
            "VALUES ($1, $2, $3, $4)",
            _hash(token),
            payload.email,
            expires_at,
            ip,
        )

    base = os.environ.get("MAGIC_LINK_BASE_URL", "")
    link = f"{base}/#auth={token}"
    await email.send_magic_link(to=payload.email, link=link)
    return Response(status_code=204)


@router.post("/verify", response_model=SessionOut)
async def verify(payload: MagicLinkVerify) -> SessionOut:
    pool = db.pool()
    now = datetime.now(UTC)
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "SELECT email, expires_at, used_at FROM magic_links "
            "WHERE token_hash = $1 FOR UPDATE",
            _hash(payload.token),
        )
        if row is None:
            raise HTTPException(status_code=400, detail="invalid_token")
        if row["used_at"] is not None:
            raise HTTPException(status_code=400, detail="token_used")
        if row["expires_at"] < now:
            raise HTTPException(status_code=400, detail="token_expired")

        await conn.execute(
            "UPDATE magic_links SET used_at = $1 WHERE token_hash = $2",
            now,
            _hash(payload.token),
        )
        user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) "
            "ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email "
            "RETURNING id",
            row["email"],
        )
        session_id = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id",
            user_id,
        )
    return SessionOut(user_id=user_id, email=row["email"], token=session_id)


async def require_session(
    authorization: str | None = Header(default=None),
) -> dict[str, UUID]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing_bearer")
    token = authorization[len("Bearer "):].strip()
    try:
        session_id = UUID(token)
    except ValueError as e:
        raise HTTPException(status_code=401, detail="bad_token") from e

    pool = db.pool()
    now = datetime.now(UTC)
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT user_id, last_seen_at, created_at FROM sessions WHERE id = $1",
            session_id,
        )
        if row is None:
            raise HTTPException(status_code=401, detail="no_session")
        if row["created_at"] + SESSION_MAX_AGE < now:
            raise HTTPException(status_code=401, detail="session_expired")
        if now - row["last_seen_at"] > SESSION_LAST_SEEN_DEBOUNCE:
            await conn.execute(
                "UPDATE sessions SET last_seen_at = $1 WHERE id = $2", now, session_id
            )
        return {"session_id": session_id, "user_id": row["user_id"]}


@router.get("/me", response_model=UserOut)
async def me(session: dict[str, UUID] = Depends(require_session)) -> UserOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        email_val = await conn.fetchval(
            "SELECT email FROM users WHERE id = $1", session["user_id"]
        )
    if email_val is None:
        raise HTTPException(status_code=401, detail="user_missing")
    return UserOut(user_id=session["user_id"], email=email_val)


@router.post("/logout", status_code=204)
async def logout(session: dict[str, UUID] = Depends(require_session)) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM sessions WHERE id = $1", session["session_id"])
    return Response(status_code=204)
