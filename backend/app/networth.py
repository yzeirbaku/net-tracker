"""Net-worth math + GET /networth endpoint.

The pure math functions (latest_per_account, compute_total_at, build_series,
build_deltas, build_composition) take lists of entry dicts and return plain
dict / Decimal data. They do not touch the DB. The endpoint at the bottom of
this file does the SQL fan-out and feeds results into the math.

Entry dict shape (returned from the SQL JOIN in the endpoint):
    {"account_id": UUID, "asset_class": str, "entry_date": date, "value_dkk": Decimal}
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date as date_type
from datetime import timedelta
from decimal import Decimal
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from app import db
from app.auth_session import require_session
from app.models import (
    NetWorthAccountSparkPoint,
    NetWorthAccountSummary,
    NetWorthCompositionSlice,
    NetWorthDelta,
    NetWorthOut,
    NetWorthSeriesPoint,
)

router = APIRouter(prefix="/networth", tags=["networth"])

_PERIOD_DAYS = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}

# Canonical display order for asset classes. Matches the spec's Net Worth view.
_ASSET_CLASS_ORDER = ("Cash", "Stocks", "Crypto", "Gold", "Pension", "Other")


def latest_per_account(
    entries: list[dict[str, Any]],
    on_or_before: date_type,
) -> dict[Any, tuple[Decimal, str]]:
    """For each account_id, return (latest value_dkk on or before `on_or_before`, asset_class).

    Accounts whose earliest entry is after `on_or_before` are omitted.
    """
    latest: dict[Any, tuple[date_type, Decimal, str]] = {}
    for e in entries:
        if e["entry_date"] > on_or_before:
            continue
        prev = latest.get(e["account_id"])
        if prev is None or e["entry_date"] > prev[0]:
            latest[e["account_id"]] = (e["entry_date"], e["value_dkk"], e["asset_class"])
    return {aid: (v, cls) for aid, (_, v, cls) in latest.items()}


def compute_total_at(entries: list[dict[str, Any]], on: date_type) -> Decimal:
    """Net worth on date `on` = sum of latest value per account on or before `on`."""
    return sum(
        (v for v, _ in latest_per_account(entries, on_or_before=on).values()),
        Decimal("0"),
    )


def build_series(
    entries: list[dict[str, Any]],
    range_from: date_type,
    range_to: date_type,
) -> list[dict[str, Any]]:
    """Sparse step-series of total over time.

    Emits one prefix point at `range_from` (carrying forward NW(range_from))
    plus one point per actual change-date inside (range_from, range_to].
    Returns [] when there is no history at all.
    """
    if not entries:
        return []
    in_range = sorted(
        {e["entry_date"] for e in entries if range_from < e["entry_date"] <= range_to}
    )
    prefix_total = compute_total_at(entries, on=range_from)
    points: list[dict[str, Any]] = [{"date": range_from, "total_dkk": prefix_total}]
    for d in in_range:
        points.append({"date": d, "total_dkk": compute_total_at(entries, on=d)})
    return points


def build_deltas(entries: list[dict[str, Any]], today: date_type) -> list[dict[str, Any]]:
    """Compute the 5 standard period deltas: 1M / 3M / 6M / 1Y / ALL."""
    if not entries:
        return [
            {"period": p, "delta_dkk": Decimal("0"), "anchor_date": today, "is_since_start": False}
            for p in ("1M", "3M", "6M", "1Y", "ALL")
        ]
    earliest = min(e["entry_date"] for e in entries)
    today_total = compute_total_at(entries, on=today)
    out: list[dict[str, Any]] = []
    for period, days in _PERIOD_DAYS.items():
        anchor = today - timedelta(days=days)
        if anchor < earliest:
            anchor = earliest
            is_since_start = True
        else:
            is_since_start = False
        anchor_total = compute_total_at(entries, on=anchor)
        out.append(
            {
                "period": period,
                "delta_dkk": today_total - anchor_total,
                "anchor_date": anchor,
                "is_since_start": is_since_start,
            }
        )
    out.append(
        {
            "period": "ALL",
            "delta_dkk": today_total - compute_total_at(entries, on=earliest),
            "anchor_date": earliest,
            "is_since_start": True,
        }
    )
    return out


def build_composition(
    entries: list[dict[str, Any]], on: date_type
) -> list[dict[str, Any]]:
    """Slice net worth by asset_class on `on`. Hides zero-value slices."""
    latest = latest_per_account(entries, on_or_before=on)
    by_class: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    for value, cls in latest.values():
        by_class[cls] += value
    total = sum(by_class.values(), Decimal("0"))
    if total == 0:
        return []
    return [
        {"asset_class": cls, "value_dkk": v, "pct": float(v / total)}
        for cls, v in sorted(by_class.items(), key=lambda kv: -kv[1])
        if v > 0
    ]


@router.get("", response_model=NetWorthOut)
async def get_networth(
    from_: date_type | None = Query(default=None, alias="from"),
    to: date_type | None = Query(default=None),
    session: dict[str, UUID] = Depends(require_session),
) -> NetWorthOut:
    today = date_type.today()
    range_to = to or today
    range_from = from_ or (today - timedelta(days=365))
    if range_from > range_to:
        raise HTTPException(status_code=400, detail="invalid_range")

    pool = db.pool()
    async with pool.acquire() as conn:
        # Pull every wealth account + every balance entry in one go via
        # LEFT JOIN. Accounts without entries appear as rows with NULL
        # entry_date / value_dkk so we can render an "Add first balance"
        # row for them in the per-class section.
        rows = await conn.fetch(
            "SELECT a.id AS account_id, a.asset_class, a.name AS account_name, "
            "be.entry_date, be.value_dkk "
            "FROM accounts a "
            "LEFT JOIN balance_entries be ON be.account_id = a.id "
            "WHERE a.user_id = $1 AND a.kind = 'wealth' "
            "ORDER BY a.id, be.entry_date",
            session["user_id"],
        )

    entries = [
        {
            "account_id": r["account_id"],
            "asset_class": r["asset_class"],
            "entry_date": r["entry_date"],
            "value_dkk": r["value_dkk"],
        }
        for r in rows
        if r["entry_date"] is not None
    ]

    total = compute_total_at(entries, on=today)
    series = build_series(entries, range_from=range_from, range_to=range_to)
    deltas = build_deltas(entries, today=today)
    composition = build_composition(entries, on=today)

    # Group rows by account. An account with no entries shows up as a single
    # row with entry_date IS NULL — keep it but emit a zero-length sparkline.
    by_account: dict[Any, dict[str, Any]] = {}
    for r in rows:
        acct = by_account.setdefault(
            r["account_id"],
            {
                "name": r["account_name"],
                "asset_class": r["asset_class"],
                "entries": [],
            },
        )
        if r["entry_date"] is not None:
            acct["entries"].append(
                {"entry_date": r["entry_date"], "value_dkk": r["value_dkk"]}
            )

    accounts: list[NetWorthAccountSummary] = []
    for aid, acct in by_account.items():
        items_sorted = sorted(acct["entries"], key=lambda x: x["entry_date"])
        if items_sorted:
            latest = items_sorted[-1]
            latest_value: Decimal | None = latest["value_dkk"]
            latest_date: Any = latest["entry_date"]
        else:
            latest_value = None
            latest_date = None
        accounts.append(
            NetWorthAccountSummary(
                id=aid,
                name=acct["name"],
                asset_class=acct["asset_class"],
                latest_value_dkk=latest_value,
                latest_entry_date=latest_date,
                sparkline=[
                    NetWorthAccountSparkPoint(
                        date=i["entry_date"], value_dkk=i["value_dkk"]
                    )
                    for i in items_sorted
                ],
            )
        )
    def _class_rank(cls: str) -> int:
        if cls in _ASSET_CLASS_ORDER:
            return _ASSET_CLASS_ORDER.index(cls)
        return len(_ASSET_CLASS_ORDER)

    accounts.sort(key=lambda a: (_class_rank(a.asset_class), a.name))

    return NetWorthOut(
        total_dkk=total,
        as_of=today,
        series=[NetWorthSeriesPoint(**p) for p in series],
        deltas=[NetWorthDelta(**d) for d in deltas],
        composition=[NetWorthCompositionSlice(**c) for c in composition],
        accounts=accounts,
    )
