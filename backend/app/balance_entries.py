"""Balance entries — per-account snapshots for net-worth history. Wealth-only writes."""

from __future__ import annotations

from datetime import date as date_type
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Response

from app import db
from app.auth_session import require_session
from app.models import BalanceEntryCreate, BalanceEntryOut

router = APIRouter(prefix="/accounts", tags=["balance_entries"])


@router.post("/{account_id}/balance", response_model=BalanceEntryOut)
async def upsert_balance_entry(
    account_id: UUID,
    payload: BalanceEntryCreate,
    response: Response,
    session: dict[str, UUID] = Depends(require_session),
) -> BalanceEntryOut:
    if payload.entry_date > date_type.today():
        raise HTTPException(status_code=400, detail="future_date_not_allowed")

    pool = db.pool()
    async with pool.acquire() as conn:
        account = await conn.fetchrow(
            "SELECT kind FROM accounts WHERE id = $1 AND user_id = $2",
            account_id,
            session["user_id"],
        )
        if account is None:
            raise HTTPException(status_code=404, detail="not_found")
        if account["kind"] != "wealth":
            raise HTTPException(status_code=400, detail="not_a_wealth_account")

        existed = await conn.fetchval(
            "SELECT 1 FROM balance_entries WHERE account_id = $1 AND entry_date = $2",
            account_id,
            payload.entry_date,
        )

        row = await conn.fetchrow(
            "INSERT INTO balance_entries (account_id, entry_date, value_dkk, source) "
            "VALUES ($1, $2, $3, 'manual') "
            "ON CONFLICT (account_id, entry_date) "
            "DO UPDATE SET value_dkk = EXCLUDED.value_dkk "
            "RETURNING id, account_id, entry_date, value_dkk, source, created_at",
            account_id,
            payload.entry_date,
            payload.value_dkk,
        )

    response.status_code = 200 if existed else 201
    return BalanceEntryOut(**dict(row))


@router.delete("/{account_id}/balance/{entry_id}", status_code=204)
async def delete_balance_entry(
    account_id: UUID,
    entry_id: UUID,
    session: dict[str, UUID] = Depends(require_session),
) -> Response:
    pool = db.pool()
    async with pool.acquire() as conn:
        # Verify the entry exists, belongs to this account, and the account
        # belongs to this user. The row count tells us if anything matched.
        result = await conn.execute(
            "DELETE FROM balance_entries be "
            "USING accounts a "
            "WHERE be.id = $1 "
            "AND be.account_id = $2 "
            "AND be.account_id = a.id "
            "AND a.user_id = $3",
            entry_id,
            account_id,
            session["user_id"],
        )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="not_found")
    return Response(status_code=204)
