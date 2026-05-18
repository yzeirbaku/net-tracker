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
    kind TEXT NOT NULL,
    asset_class TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

-- 2026-05-18 migration: rename kind values + retag asset class.
--
-- ORDER MATTERS. On databases created under the OLD schema (with inline
-- CHECK constraints kind IN ('spending','savings','sinking_fund') and
-- asset_class IN ('Savings','Stocks',...) and NOT NULL on asset_class),
-- those constraints are still in force until we explicitly drop them. So
-- we must:
--   1. Drop the legacy / current CHECK constraints AND the NOT NULL.
--   2. THEN run the UPDATE statements (which would otherwise violate the
--      old constraints by setting kind='wealth' or asset_class='Cash').
--   3. THEN re-apply the new constraints.
-- DROP IF EXISTS handles fresh databases too — there's nothing to drop and
-- it's a cheap no-op.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_asset_class_check;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_asset_class_when_wealth;
ALTER TABLE accounts ALTER COLUMN asset_class DROP NOT NULL;

UPDATE accounts SET kind = 'wealth'    WHERE kind = 'savings';
UPDATE accounts SET kind = 'put_aside' WHERE kind = 'sinking_fund';
UPDATE accounts SET asset_class = 'Cash' WHERE asset_class = 'Savings';
-- Non-wealth accounts have no asset class — null out any leftover values from before.
UPDATE accounts SET asset_class = NULL WHERE kind <> 'wealth';

ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check
    CHECK (kind IN ('spending', 'put_aside', 'wealth'));

ALTER TABLE accounts ADD CONSTRAINT accounts_asset_class_check CHECK (
    asset_class IS NULL OR asset_class IN ('Cash', 'Stocks', 'Crypto', 'Gold', 'Pension', 'Other')
);

-- Wealth accounts must have an asset_class; non-wealth must not.
ALTER TABLE accounts ADD CONSTRAINT accounts_asset_class_when_wealth CHECK (
    (kind = 'wealth' AND asset_class IS NOT NULL)
    OR (kind <> 'wealth' AND asset_class IS NULL)
);
"""


async def init_pool() -> None:
    global _pool  # noqa: PLW0603 — module-level singleton, intentional
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL is required")
    _pool = await asyncpg.create_pool(dsn, min_size=1, max_size=10)
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA_SQL)


async def close_pool() -> None:
    global _pool  # noqa: PLW0603 — module-level singleton, intentional
    if _pool is not None:
        await _pool.close()
        _pool = None


def pool() -> asyncpg.Pool[Any]:
    if _pool is None:
        raise RuntimeError("DB pool not initialized; call init_pool() at startup")
    return _pool
