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

_PERIOD_DAYS = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365}


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
