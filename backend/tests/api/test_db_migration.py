"""Schema-migration sanity test.

The idempotent migration block at the bottom of db.SCHEMA_SQL renames legacy
account `kind` values (`savings` → `wealth`, `sinking_fund` → `put_aside`)
and retags `asset_class` (`Savings` → `Cash`, NULL for non-wealth).

The realistic prod scenario is: a database that was originally created under
the OLD schema (with inline CHECKs `kind IN ('spending','savings','sinking_fund')`
and `asset_class IN ('Savings',...)` and `NOT NULL` on `asset_class`) is
booted under the NEW backend. The migration must drop the old constraints,
retag rows, then apply the new constraints — all in the right order.

These tests simulate that path by dropping the table and recreating it with
the literal old-shape DDL, then running SCHEMA_SQL.
"""

from __future__ import annotations

import uuid

import asyncpg
import pytest
from httpx import AsyncClient

from app import db

# The literal CREATE TABLE that shipped before the 2026-05-18 refactor.
# Inline CHECKs constrain kind and asset_class to their old vocabularies,
# and asset_class is NOT NULL. Reapplying this and running SCHEMA_SQL is
# the only way to exercise the migration as prod would.
_LEGACY_ACCOUNTS_DDL = """
CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spending','savings','sinking_fund')),
    asset_class TEXT NOT NULL CHECK (
        asset_class IN ('Savings','Stocks','Crypto','Gold','Pension','Other')
    ),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, name)
);
"""


async def test_migration_renames_legacy_kinds_against_real_old_schema(
    client: AsyncClient,  # noqa: ARG001 — kept for fixture-ordering consistency
    authed_user: dict[str, str],
) -> None:
    """Drop the new-shape accounts table, recreate it with the OLD inline
    constraints and NOT NULL, seed legacy data, then re-run SCHEMA_SQL.
    This exercises the actual prod migration ordering — the previous version
    of this test only dropped the new constraints, which doesn't simulate
    what happens when the old constraints are still in force.
    """
    pool = db.pool()
    user_id = uuid.UUID(authed_user["user_id"])

    async with pool.acquire() as conn:
        # Tear down the new-shape table and rebuild as it would have been
        # on a database created before the refactor.
        await conn.execute("DROP TABLE IF EXISTS accounts CASCADE")
        await conn.execute(_LEGACY_ACCOUNTS_DDL)

        # Seed rows that respect the OLD constraints (so they actually insert).
        await conn.execute(
            "INSERT INTO accounts (user_id, name, kind, asset_class) VALUES "
            "($1, 'Legacy Savings',  'savings',      'Savings'), "
            "($1, 'Legacy Sinking',  'sinking_fund', 'Savings'), "
            "($1, 'Legacy Spending', 'spending',     'Savings'), "
            "($1, 'Legacy Stocks',   'savings',      'Stocks')",
            user_id,
        )

        # Run the full schema bootstrap — must drop legacy constraints,
        # retag rows, and add new constraints in the correct order.
        await conn.execute(db.SCHEMA_SQL)

        rows = await conn.fetch(
            "SELECT name, kind, asset_class FROM accounts "
            "WHERE user_id = $1 ORDER BY name",
            user_id,
        )

    # Expected migrations:
    # - savings + 'Savings' asset class → wealth + 'Cash' (cash-in-bank scenario)
    # - sinking_fund → put_aside, asset_class nulled (non-wealth has no class)
    # - spending → unchanged kind, asset_class nulled
    # - savings + 'Stocks' (already a non-cash asset) → wealth + 'Stocks' preserved
    assert [(r["name"], r["kind"], r["asset_class"]) for r in rows] == [
        ("Legacy Savings",  "wealth",    "Cash"),
        ("Legacy Sinking",  "put_aside", None),
        ("Legacy Spending", "spending",  None),
        ("Legacy Stocks",   "wealth",    "Stocks"),
    ]


async def test_migration_is_idempotent_on_new_shape_data(
    client: AsyncClient,  # noqa: ARG001
    authed_user: dict[str, str],
) -> None:
    """Running the migration twice in a row on already-correct data must be a no-op."""
    pool = db.pool()
    user_id = uuid.UUID(authed_user["user_id"])

    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO accounts (user_id, name, kind, asset_class) VALUES "
            "($1, 'Salary',  'spending',  NULL), "
            "($1, 'Aside',   'put_aside', NULL), "
            "($1, 'Nordnet', 'wealth',    'Stocks')",
            user_id,
        )

        before = await conn.fetch(
            "SELECT name, kind, asset_class FROM accounts "
            "WHERE user_id = $1 ORDER BY name",
            user_id,
        )

        # Re-run the schema bootstrap — idempotency check.
        await conn.execute(db.SCHEMA_SQL)

        after = await conn.fetch(
            "SELECT name, kind, asset_class FROM accounts "
            "WHERE user_id = $1 ORDER BY name",
            user_id,
        )

    assert [tuple(r) for r in before] == [tuple(r) for r in after]


async def test_balance_entries_table_exists(
    client: AsyncClient,  # noqa: ARG001
) -> None:
    """balance_entries table is created by SCHEMA_SQL bootstrap."""
    pool = db.pool()
    async with pool.acquire() as conn:
        cols = await conn.fetch(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'balance_entries' ORDER BY ordinal_position"
        )
    names = [r["column_name"] for r in cols]
    assert "id" in names
    assert "account_id" in names
    assert "entry_date" in names
    assert "value_dkk" in names
    assert "source" in names
    assert "created_at" in names


async def test_balance_entries_unique_constraint(
    client: AsyncClient,  # noqa: ARG001
) -> None:
    """UNIQUE(account_id, entry_date) is enforced."""
    pool = db.pool()
    async with pool.acquire() as conn:
        user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "u@x.com"
        )
        account_id = await conn.fetchval(
            "INSERT INTO accounts (user_id, name, kind, asset_class) "
            "VALUES ($1, 'A', 'wealth', 'Cash') RETURNING id",
            user_id,
        )
        await conn.execute(
            "INSERT INTO balance_entries (account_id, entry_date, value_dkk, source) "
            "VALUES ($1, '2026-01-01', 100, 'manual')",
            account_id,
        )
        with pytest.raises(asyncpg.UniqueViolationError):
            await conn.execute(
                "INSERT INTO balance_entries (account_id, entry_date, value_dkk, source) "
                "VALUES ($1, '2026-01-01', 200, 'manual')",
                account_id,
            )
