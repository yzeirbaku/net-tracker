"""Per-user category CRUD."""

from __future__ import annotations

from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response

from app import db
from app.auth_session import require_session
from app.models import CategoryCreate, CategoryOut, CategoryUpdate

router = APIRouter(prefix="/categories", tags=["categories"])


# Constraint / unique-index names that asyncpg surfaces on insert/update.
# Catching by-attribute first (UniqueViolationError.constraint_name), then
# falling back to a substring scan of the error message — the partial
# unique INDEX for color doesn't always populate constraint_name in older
# Postgres versions, so the fallback covers us.
_NAME_UNIQUE = "categories_user_id_name_key"
_COLOR_UNIQUE = "idx_categories_user_color_unique"


def _classify_unique_violation(e: asyncpg.UniqueViolationError) -> str | None:
    """Map an asyncpg unique-violation to a snake_case error code, or None
    if it doesn't belong to a constraint we know how to surface."""
    cname = getattr(e, "constraint_name", None) or ""
    msg = str(e)
    if _NAME_UNIQUE in (cname, msg):
        return "category_name_taken"
    if _COLOR_UNIQUE in (cname, msg):
        return "color_taken"
    # Substring fallback for the index case where constraint_name is empty.
    if _NAME_UNIQUE in msg:
        return "category_name_taken"
    if _COLOR_UNIQUE in msg:
        return "color_taken"
    return None


@router.get("", response_model=list[CategoryOut])
async def list_categories(
    session: dict[str, UUID] = Depends(require_session),
) -> list[CategoryOut]:
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
                "INSERT INTO categories "
                "(user_id, name, color, exclude_from_spend, sort_order) "
                "VALUES ($1, $2, $3, $4, $5) "
                "RETURNING id, name, color, exclude_from_spend, sort_order, created_at",
                session["user_id"],
                payload.name,
                payload.color,
                payload.exclude_from_spend,
                payload.sort_order,
            )
        except asyncpg.UniqueViolationError as e:
            code = _classify_unique_violation(e)
            if code is None:
                raise
            raise HTTPException(status_code=409, detail=code) from e
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
        new_sort = (
            payload.sort_order if payload.sort_order is not None else row["sort_order"]
        )

        try:
            updated = await conn.fetchrow(
                "UPDATE categories SET name=$1, color=$2, exclude_from_spend=$3, "
                "sort_order=$4 WHERE id = $5 AND user_id = $6 "
                "RETURNING id, name, color, exclude_from_spend, sort_order, created_at",
                new_name,
                new_color,
                new_excl,
                new_sort,
                category_id,
                session["user_id"],
            )
        except asyncpg.UniqueViolationError as e:
            code = _classify_unique_violation(e)
            if code is None:
                raise
            raise HTTPException(status_code=409, detail=code) from e
    return CategoryOut(**dict(updated))


@router.delete("/{category_id}", status_code=204)
async def delete_category(
    category_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        deleted = await conn.execute(
            "DELETE FROM categories WHERE id = $1 AND user_id = $2",
            category_id,
            session["user_id"],
        )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)
