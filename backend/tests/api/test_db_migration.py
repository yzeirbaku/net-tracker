"""Schema-migration sanity test.

The idempotent migration block at the bottom of db.SCHEMA_SQL renames legacy
account `kind` values (`savings` → `wealth`, `sinking_fund` → `put_aside`)
and retags `asset_class` (`Savings` → `Cash`, NULL for non-wealth). This test
seeds a fresh DB with old-shape rows (after temporarily dropping the new
constraints) and re-runs the schema to verify the migration converges.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient

from app import db


async def test_migration_renames_legacy_kinds_and_asset_classes(
    client: AsyncClient,  # noqa: ARG001 — kept for fixture-ordering consistency
    authed_user: dict[str, str],
) -> None:
    pool = db.pool()
    user_id = uuid.UUID(authed_user["user_id"])

    async with pool.acquire() as conn:
        # Drop the constraints so we can insert old-shape rows for the test.
        await conn.execute(
            "ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_kind_check"
        )
        await conn.execute(
            "ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_asset_class_check"
        )
        await conn.execute(
            "ALTER TABLE accounts DROP CONSTRAINT IF EXISTS "
            "accounts_asset_class_when_wealth"
        )

        # Seed with legacy values from the old data model.
        await conn.execute(
            "INSERT INTO accounts (user_id, name, kind, asset_class) VALUES "
            "($1, 'Legacy Savings',  'savings',      'Savings'), "
            "($1, 'Legacy Sinking',  'sinking_fund', 'Savings'), "
            "($1, 'Legacy Spending', 'spending',     'Savings'), "
            "($1, 'Already Wealth',  'wealth',       'Stocks')",
            user_id,
        )

        # Re-run the full schema bootstrap (idempotent — includes migration).
        await conn.execute(db.SCHEMA_SQL)

        rows = await conn.fetch(
            "SELECT name, kind, asset_class FROM accounts "
            "WHERE user_id = $1 ORDER BY name",
            user_id,
        )

    assert [(r["name"], r["kind"], r["asset_class"]) for r in rows] == [
        ("Already Wealth",  "wealth",    "Stocks"),
        ("Legacy Savings",  "wealth",    "Cash"),
        ("Legacy Sinking",  "put_aside", None),
        ("Legacy Spending", "spending",  None),
    ]


async def test_migration_is_idempotent_on_new_shape_data(
    client: AsyncClient,  # noqa: ARG001
    authed_user: dict[str, str],
) -> None:
    """Running the migration twice in a row must not mutate already-correct data."""
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

        # Run the schema bootstrap again — idempotency check.
        await conn.execute(db.SCHEMA_SQL)

        after = await conn.fetch(
            "SELECT name, kind, asset_class FROM accounts "
            "WHERE user_id = $1 ORDER BY name",
            user_id,
        )

    assert [tuple(r) for r in before] == [tuple(r) for r in after]
