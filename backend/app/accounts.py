"""Per-user account CRUD. Accounts have a `kind` that drives downstream behavior."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response

from app import db
from app.auth_session import require_session
from app.models import AccountCreate, AccountOut, AccountUpdate

router = APIRouter(prefix="/accounts", tags=["accounts"])


@router.get("", response_model=list[AccountOut])
async def list_accounts(
    session: dict[str, UUID] = Depends(require_session),
) -> list[AccountOut]:
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
                "INSERT INTO accounts "
                "(user_id, name, kind, asset_class, sort_order) "
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
            payload.asset_class.value
            if payload.asset_class is not None
            else row["asset_class"]
        )
        new_sort = (
            payload.sort_order if payload.sort_order is not None else row["sort_order"]
        )

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
) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        deleted = await conn.execute(
            "DELETE FROM accounts WHERE id = $1 AND user_id = $2",
            account_id,
            session["user_id"],
        )
    if deleted == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)
