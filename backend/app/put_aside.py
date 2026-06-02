"""Put-aside: a flat list of named amounts per user, sorted by amount desc.

No buckets, no dates, no history — the list IS the current state. Delete to
remove. Total is always re-derived from the row set, never stored.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response

from app import db
from app.auth_session import require_session
from app.models import (
    PutAsideItemCreate,
    PutAsideItemOut,
    PutAsideItemUpdate,
    PutAsideOut,
)

router = APIRouter(prefix="/put-aside", tags=["put-aside"])


@router.get("", response_model=PutAsideOut)
async def get_put_aside(
    session: dict[str, UUID] = Depends(require_session),
) -> PutAsideOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, amount_dkk, created_at, updated_at "
            "FROM put_aside_items WHERE user_id = $1 "
            "ORDER BY amount_dkk DESC, created_at ASC",
            session["user_id"],
        )
    items = [PutAsideItemOut(**dict(r)) for r in rows]
    total = sum((it.amount_dkk for it in items), start=Decimal("0"))
    return PutAsideOut(total_dkk=total, items=items)


@router.post("/items", response_model=PutAsideItemOut, status_code=201)
async def create_item(
    payload: PutAsideItemCreate,
    session: dict[str, UUID] = Depends(require_session),
) -> PutAsideItemOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO put_aside_items (user_id, name, amount_dkk) "
            "VALUES ($1, $2, $3) "
            "RETURNING id, name, amount_dkk, created_at, updated_at",
            session["user_id"],
            payload.name,
            payload.amount_dkk,
        )
    if row is None:
        raise HTTPException(status_code=500, detail="item_missing_after_insert")
    return PutAsideItemOut(**dict(row))


@router.put("/items/{item_id}", response_model=PutAsideItemOut)
async def update_item(
    item_id: UUID,
    payload: PutAsideItemUpdate,
    session: dict[str, UUID] = Depends(require_session),
) -> PutAsideItemOut:
    pool = db.pool()
    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            "SELECT id, name, amount_dkk, created_at, updated_at "
            "FROM put_aside_items WHERE id = $1 AND user_id = $2",
            item_id,
            session["user_id"],
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="not_found")

        new_name = payload.name if payload.name is not None else existing["name"]
        new_amount = (
            payload.amount_dkk
            if payload.amount_dkk is not None
            else existing["amount_dkk"]
        )
        updated = await conn.fetchrow(
            "UPDATE put_aside_items SET name = $1, amount_dkk = $2, updated_at = NOW() "
            "WHERE id = $3 AND user_id = $4 "
            "RETURNING id, name, amount_dkk, created_at, updated_at",
            new_name,
            new_amount,
            item_id,
            session["user_id"],
        )
    if updated is None:
        raise HTTPException(status_code=500, detail="item_missing_after_update")
    return PutAsideItemOut(**dict(updated))


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(
    item_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        deleted = await conn.execute(
            "DELETE FROM put_aside_items WHERE id = $1 AND user_id = $2",
            item_id,
            session["user_id"],
        )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)
