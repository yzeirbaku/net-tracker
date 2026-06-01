"""Budget — template (one draft + N labelled versions) + monthly plan + ticks.

Mental model:
- The user has exactly one editable `budget_templates` row with status='draft'.
  It's created on first read if missing.
- Snapshotting deep-copies the draft into a new row with status='version'
  (+ deep-copies its categories + items). Versions are read-only.
- Stamping deep-copies the current draft into a `budget_months` row + nested
  categories + items. Months are independently editable.
- Item-done = ticked_at IS NOT NULL OR remaining_dkk <= 0. Archive is locked
  until every item in the month is done. Archived months reject every
  mutation with 409 month_archived.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response

from app import db
from app.auth_session import require_session
from app.models import (
    BudgetMonthCategoryAdd,
    BudgetMonthCategoryOut,
    BudgetMonthExtraIncomeSet,
    BudgetMonthItemCreate,
    BudgetMonthItemOut,
    BudgetMonthItemPatch,
    BudgetMonthOut,
    BudgetMonthSalaryPatch,
    BudgetMonthSummary,
    BudgetTemplateCategoryOut,
    BudgetTemplateItemOut,
    BudgetTemplateOut,
    BudgetTemplatePatch,
    BudgetTemplateVersionCreate,
    BudgetTemplateVersionSummary,
)

router = APIRouter(prefix="/budget", tags=["budget"])

# Calendar bounds for endpoint path params. Postgres rejects months outside
# 1..12 via a CHECK constraint; the year range here is just defensive — any
# four-digit year between 1900 and 9999 is allowed.
_MIN_MONTH = 1
_MAX_MONTH = 12
_MIN_YEAR = 1900
_MAX_YEAR = 9999


# ── Template helpers ─────────────────────────────────────────────────────


async def _get_or_create_draft(
    conn: asyncpg.Connection[Any], user_id: UUID
) -> asyncpg.Record:
    """Return the user's draft template row, creating it on first access.

    Race-safe: ON CONFLICT DO NOTHING + a follow-up SELECT. Multiple concurrent
    first-time requests resolve to the same single draft row.
    """
    await conn.execute(
        "INSERT INTO budget_templates (user_id, status, salary_dkk) "
        "VALUES ($1, 'draft', 0) "
        "ON CONFLICT (user_id) WHERE status = 'draft' DO NOTHING",
        user_id,
    )
    row = await conn.fetchrow(
        "SELECT id, status, label, salary_dkk, created_at "
        "FROM budget_templates WHERE user_id = $1 AND status = 'draft'",
        user_id,
    )
    if row is None:
        raise HTTPException(status_code=500, detail="draft_missing_after_insert")
    return row


def _template_out(
    row: asyncpg.Record, categories: list[BudgetTemplateCategoryOut]
) -> BudgetTemplateOut:
    """Build the BudgetTemplateOut response from a budget_templates row +
    its loaded category tree. Single source for the response shape so
    every template-returning endpoint stays consistent."""
    return BudgetTemplateOut(
        id=row["id"],
        status=row["status"],
        label=row["label"],
        salary_dkk=row["salary_dkk"],
        created_at=row["created_at"],
        categories=categories,
    )


def _month_out(
    row: asyncpg.Record, categories: list[BudgetMonthCategoryOut]
) -> BudgetMonthOut:
    """Build the BudgetMonthOut response from a budget_months row + its
    loaded category tree. Single source for the response shape so every
    month-returning endpoint stays consistent."""
    return BudgetMonthOut(
        id=row["id"],
        year=row["year"],
        month=row["month"],
        salary_dkk=row["salary_dkk"],
        extra_income_name=row["extra_income_name"],
        extra_income_dkk=row["extra_income_dkk"],
        archived_at=row["archived_at"],
        created_at=row["created_at"],
        categories=categories,
    )


async def _load_template_tree(
    conn: asyncpg.Connection[Any], template_id: UUID
) -> list[BudgetTemplateCategoryOut]:
    """Load category + item rows for a template, joined to categories so the
    response carries the category name + color without a second round-trip
    from the frontend."""
    cats = await conn.fetch(
        "SELECT btc.id, btc.category_id, btc.sort_order, "
        "c.name AS category_name, c.color AS category_color "
        "FROM budget_template_categories btc "
        "JOIN categories c ON c.id = btc.category_id "
        "WHERE btc.template_id = $1 "
        "ORDER BY btc.sort_order ASC, c.name ASC",
        template_id,
    )
    if not cats:
        return []
    cat_ids = [c["id"] for c in cats]
    items = await conn.fetch(
        "SELECT id, template_category_id, name, planned_dkk, sort_order "
        "FROM budget_template_items "
        "WHERE template_category_id = ANY($1::uuid[]) "
        "ORDER BY sort_order ASC, name ASC",
        cat_ids,
    )
    items_by_cat: dict[UUID, list[BudgetTemplateItemOut]] = {cid: [] for cid in cat_ids}
    for i in items:
        items_by_cat[i["template_category_id"]].append(
            BudgetTemplateItemOut(
                id=i["id"],
                name=i["name"],
                planned_dkk=i["planned_dkk"],
                sort_order=i["sort_order"],
            )
        )
    return [
        BudgetTemplateCategoryOut(
            id=c["id"],
            category_id=c["category_id"],
            category_name=c["category_name"],
            category_color=c["category_color"],
            sort_order=c["sort_order"],
            items=items_by_cat[c["id"]],
        )
        for c in cats
    ]


async def _replace_template_contents(
    conn: asyncpg.Connection[Any],
    template_id: UUID,
    user_id: UUID,
    payload: BudgetTemplatePatch,
) -> None:
    """Wipe and re-insert categories + items for the given template. The
    surrounding transaction must already be open. Validates that every
    `category_id` belongs to the caller before any write."""
    if payload.categories:
        category_ids = [c.category_id for c in payload.categories]
        owned = await conn.fetch(
            "SELECT id FROM categories "
            "WHERE user_id = $1 AND id = ANY($2::uuid[])",
            user_id,
            category_ids,
        )
        owned_ids = {r["id"] for r in owned}
        for cid in category_ids:
            if cid not in owned_ids:
                raise HTTPException(status_code=400, detail="category_not_found")
        if len(set(category_ids)) != len(category_ids):
            raise HTTPException(
                status_code=400, detail="duplicate_category_in_template"
            )

    await conn.execute(
        "DELETE FROM budget_template_categories WHERE template_id = $1",
        template_id,
    )
    await conn.execute(
        "UPDATE budget_templates SET salary_dkk = $1 WHERE id = $2",
        payload.salary_dkk,
        template_id,
    )
    for cat in payload.categories:
        new_cat_id = await conn.fetchval(
            "INSERT INTO budget_template_categories "
            "(template_id, category_id, sort_order) "
            "VALUES ($1, $2, $3) RETURNING id",
            template_id,
            cat.category_id,
            cat.sort_order,
        )
        if cat.items:
            await conn.executemany(
                "INSERT INTO budget_template_items "
                "(template_category_id, name, planned_dkk, sort_order) "
                "VALUES ($1, $2, $3, $4)",
                [
                    (new_cat_id, it.name, it.planned_dkk, it.sort_order)
                    for it in cat.items
                ],
            )


# ── Template endpoints ───────────────────────────────────────────────────


@router.get("/template", response_model=BudgetTemplateOut)
async def get_template(
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetTemplateOut:
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        draft = await _get_or_create_draft(conn, session["user_id"])
        categories = await _load_template_tree(conn, draft["id"])
    return _template_out(draft, categories)


@router.patch("/template", response_model=BudgetTemplateOut)
async def patch_template(
    payload: BudgetTemplatePatch,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetTemplateOut:
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        draft = await _get_or_create_draft(conn, session["user_id"])
        await _replace_template_contents(
            conn, draft["id"], session["user_id"], payload
        )
        categories = await _load_template_tree(conn, draft["id"])
        refreshed = await conn.fetchrow(
            "SELECT id, status, label, salary_dkk, created_at "
            "FROM budget_templates WHERE id = $1",
            draft["id"],
        )
    if refreshed is None:
        raise HTTPException(status_code=500, detail="template_missing_after_update")
    return _template_out(refreshed, categories)


@router.post(
    "/template/versions",
    response_model=BudgetTemplateVersionSummary,
    status_code=201,
)
async def snapshot_version(
    payload: BudgetTemplateVersionCreate,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetTemplateVersionSummary:
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        draft = await _get_or_create_draft(conn, session["user_id"])
        version_id = await conn.fetchval(
            "INSERT INTO budget_templates "
            "(user_id, status, label, salary_dkk) "
            "VALUES ($1, 'version', $2, $3) RETURNING id",
            session["user_id"],
            payload.label,
            draft["salary_dkk"],
        )
        cats = await conn.fetch(
            "SELECT id, category_id, sort_order "
            "FROM budget_template_categories WHERE template_id = $1",
            draft["id"],
        )
        for c in cats:
            new_cat_id = await conn.fetchval(
                "INSERT INTO budget_template_categories "
                "(template_id, category_id, sort_order) "
                "VALUES ($1, $2, $3) RETURNING id",
                version_id,
                c["category_id"],
                c["sort_order"],
            )
            items = await conn.fetch(
                "SELECT name, planned_dkk, sort_order "
                "FROM budget_template_items WHERE template_category_id = $1",
                c["id"],
            )
            if items:
                await conn.executemany(
                    "INSERT INTO budget_template_items "
                    "(template_category_id, name, planned_dkk, sort_order) "
                    "VALUES ($1, $2, $3, $4)",
                    [
                        (new_cat_id, i["name"], i["planned_dkk"], i["sort_order"])
                        for i in items
                    ],
                )
        summary = await _version_summary(conn, version_id)
    return summary


@router.get("/template/versions", response_model=list[BudgetTemplateVersionSummary])
async def list_versions(
    session: dict[str, UUID] = Depends(require_session),
) -> list[BudgetTemplateVersionSummary]:
    pool = db.pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT t.id, t.label, t.created_at, t.salary_dkk, "
            "  COUNT(DISTINCT btc.id) AS category_count, "
            "  COUNT(bti.id) AS item_count "
            "FROM budget_templates t "
            "LEFT JOIN budget_template_categories btc ON btc.template_id = t.id "
            "LEFT JOIN budget_template_items bti ON bti.template_category_id = btc.id "
            "WHERE t.user_id = $1 AND t.status = 'version' "
            "GROUP BY t.id "
            "ORDER BY t.created_at DESC",
            session["user_id"],
        )
    return [
        BudgetTemplateVersionSummary(
            id=r["id"],
            label=r["label"],
            created_at=r["created_at"],
            salary_dkk=r["salary_dkk"],
            category_count=r["category_count"],
            item_count=r["item_count"],
        )
        for r in rows
    ]


@router.get("/template/versions/{version_id}", response_model=BudgetTemplateOut)
async def get_version(
    version_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetTemplateOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, status, label, salary_dkk, created_at "
            "FROM budget_templates "
            "WHERE id = $1 AND user_id = $2 AND status = 'version'",
            version_id,
            session["user_id"],
        )
        if row is None:
            raise HTTPException(status_code=404, detail="template_version_not_found")
        categories = await _load_template_tree(conn, row["id"])
    return _template_out(row, categories)


@router.delete("/template/versions/{version_id}", status_code=204)
async def delete_version(
    version_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM budget_templates "
            "WHERE id = $1 AND user_id = $2 AND status = 'version'",
            version_id,
            session["user_id"],
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="template_version_not_found")
    return Response(status_code=204)


async def _version_summary(
    conn: asyncpg.Connection[Any], version_id: UUID
) -> BudgetTemplateVersionSummary:
    row = await conn.fetchrow(
        "SELECT t.id, t.label, t.created_at, t.salary_dkk, "
        "  COUNT(DISTINCT btc.id) AS category_count, "
        "  COUNT(bti.id) AS item_count "
        "FROM budget_templates t "
        "LEFT JOIN budget_template_categories btc ON btc.template_id = t.id "
        "LEFT JOIN budget_template_items bti ON bti.template_category_id = btc.id "
        "WHERE t.id = $1 "
        "GROUP BY t.id",
        version_id,
    )
    if row is None:
        raise HTTPException(status_code=500, detail="version_missing_after_insert")
    return BudgetTemplateVersionSummary(
        id=row["id"],
        label=row["label"],
        created_at=row["created_at"],
        salary_dkk=row["salary_dkk"],
        category_count=row["category_count"],
        item_count=row["item_count"],
    )


# ── Month helpers ────────────────────────────────────────────────────────


async def _load_month(
    conn: asyncpg.Connection[Any], user_id: UUID, year: int, month: int
) -> asyncpg.Record | None:
    return await conn.fetchrow(
        "SELECT id, year, month, salary_dkk, extra_income_name, extra_income_dkk, "
        "archived_at, created_at "
        "FROM budget_months WHERE user_id = $1 AND year = $2 AND month = $3",
        user_id,
        year,
        month,
    )


async def _require_month(
    conn: asyncpg.Connection[Any], user_id: UUID, year: int, month: int
) -> asyncpg.Record:
    row = await _load_month(conn, user_id, year, month)
    if row is None:
        raise HTTPException(status_code=404, detail="month_not_stamped")
    return row


def _require_month_active(month_row: asyncpg.Record) -> None:
    if month_row["archived_at"] is not None:
        raise HTTPException(status_code=409, detail="month_archived")


async def _load_month_tree(
    conn: asyncpg.Connection[Any], month_id: UUID
) -> list[BudgetMonthCategoryOut]:
    cats = await conn.fetch(
        "SELECT bmc.id, bmc.category_id, bmc.sort_order, "
        "c.name AS category_name, c.color AS category_color "
        "FROM budget_month_categories bmc "
        "JOIN categories c ON c.id = bmc.category_id "
        "WHERE bmc.month_id = $1 "
        "ORDER BY bmc.sort_order ASC, c.name ASC",
        month_id,
    )
    if not cats:
        return []
    cat_ids = [c["id"] for c in cats]
    items = await conn.fetch(
        "SELECT id, month_category_id, name, planned_dkk, remaining_dkk, "
        "ticked_at, sort_order "
        "FROM budget_month_items "
        "WHERE month_category_id = ANY($1::uuid[]) "
        "ORDER BY sort_order ASC, name ASC",
        cat_ids,
    )
    by_cat: dict[UUID, list[BudgetMonthItemOut]] = {cid: [] for cid in cat_ids}
    for i in items:
        by_cat[i["month_category_id"]].append(
            BudgetMonthItemOut(
                id=i["id"],
                name=i["name"],
                planned_dkk=i["planned_dkk"],
                remaining_dkk=i["remaining_dkk"],
                ticked_at=i["ticked_at"],
                sort_order=i["sort_order"],
            )
        )
    return [
        BudgetMonthCategoryOut(
            id=c["id"],
            category_id=c["category_id"],
            category_name=c["category_name"],
            category_color=c["category_color"],
            sort_order=c["sort_order"],
            items=by_cat[c["id"]],
        )
        for c in cats
    ]


# ── Month endpoints ──────────────────────────────────────────────────────


@router.get("/months", response_model=list[BudgetMonthSummary])
async def list_months(
    session: dict[str, UUID] = Depends(require_session),
) -> list[BudgetMonthSummary]:
    """All months (active + archived) with summary stats. Drives the month
    picker, the archive view, and any future Home composition."""
    pool = db.pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT m.year, m.month, m.created_at AS stamped_at, m.archived_at, "
            "  m.salary_dkk, "
            "  COALESCE(SUM(i.planned_dkk), 0) AS planned_total_dkk, "
            "  COALESCE(SUM(i.planned_dkk - i.remaining_dkk), 0) AS spent_total_dkk, "
            "  COALESCE(SUM(CASE WHEN i.ticked_at IS NULL AND i.remaining_dkk > 0 "
            "                    THEN 1 ELSE 0 END), 0) AS items_open, "
            "  COALESCE(COUNT(i.id), 0) AS items_total "
            "FROM budget_months m "
            "LEFT JOIN budget_month_categories c ON c.month_id = m.id "
            "LEFT JOIN budget_month_items i ON i.month_category_id = c.id "
            "WHERE m.user_id = $1 "
            "GROUP BY m.id "
            "ORDER BY m.year DESC, m.month DESC",
            session["user_id"],
        )
    return [
        BudgetMonthSummary(
            year=r["year"],
            month=r["month"],
            stamped_at=r["stamped_at"],
            archived_at=r["archived_at"],
            salary_dkk=r["salary_dkk"],
            planned_total_dkk=r["planned_total_dkk"],
            spent_total_dkk=r["spent_total_dkk"],
            items_open=int(r["items_open"]),
            items_total=int(r["items_total"]),
        )
        for r in rows
    ]


def _validate_year_month(year: int, month: int) -> None:
    if month < _MIN_MONTH or month > _MAX_MONTH:
        raise HTTPException(status_code=400, detail="invalid_month")
    if year < _MIN_YEAR or year > _MAX_YEAR:
        raise HTTPException(status_code=400, detail="invalid_year")


@router.get("/months/{year}/{month}", response_model=BudgetMonthOut)
async def get_month(
    year: int,
    month: int,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn:
        row = await _require_month(conn, session["user_id"], year, month)
        categories = await _load_month_tree(conn, row["id"])
    return _month_out(row, categories)


@router.post(
    "/months/{year}/{month}/stamp",
    response_model=BudgetMonthOut,
    status_code=201,
)
async def stamp_month(
    year: int,
    month: int,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    """Deep-copy the current draft into the requested month. Refuses to
    overwrite an existing month — re-stamp is deferred (see spec §8). Also
    refuses to stamp a month that has already passed: only the current
    calendar month and future months may be stamped."""
    _validate_year_month(year, month)
    # Past-month gate. (today.year, today.month) is the earliest stampable
    # (year, month) tuple. We do this before any DB read so the rejection
    # is cheap and consistent regardless of stamp state.
    today = date.today()
    if (year, month) < (today.year, today.month):
        raise HTTPException(status_code=400, detail="cannot_stamp_past_month")
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        existing = await _load_month(conn, session["user_id"], year, month)
        if existing is not None:
            raise HTTPException(status_code=409, detail="month_already_stamped")
        draft = await _get_or_create_draft(conn, session["user_id"])

        cats = await conn.fetch(
            "SELECT id, category_id, sort_order "
            "FROM budget_template_categories WHERE template_id = $1",
            draft["id"],
        )
        if not cats:
            raise HTTPException(status_code=409, detail="template_empty")

        try:
            month_id = await conn.fetchval(
                "INSERT INTO budget_months (user_id, year, month, salary_dkk) "
                "VALUES ($1, $2, $3, $4) RETURNING id",
                session["user_id"],
                year,
                month,
                draft["salary_dkk"],
            )
        except asyncpg.UniqueViolationError as e:
            # Race: another concurrent stamp for the same (user, year, month)
            # slipped past the SELECT above. Surface the same friendly 409 as
            # the synchronous duplicate path.
            raise HTTPException(
                status_code=409, detail="month_already_stamped"
            ) from e

        for c in cats:
            new_cat_id = await conn.fetchval(
                "INSERT INTO budget_month_categories "
                "(month_id, category_id, sort_order) "
                "VALUES ($1, $2, $3) RETURNING id",
                month_id,
                c["category_id"],
                c["sort_order"],
            )
            items = await conn.fetch(
                "SELECT name, planned_dkk, sort_order "
                "FROM budget_template_items "
                "WHERE template_category_id = $1",
                c["id"],
            )
            if items:
                await conn.executemany(
                    "INSERT INTO budget_month_items "
                    "(month_category_id, name, planned_dkk, "
                    " remaining_dkk, sort_order) "
                    "VALUES ($1, $2, $3, $4, $5)",
                    [
                        (
                            new_cat_id,
                            i["name"],
                            i["planned_dkk"],
                            i["planned_dkk"],  # remaining starts = planned
                            i["sort_order"],
                        )
                        for i in items
                    ],
                )

        month_row = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, month_row["id"])
    return _month_out(month_row, categories)


@router.patch("/months/{year}/{month}", response_model=BudgetMonthOut)
async def patch_month_salary(
    year: int,
    month: int,
    payload: BudgetMonthSalaryPatch,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        await conn.execute(
            "UPDATE budget_months SET salary_dkk = $1 WHERE id = $2",
            payload.salary_dkk,
            month_row["id"],
        )
        refreshed = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, refreshed["id"])
    return _month_out(refreshed, categories)


@router.put(
    "/months/{year}/{month}/extra-income", response_model=BudgetMonthOut
)
async def put_month_extra_income(
    year: int,
    month: int,
    payload: BudgetMonthExtraIncomeSet,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    """Set or overwrite the optional one-off income line for the month."""
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        await conn.execute(
            "UPDATE budget_months "
            "SET extra_income_name = $1, extra_income_dkk = $2 "
            "WHERE id = $3",
            payload.name.strip(),
            payload.amount_dkk,
            month_row["id"],
        )
        refreshed = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, refreshed["id"])
    return _month_out(refreshed, categories)


@router.delete(
    "/months/{year}/{month}/extra-income", response_model=BudgetMonthOut
)
async def delete_month_extra_income(
    year: int,
    month: int,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    """Clear the extra-income line — leaves the rest of the month untouched."""
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        await conn.execute(
            "UPDATE budget_months "
            "SET extra_income_name = NULL, extra_income_dkk = 0 "
            "WHERE id = $1",
            month_row["id"],
        )
        refreshed = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, refreshed["id"])
    return _month_out(refreshed, categories)


@router.post(
    "/months/{year}/{month}/categories",
    response_model=BudgetMonthCategoryOut,
    status_code=201,
)
async def add_month_category(
    year: int,
    month: int,
    payload: BudgetMonthCategoryAdd,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthCategoryOut:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        owned = await conn.fetchval(
            "SELECT id FROM categories WHERE id = $1 AND user_id = $2",
            payload.category_id,
            session["user_id"],
        )
        if owned is None:
            raise HTTPException(status_code=400, detail="category_not_found")
        next_sort = await conn.fetchval(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 "
            "FROM budget_month_categories WHERE month_id = $1",
            month_row["id"],
        )
        try:
            new_id = await conn.fetchval(
                "INSERT INTO budget_month_categories "
                "(month_id, category_id, sort_order) "
                "VALUES ($1, $2, $3) RETURNING id",
                month_row["id"],
                payload.category_id,
                next_sort,
            )
        except asyncpg.UniqueViolationError as e:
            raise HTTPException(
                status_code=409, detail="category_already_in_month"
            ) from e
        row = await conn.fetchrow(
            "SELECT bmc.id, bmc.category_id, bmc.sort_order, "
            "c.name AS category_name, c.color AS category_color "
            "FROM budget_month_categories bmc "
            "JOIN categories c ON c.id = bmc.category_id "
            "WHERE bmc.id = $1",
            new_id,
        )
    if row is None:
        raise HTTPException(
            status_code=500, detail="month_category_missing_after_insert"
        )
    return BudgetMonthCategoryOut(
        id=row["id"],
        category_id=row["category_id"],
        category_name=row["category_name"],
        category_color=row["category_color"],
        sort_order=row["sort_order"],
        items=[],
    )


@router.delete(
    "/months/{year}/{month}/categories/{month_category_id}", status_code=204
)
async def remove_month_category(
    year: int,
    month: int,
    month_category_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        result = await conn.execute(
            "DELETE FROM budget_month_categories "
            "WHERE id = $1 AND month_id = $2",
            month_category_id,
            month_row["id"],
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)


@router.post(
    "/months/{year}/{month}/items",
    response_model=BudgetMonthItemOut,
    status_code=201,
)
async def add_month_item(
    year: int,
    month: int,
    payload: BudgetMonthItemCreate,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthItemOut:
    """Add an item to a category in this month. If `already_paid` is true,
    the item is created already-done (remaining=0, ticked_at=NOW()) — this
    is the "free-form tick" path for unplanned spending."""
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        # Look up the month_category row for the requested category_id,
        # auto-creating it if missing. Lets the frontend keep adding ad-hoc
        # items to a category that wasn't in the original stamp.
        month_cat_row = await conn.fetchrow(
            "SELECT id FROM budget_month_categories "
            "WHERE month_id = $1 AND category_id = $2",
            month_row["id"],
            payload.category_id,
        )
        if month_cat_row is None:
            owned = await conn.fetchval(
                "SELECT id FROM categories WHERE id = $1 AND user_id = $2",
                payload.category_id,
                session["user_id"],
            )
            if owned is None:
                raise HTTPException(status_code=400, detail="category_not_found")
            next_sort = await conn.fetchval(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 "
                "FROM budget_month_categories WHERE month_id = $1",
                month_row["id"],
            )
            try:
                month_cat_id = await conn.fetchval(
                    "INSERT INTO budget_month_categories "
                    "(month_id, category_id, sort_order) "
                    "VALUES ($1, $2, $3) RETURNING id",
                    month_row["id"],
                    payload.category_id,
                    next_sort,
                )
            except asyncpg.UniqueViolationError:
                # Race: another concurrent add for the same category created
                # the bmc row in between our SELECT and INSERT. Reload it.
                bumped = await conn.fetchrow(
                    "SELECT id FROM budget_month_categories "
                    "WHERE month_id = $1 AND category_id = $2",
                    month_row["id"],
                    payload.category_id,
                )
                if bumped is None:
                    raise
                month_cat_id = bumped["id"]
        else:
            month_cat_id = month_cat_row["id"]
        now = datetime.now(UTC)
        remaining = Decimal("0") if payload.already_paid else payload.planned_dkk
        ticked_at = now if payload.already_paid else None
        next_item_sort = await conn.fetchval(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 "
            "FROM budget_month_items WHERE month_category_id = $1",
            month_cat_id,
        )
        row = await conn.fetchrow(
            "INSERT INTO budget_month_items "
            "(month_category_id, name, planned_dkk, remaining_dkk, "
            " ticked_at, sort_order) "
            "VALUES ($1, $2, $3, $4, $5, $6) "
            "RETURNING id, name, planned_dkk, remaining_dkk, "
            "ticked_at, sort_order",
            month_cat_id,
            payload.name,
            payload.planned_dkk,
            remaining,
            ticked_at,
            next_item_sort,
        )
    if row is None:
        raise HTTPException(status_code=500, detail="item_missing_after_insert")
    return BudgetMonthItemOut(
        id=row["id"],
        name=row["name"],
        planned_dkk=row["planned_dkk"],
        remaining_dkk=row["remaining_dkk"],
        ticked_at=row["ticked_at"],
        sort_order=row["sort_order"],
    )


@router.patch(
    "/months/{year}/{month}/items/{item_id}", response_model=BudgetMonthItemOut
)
async def patch_month_item(
    year: int,
    month: int,
    item_id: UUID,
    payload: BudgetMonthItemPatch,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthItemOut:
    """Workhorse PATCH. Tick/untick, edit remaining, rename, change planned.
    Auto-ticks when remaining drops to 0. Untick (ticked=false) clears
    ticked_at but does NOT restore remaining — the user can edit remaining
    separately."""
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        current = await conn.fetchrow(
            "SELECT bmi.id, bmi.name, bmi.planned_dkk, bmi.remaining_dkk, "
            "bmi.ticked_at, bmi.sort_order, bmi.month_category_id "
            "FROM budget_month_items bmi "
            "JOIN budget_month_categories bmc "
            "  ON bmc.id = bmi.month_category_id "
            "WHERE bmi.id = $1 AND bmc.month_id = $2",
            item_id,
            month_row["id"],
        )
        if current is None:
            raise HTTPException(status_code=404, detail="not_found")

        new_name = payload.name if payload.name is not None else current["name"]
        new_planned = (
            payload.planned_dkk
            if payload.planned_dkk is not None
            else current["planned_dkk"]
        )
        new_remaining = (
            payload.remaining_dkk
            if payload.remaining_dkk is not None
            else current["remaining_dkk"]
        )
        new_ticked_at = current["ticked_at"]
        now = datetime.now(UTC)
        explicit_untick = payload.ticked is False
        if payload.ticked is True:
            new_ticked_at = now
            # "Tick" means "paid in full from this point" — zero out remaining
            # so the spent total reflects the planned amount. Skip this when
            # the client explicitly set remaining_dkk in the same PATCH (a
            # partial-pay-and-tick combo means "I paid this much, mark done
            # with the rest unused").
            if payload.remaining_dkk is None:
                new_remaining = Decimal("0")
        elif explicit_untick:
            new_ticked_at = None
            # Untick fully reverses the tick: restore remaining to planned so
            # the item-done predicate (ticked_at IS NOT NULL OR remaining <= 0)
            # doesn't keep the row marked complete. Skip if:
            #   - the client sent an explicit remaining_dkk (user's value wins), or
            #   - the row wasn't actually ticked to begin with (no-op untick — we
            #     must not overwrite a partial-pay value that the user set while
            #     the row was open).
            if payload.remaining_dkk is None and current["ticked_at"] is not None:
                new_remaining = new_planned
        # Auto-tick when remaining reaches 0 — but never when the same PATCH
        # carried an explicit `ticked: false`. The explicit verb wins over
        # the predicate, so a request like `{ticked:false, remaining_dkk:0}`
        # round-trips honestly (untick + zero remaining = an "open with
        # nothing left to pay" row, which the user can then re-edit).
        if new_remaining <= 0 and new_ticked_at is None and not explicit_untick:
            new_ticked_at = now

        row = await conn.fetchrow(
            "UPDATE budget_month_items "
            "SET name = $1, planned_dkk = $2, remaining_dkk = $3, "
            "    ticked_at = $4 "
            "WHERE id = $5 "
            "RETURNING id, name, planned_dkk, remaining_dkk, "
            "ticked_at, sort_order",
            new_name,
            new_planned,
            new_remaining,
            new_ticked_at,
            item_id,
        )
    if row is None:
        raise HTTPException(status_code=500, detail="item_missing_after_update")
    return BudgetMonthItemOut(
        id=row["id"],
        name=row["name"],
        planned_dkk=row["planned_dkk"],
        remaining_dkk=row["remaining_dkk"],
        ticked_at=row["ticked_at"],
        sort_order=row["sort_order"],
    )


@router.delete(
    "/months/{year}/{month}/items/{item_id}", status_code=204
)
async def delete_month_item(
    year: int,
    month: int,
    item_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        _require_month_active(month_row)
        result = await conn.execute(
            "DELETE FROM budget_month_items bmi "
            "USING budget_month_categories bmc "
            "WHERE bmi.id = $1 "
            "AND bmi.month_category_id = bmc.id "
            "AND bmc.month_id = $2",
            item_id,
            month_row["id"],
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)


@router.post(
    "/months/{year}/{month}/archive",
    response_model=BudgetMonthOut,
)
async def archive_month(
    year: int,
    month: int,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        if month_row["archived_at"] is not None:
            # Idempotent: already archived, just return the row.
            categories = await _load_month_tree(conn, month_row["id"])
            return _month_out(month_row, categories)
        open_count = await conn.fetchval(
            "SELECT COUNT(*) FROM budget_month_items bmi "
            "JOIN budget_month_categories bmc "
            "  ON bmc.id = bmi.month_category_id "
            "WHERE bmc.month_id = $1 "
            "  AND bmi.ticked_at IS NULL "
            "  AND bmi.remaining_dkk > 0",
            month_row["id"],
        )
        if open_count and open_count > 0:
            raise HTTPException(status_code=409, detail="not_fully_ticked")
        await conn.execute(
            "UPDATE budget_months SET archived_at = NOW() WHERE id = $1",
            month_row["id"],
        )
        refreshed = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, refreshed["id"])
    return _month_out(refreshed, categories)


@router.post(
    "/months/{year}/{month}/unarchive",
    response_model=BudgetMonthOut,
)
async def unarchive_month(
    year: int,
    month: int,
    session: dict[str, UUID] = Depends(require_session),
) -> BudgetMonthOut:
    _validate_year_month(year, month)
    pool = db.pool()
    async with pool.acquire() as conn, conn.transaction():
        month_row = await _require_month(conn, session["user_id"], year, month)
        await conn.execute(
            "UPDATE budget_months SET archived_at = NULL WHERE id = $1",
            month_row["id"],
        )
        refreshed = await _require_month(
            conn, session["user_id"], year, month
        )
        categories = await _load_month_tree(conn, refreshed["id"])
    return _month_out(refreshed, categories)
