# Plan 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the net-tracker project skeleton — backend (FastAPI + Postgres + magic-link auth + accounts/categories CRUD) and a minimal frontend shell with login + a Settings view that can manage categories and accounts. After this plan, the user can sign in via magic link, create their three accounts and a category taxonomy, and see the green-themed PWA shell. No financial data yet.

**Architecture:** Mirrors gold-bar-tracker. Backend = FastAPI on Python 3.12 with asyncpg, single idempotent `SCHEMA_SQL` bootstrap in `db.py`, magic-link → opaque bearer-token sessions in `localStorage`. Frontend = vanilla JS PWA with ES modules, no build step. Local Postgres on docker compose port `5434`.

**Tech Stack:** Python 3.12, FastAPI, asyncpg, Pydantic v2, pytest + httpx (for API tests), ruff + mypy. Vanilla JS (ES modules), Chart.js (not used yet — added in later plans). Resend (with `MAGIC_LINK_DEV_PRINT=1` fallback for local dev). Docker for local Postgres. GitHub Actions for CI.

---

## File structure

```
net-tracker/
  backend/
    pyproject.toml                    # ruff + mypy config
    requirements.txt                  # runtime deps
    requirements-dev.txt              # test deps
    runtime.txt                       # python-3.12.x for Render
    .gitignore                        # __pycache__, .venv, etc.
    app/
      __init__.py
      main.py                         # FastAPI app, CORS, router mounting
      db.py                           # asyncpg pool + SCHEMA_SQL bootstrap
      models.py                       # Pydantic response/request models
      email.py                        # Resend wrapper + dev-print fallback
      auth_session.py                 # magic-link CRUD, sessions, require_session dep
      categories.py                   # /categories CRUD
      accounts.py                     # /accounts CRUD
    tests/
      __init__.py
      conftest.py                     # shared pytest fixtures (event loop, etc.)
      unit/
        __init__.py
        test_password_hashing.py      # placeholder; we use sha256 not bcrypt — actual unit tests for token hash
        test_models.py                # validate Pydantic models
      api/
        __init__.py
        conftest.py                   # Postgres test DB fixture; FastAPI test client
        test_auth.py                  # auth flow end-to-end against real Postgres
        test_categories.py            # categories CRUD against real Postgres
        test_accounts.py              # accounts CRUD against real Postgres
  frontend/
    index.html                        # shell + drawer + views + dialogs
    config.js                         # window.BACKEND_URL (CF Pages overwrites)
    app.js                            # shell, drawer, routing, auth wiring
    settings.js                       # settings view: theme + categories + accounts
    styles.css                        # green accent + cool-slate dark + base theme
    service-worker.js                 # minimal (iOS install only)
    manifest.webmanifest              # PWA manifest
    _headers                          # CSP + cache directives for Cloudflare Pages
    shared/
      api.js                          # fetch wrapper + bearer injection + 401 handling
      auth.js                         # login/logout/session helpers
      fmt.js                          # DKK / date / percent formatters
      ui.js                           # dialog helpers, toast, confirm
    icons/
      icon-192.png                    # placeholder
      icon-512.png                    # placeholder
  docker-compose.yml                  # local Postgres on port 5434
  .github/
    workflows/
      tests.yml                       # ruff + mypy + pytest unit + pytest api
  README.md                           # one-page setup guide
```

---

## Task 1 — Backend project scaffold

**Files:**
- Create: `backend/pyproject.toml`
- Create: `backend/requirements.txt`
- Create: `backend/requirements-dev.txt`
- Create: `backend/runtime.txt`
- Create: `backend/.gitignore`
- Create: `backend/app/__init__.py` (empty)
- Create: `backend/app/main.py`
- Create: `backend/tests/__init__.py` (empty)
- Create: `backend/tests/unit/__init__.py` (empty)
- Create: `backend/tests/api/__init__.py` (empty)
- Create: `backend/tests/conftest.py`

- [ ] **Step 1: Create `backend/pyproject.toml`**

```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "PL"]
ignore = ["PLR0913"]

[tool.mypy]
python_version = "3.12"
strict = true
warn_unused_ignores = true
ignore_missing_imports = true

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]
```

- [ ] **Step 2: Create `backend/requirements.txt`**

```
fastapi==0.115.0
uvicorn[standard]==0.32.0
asyncpg==0.30.0
pydantic==2.9.2
pydantic-settings==2.6.0
httpx==0.27.2
python-multipart==0.0.12
```

- [ ] **Step 3: Create `backend/requirements-dev.txt`**

```
-r requirements.txt
pytest==8.3.3
pytest-asyncio==0.24.0
ruff==0.7.1
mypy==1.13.0
```

- [ ] **Step 4: Create `backend/runtime.txt`**

```
python-3.12.7
```

- [ ] **Step 5: Create `backend/.gitignore`**

```
__pycache__/
*.pyc
.venv/
.env
.pytest_cache/
.mypy_cache/
.ruff_cache/
```

- [ ] **Step 6: Create `backend/app/main.py` with a health endpoint**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="net-tracker", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 7: Create empty `__init__.py` files**

Files: `backend/app/__init__.py`, `backend/tests/__init__.py`, `backend/tests/unit/__init__.py`, `backend/tests/api/__init__.py`.
Each contains a single empty line.

- [ ] **Step 8: Create `backend/tests/conftest.py`**

```python
"""Shared pytest config — currently a placeholder; sub-confest in tests/api/ owns the DB fixture."""
```

- [ ] **Step 9: Install deps and verify health endpoint**

Run:
```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate    # Windows bash; Linux/Mac: .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000 &
sleep 2
curl http://127.0.0.1:8000/
```

Expected: `{"status":"ok"}`. Kill the uvicorn process after.

- [ ] **Step 10: Run lint + type check**

Run:
```bash
ruff check app tests
mypy app
```

Expected: both pass with zero findings.

- [ ] **Step 11: Commit**

```bash
git add backend/
git commit -m "Scaffold FastAPI backend with health endpoint"
```

---

## Task 2 — Local Postgres via docker-compose

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: Create `docker-compose.yml` at repo root**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: net-tracker-pg
    environment:
      POSTGRES_USER: net
      POSTGRES_PASSWORD: net
      POSTGRES_DB: nettracker
    ports:
      - "5434:5432"
    volumes:
      - net_tracker_pg:/var/lib/postgresql/data

volumes:
  net_tracker_pg:
```

- [ ] **Step 2: Start Postgres and verify**

Run:
```bash
docker compose up -d
sleep 3
docker compose exec -T postgres psql -U net -d nettracker -c 'SELECT version();'
```

Expected: prints a `PostgreSQL 16.x ...` line.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "Add docker-compose for local Postgres on port 5434"
```

---

## Task 3 — Schema bootstrap and DB pool

**Files:**
- Create: `backend/app/db.py`
- Modify: `backend/app/main.py` (wire up startup/shutdown)

- [ ] **Step 1: Create `backend/app/db.py` with pool + SCHEMA_SQL**

```python
"""Postgres pool + idempotent schema bootstrap.

The schema is created at startup. Every CREATE / ALTER is idempotent so this
file is safe to run repeatedly. New tables go here; new columns go via
`ALTER TABLE IF EXISTS ... ADD COLUMN IF NOT EXISTS ...`.
"""

from __future__ import annotations

import os
from typing import Any

import asyncpg

_pool: asyncpg.Pool[Any] | None = None


SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS magic_links (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_ip TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
CREATE INDEX IF NOT EXISTS idx_magic_links_created_at ON magic_links(created_at);

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    exclude_from_spend BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_categories_user_id ON categories(user_id);

CREATE TABLE IF NOT EXISTS accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spending','savings','sinking_fund')),
    asset_class TEXT NOT NULL CHECK (asset_class IN ('Savings','Stocks','Crypto','Gold','Pension','Other')),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);
"""


async def init_pool() -> None:
    global _pool
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is required")
    _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10)
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool[Any]:
    if _pool is None:
        raise RuntimeError("DB pool not initialized; call init_pool() at startup")
    return _pool
```

- [ ] **Step 2: Wire startup/shutdown in `backend/app/main.py`**

Replace the contents of `backend/app/main.py`:

```python
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import close_pool, init_pool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="net-tracker", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 3: Verify schema bootstrap end-to-end**

Run:
```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker' uvicorn app.main:app --port 8000 &
sleep 3
curl http://127.0.0.1:8000/
docker compose exec -T postgres psql -U net -d nettracker -c '\dt'
```

Expected: health returns `{"status":"ok"}` and the `\dt` output lists `users`, `magic_links`, `sessions`, `categories`, `accounts`. Kill uvicorn.

- [ ] **Step 4: Run lint + types**

```bash
ruff check app tests
mypy app
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add backend/app/db.py backend/app/main.py
git commit -m "Add asyncpg pool and idempotent SCHEMA_SQL bootstrap"
```

---

## Task 4 — Pydantic models

**Files:**
- Create: `backend/app/models.py`
- Create: `backend/tests/unit/test_models.py`

- [ ] **Step 1: Write failing test in `backend/tests/unit/test_models.py`**

```python
from datetime import datetime
from uuid import uuid4

from app.models import (
    AccountCreate,
    AccountOut,
    AssetClass,
    AccountKind,
    CategoryCreate,
    CategoryOut,
)


def test_category_create_strips_name() -> None:
    c = CategoryCreate(name="  Groceries  ")
    assert c.name == "Groceries"


def test_category_create_rejects_empty() -> None:
    import pytest

    with pytest.raises(ValueError):
        CategoryCreate(name="   ")


def test_account_create_validates_kind() -> None:
    import pytest

    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="bogus", asset_class="Savings")  # type: ignore[arg-type]


def test_account_create_validates_asset_class() -> None:
    import pytest

    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="spending", asset_class="Foo")  # type: ignore[arg-type]


def test_category_out_round_trip() -> None:
    payload = {
        "id": uuid4(),
        "name": "Groceries",
        "color": "#6ba47a",
        "exclude_from_spend": False,
        "sort_order": 0,
        "created_at": datetime.utcnow(),
    }
    out = CategoryOut(**payload)
    assert out.name == "Groceries"


def test_account_kind_enum_values() -> None:
    assert {k.value for k in AccountKind} == {"spending", "savings", "sinking_fund"}


def test_asset_class_enum_values() -> None:
    assert {a.value for a in AssetClass} == {
        "Savings",
        "Stocks",
        "Crypto",
        "Gold",
        "Pension",
        "Other",
    }
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd backend
pytest tests/unit/test_models.py -v
```

Expected: FAIL — `app.models` doesn't exist yet.

- [ ] **Step 3: Implement `backend/app/models.py`**

```python
"""Pydantic models for request/response payloads and shared enums."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AccountKind(str, Enum):
    SPENDING = "spending"
    SAVINGS = "savings"
    SINKING_FUND = "sinking_fund"


class AssetClass(str, Enum):
    SAVINGS = "Savings"
    STOCKS = "Stocks"
    CRYPTO = "Crypto"
    GOLD = "Gold"
    PENSION = "Pension"
    OTHER = "Other"


def _strip(v: str) -> str:
    return v.strip()


def _strip_nonempty(v: str) -> str:
    stripped = v.strip()
    if not stripped:
        raise ValueError("must not be empty after stripping whitespace")
    return stripped


class CategoryCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    color: str | None = None
    exclude_from_spend: bool = False
    sort_order: int = 0

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)


class CategoryUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    exclude_from_spend: bool | None = None
    sort_order: int | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    color: str | None
    exclude_from_spend: bool
    sort_order: int
    created_at: datetime


class AccountCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    kind: AccountKind
    asset_class: AssetClass
    sort_order: int = 0

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)


class AccountUpdate(BaseModel):
    name: str | None = None
    asset_class: AssetClass | None = None
    sort_order: int | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    kind: AccountKind
    asset_class: AssetClass
    sort_order: int
    created_at: datetime


class MagicLinkRequest(BaseModel):
    email: Annotated[str, Field(min_length=3, max_length=320)]

    @field_validator("email")
    @classmethod
    def _validate_email(cls, v: str) -> str:
        stripped = v.strip().lower()
        if "@" not in stripped or "." not in stripped.split("@", 1)[1]:
            raise ValueError("not a valid email")
        return stripped


class MagicLinkVerify(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=128)]


class SessionOut(BaseModel):
    user_id: UUID
    email: str
    token: UUID


class UserOut(BaseModel):
    user_id: UUID
    email: str
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pytest tests/unit/test_models.py -v
```

Expected: PASS for all 7 tests.

- [ ] **Step 5: Run lint + types**

```bash
ruff check app tests
mypy app
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add backend/app/models.py backend/tests/unit/test_models.py
git commit -m "Add Pydantic models for accounts, categories, and auth"
```

---

## Task 5 — API test infrastructure

**Files:**
- Create: `backend/tests/api/conftest.py`

This task sets up a reusable Postgres + test-client fixture so every API test runs against a real schema. No production code change.

- [ ] **Step 1: Create `backend/tests/api/conftest.py`**

```python
"""API-test fixtures: a clean Postgres schema per test plus an httpx AsyncClient.

We use a single test database (DATABASE_URL env). Between tests, we TRUNCATE
all user-data tables (cascade). Schema bootstrap runs once on the first fixture use.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import asyncpg
import pytest
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
    """Create the test database if missing (CREATE DATABASE can't run inside a transaction)."""
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
            "TRUNCATE accounts, categories, sessions, magic_links, users RESTART IDENTITY CASCADE"
        )
    yield


@pytest_asyncio.fixture
async def client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture
async def authed_user() -> AsyncIterator[dict[str, str]]:
    """Create a user + session directly in the DB and return {user_id, email, token}."""
    pool = db.pool()
    async with pool.acquire() as conn:
        user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "test@example.com"
        )
        session_id = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", user_id
        )
    yield {"user_id": str(user_id), "email": "test@example.com", "token": str(session_id)}


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
```

- [ ] **Step 2: Verify nothing breaks**

```bash
pytest tests/ -v
```

Expected: only the 7 unit tests run and pass; no new API tests yet.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/api/conftest.py
git commit -m "Add API test infrastructure (test DB, clean fixture, authed_user)"
```

---

## Task 6 — Auth: magic-link request endpoint

**Files:**
- Create: `backend/app/email.py`
- Create: `backend/app/auth_session.py`
- Modify: `backend/app/main.py` (mount auth router)
- Create: `backend/tests/api/test_auth.py`

- [ ] **Step 1: Write failing test in `backend/tests/api/test_auth.py`**

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker_test' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://localhost:8080 \
  pytest tests/api/test_auth.py -v
```

Expected: FAIL — `/auth/request-link` doesn't exist yet (404).

- [ ] **Step 3: Implement `backend/app/email.py`**

```python
"""Resend wrapper. When MAGIC_LINK_DEV_PRINT=1 is set, log to stdout instead of sending."""

from __future__ import annotations

import logging
import os

import httpx

log = logging.getLogger("net_tracker.email")


def _dev_print_only() -> bool:
    return os.environ.get("MAGIC_LINK_DEV_PRINT") == "1"


async def send_magic_link(*, to: str, link: str) -> None:
    if _dev_print_only():
        print(f"[DEV magic link] to={to} link={link}", flush=True)
        return

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is required when MAGIC_LINK_DEV_PRINT is not set")

    from_addr = os.environ.get("RESEND_FROM", "onboarding@resend.dev")
    body = {
        "from": from_addr,
        "to": [to],
        "subject": "Your net-tracker sign-in link",
        "html": (
            "<p>Click to sign in to net-tracker. This link expires in 15 minutes.</p>"
            f'<p><a href="{link}">Sign in</a></p>'
            f'<p style="color:#888">Or paste this URL: {link}</p>'
        ),
    }
    async with httpx.AsyncClient(timeout=10.0) as http:
        r = await http.post(
            "https://api.resend.com/emails",
            json=body,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if r.status_code >= 400:
            log.error("resend_failed status=%s body=%s", r.status_code, r.text)
            r.raise_for_status()
```

- [ ] **Step 4: Implement `backend/app/auth_session.py`**

```python
"""Magic-link auth + bearer-token sessions.

Magic links: SHA-256-hashed tokens with 15-min TTL, one-use, rate-limited.
Sessions: opaque UUIDs in `sessions.id`, 90-day sliding TTL, 1-h debounce on last_seen_at.
"""

from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status

from app import db, email
from app.models import MagicLinkRequest, MagicLinkVerify, SessionOut, UserOut

router = APIRouter(prefix="/auth")

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
    return (request.headers.get("x-forwarded-for") or request.client.host if request.client else "unknown").split(",")[0].strip()


@router.post("/request-link", status_code=204)
async def request_link(payload: MagicLinkRequest, request: Request) -> Response:
    ip = _client_ip(request)
    pool = db.pool()
    async with pool.acquire() as conn:
        now = datetime.now(timezone.utc)
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
    now = datetime.now(timezone.utc)
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
    now = datetime.now(timezone.utc)
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
```

- [ ] **Step 5: Mount the router in `backend/app/main.py`**

Replace the contents:

```python
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import auth_session
from app.db import close_pool, init_pool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="net-tracker", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_session.router)


@app.get("/")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker_test' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://localhost:8080 \
  pytest tests/api/test_auth.py -v
```

Expected: all 4 tests PASS.

- [ ] **Step 7: Run lint + types**

```bash
ruff check app tests
mypy app
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add backend/app/email.py backend/app/auth_session.py backend/app/main.py backend/tests/api/test_auth.py
git commit -m "Add magic-link request endpoint with rate limits and dev-print fallback"
```

---

## Task 7 — Auth: verify, me, logout (full flow)

**Files:**
- Modify: `backend/tests/api/test_auth.py` (add tests)

The endpoint implementations from Task 6 already cover `/auth/verify`, `/auth/me`, `/auth/logout`. This task adds the test coverage that proves they work end-to-end.

- [ ] **Step 1: Append failing tests to `backend/tests/api/test_auth.py`**

```python
async def test_verify_creates_session_and_user(client: AsyncClient) -> None:
    r = await client.post("/auth/request-link", json={"email": "verify@example.com"})
    assert r.status_code == 204

    pool = db.pool()
    # We don't expose the raw token via the API; the test reaches into the DB
    # to fetch the latest hash + replays the dev-print path. For tests, we
    # bypass send by reading what was inserted and reversing the hash isn't
    # possible — instead, intercept by inserting our own row.
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM magic_links")
    import secrets, hashlib
    from datetime import datetime, timedelta, timezone

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, created_ip) "
            "VALUES ($1, $2, $3, $4)",
            token_hash,
            "verify@example.com",
            datetime.now(timezone.utc) + timedelta(minutes=15),
            "127.0.0.1",
        )

    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "verify@example.com"
    assert "user_id" in body and "token" in body


async def test_verify_rejects_used_token(client: AsyncClient) -> None:
    import hashlib, secrets
    from datetime import datetime, timedelta, timezone

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, used_at, created_ip) "
            "VALUES ($1, $2, $3, $4, $5)",
            token_hash,
            "used@example.com",
            datetime.now(timezone.utc) + timedelta(minutes=15),
            datetime.now(timezone.utc),
            "127.0.0.1",
        )
    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json()["detail"] == "token_used"


async def test_verify_rejects_expired_token(client: AsyncClient) -> None:
    import hashlib, secrets
    from datetime import datetime, timedelta, timezone

    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    pool = db.pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO magic_links (token_hash, email, expires_at, created_ip) "
            "VALUES ($1, $2, $3, $4)",
            token_hash,
            "exp@example.com",
            datetime.now(timezone.utc) - timedelta(minutes=1),
            "127.0.0.1",
        )
    r = await client.post("/auth/verify", json={"token": token})
    assert r.status_code == 400
    assert r.json()["detail"] == "token_expired"


async def test_me_requires_bearer(client: AsyncClient) -> None:
    r = await client.get("/auth/me")
    assert r.status_code == 401


async def test_me_returns_user(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/auth/me", headers={"Authorization": f"Bearer {authed_user['token']}"})
    assert r.status_code == 200
    assert r.json()["email"] == authed_user["email"]


async def test_logout_deletes_session(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = {"Authorization": f"Bearer {authed_user['token']}"}
    r = await client.post("/auth/logout", headers=headers)
    assert r.status_code == 204

    r = await client.get("/auth/me", headers=headers)
    assert r.status_code == 401
```

- [ ] **Step 2: Run all auth tests to verify they pass**

```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker_test' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://localhost:8080 \
  pytest tests/api/test_auth.py -v
```

Expected: all 10 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/tests/api/test_auth.py
git commit -m "Test verify, me, logout end-to-end"
```

---

## Task 8 — Categories CRUD

**Files:**
- Create: `backend/app/categories.py`
- Modify: `backend/app/main.py` (mount router)
- Create: `backend/tests/api/test_categories.py`

- [ ] **Step 1: Write failing tests in `backend/tests/api/test_categories.py`**

```python
from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_categories_list_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/categories", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/categories",
        json={"name": "Groceries", "color": "#6ba47a"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Groceries"
    assert body["color"] == "#6ba47a"
    assert body["exclude_from_spend"] is False


async def test_create_category_strips_name(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/categories",
        json={"name": "  Coffee  "},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["name"] == "Coffee"


async def test_create_category_unique_per_user(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    r1 = await client.post("/categories", json={"name": "Rent"}, headers=headers)
    assert r1.status_code == 201
    r2 = await client.post("/categories", json={"name": "Rent"}, headers=headers)
    assert r2.status_code == 409


async def test_patch_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post("/categories", json={"name": "Old"}, headers=headers)
    cat_id = create.json()["id"]
    r = await client.patch(
        f"/categories/{cat_id}",
        json={"name": "New", "exclude_from_spend": True},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["name"] == "New"
    assert r.json()["exclude_from_spend"] is True


async def test_delete_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post("/categories", json={"name": "Bye"}, headers=headers)
    cat_id = create.json()["id"]
    r = await client.delete(f"/categories/{cat_id}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/categories", headers=headers)
    assert listing.json() == []


async def test_other_user_cannot_see_my_categories(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    from app import db

    headers = _h(authed_user["token"])
    await client.post("/categories", json={"name": "Mine"}, headers=headers)

    pool = db.pool()
    async with pool.acquire() as conn:
        other_uid = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@example.com"
        )
        other_sid = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_uid
        )

    r = await client.get("/categories", headers=_h(str(other_sid)))
    assert r.status_code == 200
    assert r.json() == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/api/test_categories.py -v
```

Expected: FAIL — `/categories` endpoint doesn't exist.

- [ ] **Step 3: Implement `backend/app/categories.py`**

```python
"""Per-user category CRUD."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status

from app import db
from app.auth_session import require_session
from app.models import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/categories", tags=["categories"])


@router.get("", response_model=list[CategoryOut])
async def list_categories(session: dict[str, UUID] = Depends(require_session)) -> list[CategoryOut]:
    pool = db.pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, color, exclude_from_spend, sort_order, created_at "
            "FROM categories WHERE user_id = $1 "
            "ORDER BY sort_order ASC, name ASC",
            session["user_id"],
        )
    return [CategoryOut(**dict(r)) for r in rows]


@router.post("", response_model=CategoryOut, status_code=201)
async def create_category(
    payload: CategoryCreate,
    session: dict[str, UUID] = Depends(require_session),
) -> CategoryOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "INSERT INTO categories (user_id, name, color, exclude_from_spend, sort_order) "
                "VALUES ($1, $2, $3, $4, $5) "
                "RETURNING id, name, color, exclude_from_spend, sort_order, created_at",
                session["user_id"],
                payload.name,
                payload.color,
                payload.exclude_from_spend,
                payload.sort_order,
            )
        except Exception as e:
            if "categories_user_id_name_key" in str(e):
                raise HTTPException(status_code=409, detail="category_name_taken") from e
            raise
    return CategoryOut(**dict(row))


@router.patch("/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: UUID,
    payload: CategoryUpdate,
    session: dict[str, UUID] = Depends(require_session),
) -> CategoryOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, color, exclude_from_spend, sort_order, created_at "
            "FROM categories WHERE id = $1 AND user_id = $2",
            category_id,
            session["user_id"],
        )
        if row is None:
            raise HTTPException(status_code=404, detail="not_found")

        new_name = payload.name if payload.name is not None else row["name"]
        new_color = payload.color if payload.color is not None else row["color"]
        new_excl = (
            payload.exclude_from_spend
            if payload.exclude_from_spend is not None
            else row["exclude_from_spend"]
        )
        new_sort = payload.sort_order if payload.sort_order is not None else row["sort_order"]

        try:
            updated = await conn.fetchrow(
                "UPDATE categories SET name=$1, color=$2, exclude_from_spend=$3, sort_order=$4 "
                "WHERE id = $5 AND user_id = $6 "
                "RETURNING id, name, color, exclude_from_spend, sort_order, created_at",
                new_name,
                new_color,
                new_excl,
                new_sort,
                category_id,
                session["user_id"],
            )
        except Exception as e:
            if "categories_user_id_name_key" in str(e):
                raise HTTPException(status_code=409, detail="category_name_taken") from e
            raise
    return CategoryOut(**dict(updated))


@router.delete("/{category_id}", status_code=204)
async def delete_category(
    category_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> None:
    pool = db.pool()
    async with pool.acquire() as conn:
        deleted = await conn.execute(
            "DELETE FROM categories WHERE id = $1 AND user_id = $2",
            category_id,
            session["user_id"],
        )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
```

- [ ] **Step 4: Mount the router in `backend/app/main.py`**

Add to the imports near the top:

```python
from app import auth_session, categories
```

And add this line after `app.include_router(auth_session.router)`:

```python
app.include_router(categories.router)
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pytest tests/api/test_categories.py -v
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Run lint + types**

```bash
ruff check app tests
mypy app
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/categories.py backend/app/main.py backend/tests/api/test_categories.py
git commit -m "Add categories CRUD"
```

---

## Task 9 — Accounts CRUD

**Files:**
- Create: `backend/app/accounts.py`
- Modify: `backend/app/main.py` (mount router)
- Create: `backend/tests/api/test_accounts.py`

- [ ] **Step 1: Write failing tests in `backend/tests/api/test_accounts.py`**

```python
from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_accounts_list_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/accounts", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_spending_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Danske Salary", "kind": "spending", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Danske Salary"
    assert body["kind"] == "spending"
    assert body["asset_class"] == "Savings"


async def test_create_sinking_fund_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Sinking", "kind": "sinking_fund", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["kind"] == "sinking_fund"


async def test_create_savings_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Nordnet", "kind": "savings", "asset_class": "Stocks"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["asset_class"] == "Stocks"


async def test_create_account_rejects_bad_kind(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "bogus", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_account_rejects_bad_asset_class(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "savings", "asset_class": "Bonds"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_accounts_unique_per_user(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    payload = {"name": "Same", "kind": "savings", "asset_class": "Savings"}
    r1 = await client.post("/accounts", json=payload, headers=headers)
    assert r1.status_code == 201
    r2 = await client.post("/accounts", json=payload, headers=headers)
    assert r2.status_code == 409


async def test_patch_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Old", "kind": "savings", "asset_class": "Savings"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.patch(
        f"/accounts/{aid}",
        json={"name": "Renamed", "asset_class": "Crypto"},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"
    assert r.json()["asset_class"] == "Crypto"


async def test_patch_account_cannot_change_kind(client: AsyncClient, authed_user: dict[str, str]) -> None:
    # AccountUpdate doesn't include `kind`, so sending it is just ignored — Pydantic v2 strict mode rejects extras.
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "X", "kind": "savings", "asset_class": "Savings"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.patch(f"/accounts/{aid}", json={"kind": "spending"}, headers=headers)
    # Either 200 with kind unchanged, or 422 if Pydantic rejects the extra field. Both are correct.
    assert r.status_code in (200, 422)
    if r.status_code == 200:
        assert r.json()["kind"] == "savings"


async def test_delete_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Bye", "kind": "savings", "asset_class": "Savings"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.delete(f"/accounts/{aid}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/accounts", headers=headers)
    assert listing.json() == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pytest tests/api/test_accounts.py -v
```

Expected: FAIL — `/accounts` doesn't exist.

- [ ] **Step 3: Implement `backend/app/accounts.py`**

```python
"""Per-user account CRUD. Accounts have a `kind` that drives downstream behavior."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app import db
from app.auth_session import require_session
from app.models import AccountCreate, AccountOut, AccountUpdate

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountOut])
async def list_accounts(session: dict[str, UUID] = Depends(require_session)) -> list[AccountOut]:
    pool = db.pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, kind, asset_class, sort_order, created_at "
            "FROM accounts WHERE user_id = $1 "
            "ORDER BY sort_order ASC, name ASC",
            session["user_id"],
        )
    return [AccountOut(**dict(r)) for r in rows]


@router.post("", response_model=AccountOut, status_code=201)
async def create_account(
    payload: AccountCreate,
    session: dict[str, UUID] = Depends(require_session),
) -> AccountOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                "INSERT INTO accounts (user_id, name, kind, asset_class, sort_order) "
                "VALUES ($1, $2, $3, $4, $5) "
                "RETURNING id, name, kind, asset_class, sort_order, created_at",
                session["user_id"],
                payload.name,
                payload.kind.value,
                payload.asset_class.value,
                payload.sort_order,
            )
        except Exception as e:
            if "accounts_user_id_name_key" in str(e):
                raise HTTPException(status_code=409, detail="account_name_taken") from e
            raise
    return AccountOut(**dict(row))


@router.patch("/{account_id}", response_model=AccountOut)
async def update_account(
    account_id: UUID,
    payload: AccountUpdate,
    session: dict[str, UUID] = Depends(require_session),
) -> AccountOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, name, kind, asset_class, sort_order, created_at "
            "FROM accounts WHERE id = $1 AND user_id = $2",
            account_id,
            session["user_id"],
        )
        if row is None:
            raise HTTPException(status_code=404, detail="not_found")

        new_name = payload.name if payload.name is not None else row["name"]
        new_asset = (
            payload.asset_class.value if payload.asset_class is not None else row["asset_class"]
        )
        new_sort = payload.sort_order if payload.sort_order is not None else row["sort_order"]

        try:
            updated = await conn.fetchrow(
                "UPDATE accounts SET name=$1, asset_class=$2, sort_order=$3 "
                "WHERE id = $4 AND user_id = $5 "
                "RETURNING id, name, kind, asset_class, sort_order, created_at",
                new_name,
                new_asset,
                new_sort,
                account_id,
                session["user_id"],
            )
        except Exception as e:
            if "accounts_user_id_name_key" in str(e):
                raise HTTPException(status_code=409, detail="account_name_taken") from e
            raise
    return AccountOut(**dict(updated))


@router.delete("/{account_id}", status_code=204)
async def delete_account(
    account_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> None:
    pool = db.pool()
    async with pool.acquire() as conn:
        deleted = await conn.execute(
            "DELETE FROM accounts WHERE id = $1 AND user_id = $2",
            account_id,
            session["user_id"],
        )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
```

- [ ] **Step 4: Mount the router in `backend/app/main.py`**

Add `accounts` to the imports:

```python
from app import accounts, auth_session, categories
```

And add this line after `app.include_router(categories.router)`:

```python
app.include_router(accounts.router)
```

- [ ] **Step 5: Run all backend tests**

```bash
pytest tests/ -v
```

Expected: all tests PASS (unit + auth + categories + accounts).

- [ ] **Step 6: Run lint + types**

```bash
ruff check app tests
mypy app
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add backend/app/accounts.py backend/app/main.py backend/tests/api/test_accounts.py
git commit -m "Add accounts CRUD"
```

---

## Task 10 — CI workflow

**Files:**
- Create: `.github/workflows/tests.yml`

- [ ] **Step 1: Create `.github/workflows/tests.yml`**

```yaml
name: Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: net
          POSTGRES_PASSWORD: net
          POSTGRES_DB: nettracker_test
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready --health-interval 5s --health-timeout 5s --health-retries 10

    env:
      TEST_DATABASE_URL: postgresql://net:net@localhost:5432/nettracker_test
      MAGIC_LINK_DEV_PRINT: "1"
      MAGIC_LINK_BASE_URL: http://localhost:8080

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip
          cache-dependency-path: backend/requirements-dev.txt

      - name: Install dependencies
        working-directory: backend
        run: |
          python -m pip install --upgrade pip
          pip install -r requirements-dev.txt

      - name: Lint
        working-directory: backend
        run: ruff check app tests

      - name: Type check
        working-directory: backend
        run: mypy app

      - name: Run tests
        working-directory: backend
        run: pytest tests/ -v
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/tests.yml
git commit -m "Add CI workflow: ruff + mypy + pytest"
```

- [ ] **Step 3: Push and verify CI passes**

```bash
git push
```

Open the GitHub Actions tab and verify the run is green. If it isn't, fix issues locally and push a fixup commit (do **not** use `--amend` or skip hooks).

---

## Task 11 — Frontend project scaffold + theme tokens

**Files:**
- Create: `frontend/index.html`
- Create: `frontend/config.js`
- Create: `frontend/manifest.webmanifest`
- Create: `frontend/service-worker.js`
- Create: `frontend/styles.css`
- Create: `frontend/_headers`
- Create: `frontend/icons/icon-192.png` (binary placeholder; see notes)
- Create: `frontend/icons/icon-512.png`

- [ ] **Step 1: Create `frontend/config.js`**

```javascript
// Overwritten by Cloudflare Pages at build time. Default points at local dev backend.
window.BACKEND_URL = window.BACKEND_URL || "http://127.0.0.1:8000";
```

- [ ] **Step 2: Create `frontend/manifest.webmanifest`**

```json
{
  "name": "net-tracker",
  "short_name": "net-tracker",
  "description": "Personal finance overview",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f1419",
  "theme_color": "#0f1419",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

- [ ] **Step 3: Create `frontend/service-worker.js`**

```javascript
// Minimal SW required for iOS install. No caching.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
```

- [ ] **Step 4: Create `frontend/_headers`**

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://*.onrender.com http://127.0.0.1:8000 http://localhost:8000; frame-ancestors 'none'; object-src 'none'; base-uri 'self'

/*.html
  Cache-Control: no-cache

/icons/*
  Cache-Control: public, max-age=86400
```

- [ ] **Step 5: Create `frontend/styles.css`**

```css
/* Theme tokens. Green accent + cool-slate dark base. */
:root {
  --bg: #ffffff;
  --fg: #1a1a1a;
  --muted: #6b7280;
  --border: #e5e7eb;
  --card: #f9fafb;
  --accent: #4f7d5b;
  --accent-strong: #6ba47a;
  --accent-grad-from: #6ba47a;
  --accent-grad-to: #4f7d5b;
  --danger: #b53b3b;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  --radius: 10px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}

[data-theme="dark"] {
  --bg: #0f1419;
  --fg: #e6edf3;
  --muted: #9aa4b2;
  --border: #1f2933;
  --card: #161c24;
  --accent: #6ba47a;
  --accent-strong: #8ac99a;
  --accent-grad-from: #8ac99a;
  --accent-grad-to: #4f7d5b;
  --danger: #e76e6e;
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}

* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--fg);
  -webkit-text-size-adjust: 100%;
}

.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  position: sticky; top: 0; z-index: 10;
}
.topbar .menu-btn {
  background: transparent; border: 0; cursor: pointer;
  font-size: 20px; color: var(--fg); padding: 4px 8px;
}
.topbar .brand { font-weight: 600; }

.drawer {
  position: fixed; top: 0; left: 0; bottom: 0;
  width: 260px; background: var(--card); border-right: 1px solid var(--border);
  transform: translateX(-100%); transition: transform 0.18s ease-out;
  z-index: 20; padding: 16px;
}
.drawer.open { transform: translateX(0); }
.drawer-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  opacity: 0; pointer-events: none; transition: opacity 0.18s; z-index: 15;
}
.drawer-backdrop.open { opacity: 1; pointer-events: auto; }
.drawer nav { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.drawer nav button {
  text-align: left; padding: 10px 12px; border-radius: var(--radius);
  background: transparent; border: 0; color: var(--fg); cursor: pointer;
  font-size: 15px;
}
.drawer nav button.active { background: rgba(107, 164, 122, 0.12); color: var(--accent-strong); font-weight: 600; }

.view { padding: 16px; max-width: 720px; margin: 0 auto; width: 100%; }
.view h1 { font-size: 22px; margin: 0 0 16px; }
.view h2 { font-size: 16px; margin: 24px 0 8px; color: var(--muted); }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px 14px; margin-bottom: 12px;
  box-shadow: var(--shadow);
}

.site-btn, .site-btn-primary, .danger-btn {
  font: inherit; cursor: pointer; padding: 8px 14px;
  border-radius: 8px; border: 1px solid var(--border);
  background: var(--card); color: var(--fg);
}
.site-btn-primary {
  background: linear-gradient(180deg, var(--accent-grad-from), var(--accent-grad-to));
  color: #fff; border-color: transparent; font-weight: 600;
}
.danger-btn { color: var(--danger); border-color: var(--danger); background: transparent; }

input[type=text], input[type=email], input[type=number], select {
  font: inherit; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  width: 100%;
}

label { display: block; font-size: 13px; color: var(--muted); margin-bottom: 4px; }

.row { display: flex; gap: 8px; align-items: center; }
.spread { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.muted { color: var(--muted); font-size: 13px; }

dialog {
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--card); color: var(--fg);
  max-width: 420px; width: 92%; padding: 20px;
}
dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
dialog menu { display: flex; gap: 8px; justify-content: flex-end; padding: 0; margin: 16px 0 0; }
dialog menu button { font: inherit; }
dialog menu button[value="save"] {
  background: linear-gradient(180deg, var(--accent-grad-from), var(--accent-grad-to));
  color: #fff; border-color: transparent; padding: 8px 14px; border-radius: 8px; font-weight: 600;
}

.toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  background: var(--fg); color: var(--bg);
  padding: 10px 16px; border-radius: 8px; font-size: 14px;
  opacity: 0; pointer-events: none; transition: opacity 0.18s;
}
.toast.show { opacity: 0.95; }

@media (min-width: 720px) {
  .drawer { position: sticky; transform: translateX(0); height: 100vh; flex-shrink: 0; }
  .drawer-backdrop { display: none; }
  .app-shell { display: grid; grid-template-columns: 260px 1fr; }
  .topbar .menu-btn { display: none; }
  .topbar { grid-column: 2; }
  .view { grid-column: 2; }
  .drawer { grid-row: 1 / span 2; }
}
```

- [ ] **Step 6: Create `frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0f1419" />
  <title>net-tracker</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  <link rel="stylesheet" href="/styles.css" />
  <script src="/config.js"></script>
</head>
<body data-theme="dark">
  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <div class="app-shell">
    <aside class="drawer" id="drawer">
      <div class="spread">
        <strong>net-tracker</strong>
        <button class="site-btn" id="drawer-close">×</button>
      </div>
      <nav id="nav">
        <button data-view="home">Home</button>
        <button data-view="budget">Budget</button>
        <button data-view="spending">Spending</button>
        <button data-view="networth">Net Worth</button>
        <button data-view="settings" class="active">Settings</button>
      </nav>
    </aside>

    <header class="topbar">
      <button class="menu-btn" id="menu-open">☰</button>
      <div class="brand">net-tracker</div>
    </header>

    <main>
      <section class="view" id="view-home" hidden>
        <h1>Home</h1>
        <p class="muted">Coming in a later plan.</p>
      </section>
      <section class="view" id="view-budget" hidden>
        <h1>Budget</h1>
        <p class="muted">Coming in a later plan.</p>
      </section>
      <section class="view" id="view-spending" hidden>
        <h1>Spending</h1>
        <p class="muted">Coming in a later plan.</p>
      </section>
      <section class="view" id="view-networth" hidden>
        <h1>Net Worth</h1>
        <p class="muted">Coming in a later plan.</p>
      </section>
      <section class="view" id="view-settings">
        <h1>Settings</h1>
        <div id="settings-root"></div>
      </section>
    </main>
  </div>

  <dialog id="login-dialog">
    <h2 style="margin-top:0">Sign in</h2>
    <p class="muted" style="margin-top:0">We'll email a link. Click it to sign in.</p>
    <label for="login-email">Email</label>
    <input id="login-email" type="email" autocomplete="email" />
    <menu>
      <button id="login-cancel" value="cancel">Close</button>
      <button id="login-send" value="save">Send link</button>
    </menu>
  </dialog>

  <div class="toast" id="toast"></div>

  <script type="module" src="/app.js?v=1"></script>
  <script>
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch(() => {});
    }
  </script>
</body>
</html>
```

- [ ] **Step 7: Create placeholder icon files**

The icons can be any 192×192 and 512×512 PNGs for now. From the bash shell, create solid green placeholders using ImageMagick if available, or download placeholders from a public source the user owns. For the plan, do this manually:

```bash
mkdir -p frontend/icons
# Provide a single-color PNG via Python (no extra deps):
python -c "
from struct import pack
import zlib
def make_png(path, size, rgb):
    sig = b'\\x89PNG\\r\\n\\x1a\\n'
    def chunk(t, d):
        return pack('>I', len(d)) + t + d + pack('>I', zlib.crc32(t + d) & 0xffffffff)
    ihdr = pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)
    raw = b''.join(b'\\x00' + bytes(rgb) * size for _ in range(size))
    idat = zlib.compress(raw, 9)
    with open(path, 'wb') as f:
        f.write(sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', idat) + chunk(b'IEND', b''))
make_png('frontend/icons/icon-192.png', 192, (0x6b, 0xa4, 0x7a))
make_png('frontend/icons/icon-512.png', 512, (0x6b, 0xa4, 0x7a))
"
ls -la frontend/icons/
```

Expected: two PNG files exist.

- [ ] **Step 8: Commit**

```bash
git add frontend/
git commit -m "Scaffold PWA shell: index.html, theme, manifest, service worker, placeholder icons"
```

---

## Task 12 — Frontend shared modules: api, auth, ui, fmt

**Files:**
- Create: `frontend/shared/api.js`
- Create: `frontend/shared/auth.js`
- Create: `frontend/shared/ui.js`
- Create: `frontend/shared/fmt.js`

- [ ] **Step 1: Create `frontend/shared/fmt.js`**

```javascript
// DKK display: dot thousands, comma decimal.
// Numbers like 12345.67 render as "12.345,67 kr"
const dkkFormatter = new Intl.NumberFormat("da-DK", {
  style: "currency",
  currency: "DKK",
  minimumFractionDigits: 2,
});

export function fmtDKK(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return dkkFormatter.format(n);
}

// Display dates as DD-MM-YYYY (no locale drift)
export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

export function fmtPct(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${n.toFixed(digits)}%`;
}
```

- [ ] **Step 2: Create `frontend/shared/ui.js`**

```javascript
const TOAST_TIMEOUT_MS = 3000;
let toastTimer = null;

export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), TOAST_TIMEOUT_MS);
}

export function openDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) return null;
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg && dlg.open) dlg.close();
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function confirmPrompt(message) {
  // Replace with a custom dialog later if we need it; native confirm is fine for MVP.
  return Promise.resolve(window.confirm(message));
}
```

- [ ] **Step 3: Create `frontend/shared/auth.js`**

```javascript
const STORAGE_KEY = "net-tracker.session-token";

export function getToken() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isSignedIn() {
  return !!getToken();
}

export function readTokenFromHash() {
  const m = window.location.hash.match(/auth=([^&]+)/);
  if (!m) return null;
  // Strip the token from the URL so reloads don't replay it.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(m[1]);
}
```

- [ ] **Step 4: Create `frontend/shared/api.js`**

```javascript
import { clearToken, getToken } from "./auth.js";
import { toast } from "./ui.js";

function url(path) {
  const base = window.BACKEND_URL || "";
  return base + path;
}

async function request(method, path, body) {
  const headers = { "Accept": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let bodyBlob = undefined;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    bodyBlob = JSON.stringify(body);
  } else if (body instanceof FormData) {
    bodyBlob = body;
  }

  let res;
  try {
    res = await fetch(url(path), { method, headers, body: bodyBlob });
  } catch (e) {
    toast("Network error — is the backend running?", "error");
    throw e;
  }

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("auth:signed-out"));
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;

  let payload = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const detail = payload && payload.detail ? payload.detail : `${method} ${path} failed (${res.status})`;
    const err = new Error(detail);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  patch: (path, body) => request("PATCH", path, body),
  put: (path, body) => request("PUT", path, body),
  delete: (path) => request("DELETE", path),
};
```

- [ ] **Step 5: Commit**

```bash
git add frontend/shared/
git commit -m "Add frontend shared modules: api, auth, ui, fmt"
```

---

## Task 13 — Frontend app shell + auth wiring

**Files:**
- Create: `frontend/app.js`

- [ ] **Step 1: Create `frontend/app.js`**

```javascript
import { api } from "./shared/api.js";
import {
  clearToken,
  getToken,
  isSignedIn,
  readTokenFromHash,
  setToken,
} from "./shared/auth.js";
import { closeDialog, openDialog, toast } from "./shared/ui.js";
import { renderSettings } from "./settings.js";

const VIEWS = ["home", "budget", "spending", "networth", "settings"];

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (!el) continue;
    el.hidden = v !== name;
  }
  document.querySelectorAll("#nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  if (name === "settings") renderSettings();
}

function bindDrawer() {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const open = () => {
    drawer.classList.add("open");
    backdrop.classList.add("open");
  };
  const close = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
  };
  document.getElementById("menu-open").addEventListener("click", open);
  document.getElementById("drawer-close").addEventListener("click", close);
  backdrop.addEventListener("click", close);

  document.querySelectorAll("#nav button").forEach((b) => {
    b.addEventListener("click", () => {
      showView(b.dataset.view);
      close();
    });
  });
}

function bindLogin() {
  const dlg = document.getElementById("login-dialog");
  document.getElementById("login-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    closeDialog("login-dialog");
  });
  document.getElementById("login-send").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    if (!email) {
      toast("Email required", "error");
      return;
    }
    try {
      await api.post("/auth/request-link", { email });
      toast("Check your inbox for the sign-in link", "info");
      closeDialog("login-dialog");
    } catch (err) {
      toast(`Could not send link: ${err.message}`, "error");
    }
  });
}

async function tryVerify() {
  const token = readTokenFromHash();
  if (!token) return false;
  try {
    const res = await api.post("/auth/verify", { token });
    setToken(res.token);
    toast(`Signed in as ${res.email}`, "info");
    return true;
  } catch (err) {
    toast(`Sign-in failed: ${err.message}`, "error");
    return false;
  }
}

async function refreshSignedInState() {
  if (!isSignedIn()) {
    openDialog("login-dialog");
    return null;
  }
  try {
    const me = await api.get("/auth/me");
    return me;
  } catch {
    clearToken();
    openDialog("login-dialog");
    return null;
  }
}

window.addEventListener("auth:signed-out", () => {
  openDialog("login-dialog");
});

async function main() {
  bindDrawer();
  bindLogin();
  await tryVerify();
  await refreshSignedInState();
  showView("settings");
}

main();
```

- [ ] **Step 2: Smoke-test the frontend locally**

In one shell:
```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://127.0.0.1:5500 \
  uvicorn app.main:app --port 8000 --app-dir backend --reload
```

In a second shell:
```bash
cd frontend
python -m http.server 5500
```

Open `http://127.0.0.1:5500/` in a browser. Expected:
- Page loads with dark theme.
- "Sign in" dialog opens automatically.
- Enter an email + click "Send link" → toast says "Check your inbox..."
- The backend terminal prints: `[DEV magic link] to=... link=http://127.0.0.1:5500/#auth=...`
- Click that link in your browser. The page loads, the toast says "Signed in as ...", and the dialog closes.

- [ ] **Step 3: Commit**

```bash
git add frontend/app.js
git commit -m "Add frontend app shell with drawer routing and magic-link sign-in"
```

---

## Task 14 — Settings view: theme + sign out + categories + accounts

**Files:**
- Create: `frontend/settings.js`

- [ ] **Step 1: Create `frontend/settings.js`**

```javascript
import { api } from "./shared/api.js";
import { clearToken } from "./shared/auth.js";
import { escapeHtml, toast } from "./shared/ui.js";

const ASSET_CLASSES = ["Savings", "Stocks", "Crypto", "Gold", "Pension", "Other"];
const ACCOUNT_KINDS = [
  { value: "spending", label: "Spending (CSV-imported)" },
  { value: "savings", label: "Savings (manual net worth only)" },
  { value: "sinking_fund", label: "Sinking fund (CSV + envelopes)" },
];

let state = {
  email: null,
  categories: [],
  accounts: [],
};

function setTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem("net-tracker.theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem("net-tracker.theme");
  if (saved === "light" || saved === "dark") setTheme(saved);
  else setTheme("dark");
}

export async function renderSettings() {
  initTheme();
  const root = document.getElementById("settings-root");
  if (!root) return;
  try {
    const [me, cats, accts] = await Promise.all([
      api.get("/auth/me"),
      api.get("/categories"),
      api.get("/accounts"),
    ]);
    state.email = me.email;
    state.categories = cats;
    state.accounts = accts;
  } catch {
    return;
  }
  root.innerHTML = renderHtml();
  bindHandlers();
}

function renderHtml() {
  return `
    <h2>Account</h2>
    <div class="card spread">
      <div>Signed in as <strong>${escapeHtml(state.email)}</strong></div>
      <button class="danger-btn" id="signout-btn">Sign out</button>
    </div>

    <h2>Theme</h2>
    <div class="card row" style="gap: 12px">
      <button class="site-btn" data-theme="light">Light</button>
      <button class="site-btn" data-theme="dark">Dark</button>
    </div>

    <h2>Categories</h2>
    <div class="card">
      <div class="row" style="margin-bottom: 10px">
        <input id="cat-name" type="text" placeholder="New category name" />
        <button class="site-btn-primary" id="cat-add">Add</button>
      </div>
      <ul style="list-style: none; padding: 0; margin: 0">
        ${
          state.categories.length === 0
            ? '<li class="muted">No categories yet.</li>'
            : state.categories
                .map(
                  (c) => `
            <li class="spread" style="padding: 8px 0; border-top: 1px solid var(--border)">
              <span>${escapeHtml(c.name)}${
                c.exclude_from_spend ? ' <span class="muted">(excluded)</span>' : ""
              }</span>
              <button class="danger-btn" data-delete-category="${c.id}">Delete</button>
            </li>`
                )
                .join("")
        }
      </ul>
    </div>

    <h2>Accounts</h2>
    <div class="card">
      <div class="row" style="margin-bottom: 10px; flex-wrap: wrap; gap: 8px">
        <input id="acct-name" type="text" placeholder="Account name" style="flex: 1 1 180px" />
        <select id="acct-kind">${ACCOUNT_KINDS.map(
          (k) => `<option value="${k.value}">${k.label}</option>`
        ).join("")}</select>
        <select id="acct-asset">${ASSET_CLASSES.map(
          (a) => `<option value="${a}">${a}</option>`
        ).join("")}</select>
        <button class="site-btn-primary" id="acct-add">Add</button>
      </div>
      <ul style="list-style: none; padding: 0; margin: 0">
        ${
          state.accounts.length === 0
            ? '<li class="muted">No accounts yet.</li>'
            : state.accounts
                .map(
                  (a) => `
            <li class="spread" style="padding: 8px 0; border-top: 1px solid var(--border)">
              <span>${escapeHtml(a.name)} <span class="muted">— ${escapeHtml(
                    a.kind
                  )} · ${escapeHtml(a.asset_class)}</span></span>
              <button class="danger-btn" data-delete-account="${a.id}">Delete</button>
            </li>`
                )
                .join("")
        }
      </ul>
    </div>
  `;
}

function bindHandlers() {
  document.getElementById("signout-btn").addEventListener("click", async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    clearToken();
    location.reload();
  });

  document.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.theme));
  });

  document.getElementById("cat-add").addEventListener("click", async () => {
    const name = document.getElementById("cat-name").value.trim();
    if (!name) return;
    try {
      await api.post("/categories", { name });
      await renderSettings();
    } catch (e) {
      toast(`Could not add category: ${e.message}`, "error");
    }
  });

  document.querySelectorAll("[data-delete-category]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteCategory;
      if (!confirm("Delete this category?")) return;
      try {
        await api.delete(`/categories/${id}`);
        await renderSettings();
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });

  document.getElementById("acct-add").addEventListener("click", async () => {
    const name = document.getElementById("acct-name").value.trim();
    const kind = document.getElementById("acct-kind").value;
    const asset = document.getElementById("acct-asset").value;
    if (!name) return;
    try {
      await api.post("/accounts", { name, kind, asset_class: asset });
      await renderSettings();
    } catch (e) {
      toast(`Could not add account: ${e.message}`, "error");
    }
  });

  document.querySelectorAll("[data-delete-account]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteAccount;
      if (!confirm("Delete this account? All linked data is removed.")) return;
      try {
        await api.delete(`/accounts/${id}`);
        await renderSettings();
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });
}
```

- [ ] **Step 2: Manual smoke test**

With backend and frontend servers still running (from Task 13), reload the browser tab.

Expected flow:
1. Page loads, you're signed in (from the magic link).
2. Settings view renders. You see "Signed in as ...".
3. Click "Light" — page goes light. Reload — still light. Click "Dark" — back to dark.
4. Add a category "Groceries" → it appears in the list.
5. Add an account "Salary", kind = spending, asset = Savings → it appears.
6. Add a duplicate category "Groceries" → toast shows the 409 error.
7. Delete the category → it disappears.
8. Click "Sign out" → page reloads, sign-in dialog reappears.

- [ ] **Step 3: Commit**

```bash
git add frontend/settings.js
git commit -m "Add Settings view: theme toggle, sign out, categories CRUD, accounts CRUD"
```

---

## Task 15 — README and finalize

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md` at repo root**

```markdown
# net-tracker

Personal-finance PWA for managing a monthly budget, analyzing bank-export spending, and tracking net worth over time. Single-user, magic-link auth.

See [CLAUDE.md](./CLAUDE.md) for the project overview and [docs/superpowers/specs/](./docs/superpowers/specs/) for the design spec.

## Local dev

### Backend

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate    # Windows bash; Linux/Mac: .venv/bin/activate
pip install -r requirements-dev.txt

# Start Postgres (separate shell or already running)
docker compose up -d

DATABASE_URL='postgresql://net:net@localhost:5434/nettracker' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://127.0.0.1:5500 \
  uvicorn app.main:app --port 8000 --reload
```

`MAGIC_LINK_DEV_PRINT=1` makes the magic-link email log to stdout instead of sending via Resend.

### Frontend

```bash
cd frontend
python -m http.server 5500
```

Open `http://127.0.0.1:5500/`. Enter your email; the magic link appears in the backend terminal.

### Tests

```bash
cd backend
ruff check app tests
mypy app
pytest tests/ -v
```

## Production deploy

Backend on Render (free tier), frontend on Cloudflare Pages, Postgres on Neon. Magic-link emails via Resend. Specific YAML/config files will be added in a later plan.
```

- [ ] **Step 2: Final verification**

```bash
cd backend
ruff check app tests
mypy app
pytest tests/ -v
```

Expected: all checks pass.

- [ ] **Step 3: Commit and push**

```bash
git add README.md
git commit -m "Add README with local-dev quickstart"
git push
```

Verify the GitHub Actions run is green.

---

## Done criteria

- [ ] `pytest tests/ -v` passes locally
- [ ] CI is green on the latest pushed commit
- [ ] Browser flow: sign in via magic link, add categories, add the three accounts (Danske Salary as `spending` / Savings, Danske Savings as `savings` / Savings, Sinking Fund as `sinking_fund` / Savings), delete one of each, sign out, sign back in.
- [ ] Light theme + dark theme both render correctly.

Next: **Plan 2 — Net Worth** (balance entries, net-worth chart, composition donut, per-account history).
