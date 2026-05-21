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


def classify_unique_violation(
    e: asyncpg.UniqueViolationError, mappings: dict[str, str]
) -> str | None:
    """Map an asyncpg unique-violation to a snake_case error code.

    `mappings` is `{constraint_or_index_name: error_code}`. We check
    `e.constraint_name` first (cheap + reliable on modern Postgres), then
    fall back to scanning the error message — the partial unique INDEX case
    doesn't always populate `constraint_name`, so the message scan covers us.

    Returns None when the violation doesn't belong to any known constraint;
    callers should re-raise in that case.
    """
    cname = getattr(e, "constraint_name", None) or ""
    if cname in mappings:
        return mappings[cname]
    msg = str(e)
    for name, code in mappings.items():
        if name in msg:
            return code
    return None


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

-- Intermediate constraint accepts both the old 'Gold' and the new 'Precious
-- Metals' value so it doesn't block re-running the bootstrap on a DB that
-- already migrated. The narrowing happens at the bottom of SCHEMA_SQL.
ALTER TABLE accounts ADD CONSTRAINT accounts_asset_class_check CHECK (
    asset_class IS NULL OR asset_class IN (
        'Cash', 'Stocks', 'Crypto', 'Gold', 'Precious Metals', 'Pension', 'Other'
    )
);

-- Wealth accounts must have an asset_class; non-wealth must not.
ALTER TABLE accounts ADD CONSTRAINT accounts_asset_class_when_wealth CHECK (
    (kind = 'wealth' AND asset_class IS NOT NULL)
    OR (kind <> 'wealth' AND asset_class IS NULL)
);

CREATE TABLE IF NOT EXISTS balance_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    entry_date DATE NOT NULL,
    value_dkk NUMERIC(14, 2) NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, entry_date),
    CONSTRAINT balance_entries_source_check
        CHECK (source IN ('manual', 'csv_import'))
);

CREATE INDEX IF NOT EXISTS idx_balance_entries_account_date
    ON balance_entries(account_id, entry_date);

-- 2026-05-19 migration: rename 'Gold' asset class to 'Precious Metals'.
-- Same ordering trick as the earlier rename: drop the constraint first,
-- update rows, then re-apply with the new vocabulary. DROP IF EXISTS makes
-- this safe to run repeatedly on already-migrated databases.

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_asset_class_check;

UPDATE accounts SET asset_class = 'Precious Metals' WHERE asset_class = 'Gold';

ALTER TABLE accounts ADD CONSTRAINT accounts_asset_class_check CHECK (
    asset_class IS NULL OR asset_class IN (
        'Cash', 'Stocks', 'Crypto', 'Precious Metals', 'Pension', 'Other'
    )
);

-- 2026-05-20 Plan 3 (Budget): unique color per user. Categories with a color
-- must not share it with another of the same user's categories. NULL colors
-- are unconstrained (the picker reserves a "no color" option as a fallback).
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_color_unique
    ON categories(user_id, color) WHERE color IS NOT NULL;

-- 2026-05-20 Plan 3 (Budget): template (one draft + N labelled versions),
-- monthly plan (deep-copy of the draft, then independently editable).
CREATE TABLE IF NOT EXISTS budget_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    label TEXT,
    salary_dkk NUMERIC(12, 2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT budget_templates_status_check
        CHECK (status IN ('draft', 'version'))
);

-- Exactly one draft per user. Many version rows allowed per user.
CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_templates_one_draft_per_user
    ON budget_templates(user_id) WHERE status = 'draft';

CREATE INDEX IF NOT EXISTS idx_budget_templates_user_status_created
    ON budget_templates(user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS budget_template_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES budget_templates(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (template_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_template_categories_template
    ON budget_template_categories(template_id);

CREATE TABLE IF NOT EXISTS budget_template_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_category_id UUID NOT NULL
        REFERENCES budget_template_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    planned_dkk NUMERIC(12, 2) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_budget_template_items_template_category
    ON budget_template_items(template_category_id);

CREATE TABLE IF NOT EXISTS budget_months (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    salary_dkk NUMERIC(12, 2) NOT NULL DEFAULT 0,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, year, month),
    CONSTRAINT budget_months_month_check CHECK (month BETWEEN 1 AND 12)
);

CREATE INDEX IF NOT EXISTS idx_budget_months_user_year_month
    ON budget_months(user_id, year DESC, month DESC);

CREATE TABLE IF NOT EXISTS budget_month_categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    month_id UUID NOT NULL REFERENCES budget_months(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE (month_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_budget_month_categories_month
    ON budget_month_categories(month_id);

CREATE TABLE IF NOT EXISTS budget_month_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    month_category_id UUID NOT NULL
        REFERENCES budget_month_categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    planned_dkk NUMERIC(12, 2) NOT NULL,
    remaining_dkk NUMERIC(12, 2) NOT NULL,
    ticked_at TIMESTAMPTZ,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_budget_month_items_month_category
    ON budget_month_items(month_category_id);
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
