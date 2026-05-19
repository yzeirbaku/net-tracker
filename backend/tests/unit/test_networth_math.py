"""Pure-function tests for net-worth math.

The math layer takes lists of (account_id, asset_class, entry_date, value_dkk)
tuples and computes totals/series/deltas/composition. No DB access here — the
endpoint layer does the SQL and feeds the results in.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from app.networth import (
    build_composition,
    build_deltas,
    build_series,
    compute_liquid_net_worth,
    compute_total_at,
    latest_per_account,
)


def E(account_id: str, asset_class: str, d: str, v: str) -> dict[str, Any]:
    return {
        "account_id": account_id,
        "asset_class": asset_class,
        "entry_date": date.fromisoformat(d),
        "value_dkk": Decimal(v),
    }


def test_latest_per_account_picks_most_recent_on_or_before() -> None:
    entries = [
        E("a1", "Cash", "2026-01-01", "100"),
        E("a1", "Cash", "2026-02-01", "150"),
        E("a1", "Cash", "2026-03-01", "200"),
        E("a2", "Stocks", "2026-01-15", "500"),
    ]
    result = latest_per_account(entries, on_or_before=date(2026, 2, 15))
    assert result == {
        "a1": (Decimal("150"), "Cash"),
        "a2": (Decimal("500"), "Stocks"),
    }


def test_latest_per_account_omits_accounts_with_no_entries_in_range() -> None:
    entries = [
        E("a1", "Cash", "2026-03-01", "100"),
    ]
    result = latest_per_account(entries, on_or_before=date(2026, 1, 1))
    assert result == {}


def test_compute_total_at_sums_latest_per_account() -> None:
    entries = [
        E("a1", "Cash", "2026-01-01", "100"),
        E("a2", "Stocks", "2026-02-01", "500"),
    ]
    assert compute_total_at(entries, on=date(2026, 3, 1)) == Decimal("600")
    assert compute_total_at(entries, on=date(2025, 12, 31)) == Decimal("0")


def test_build_series_sparse_with_prefix_point() -> None:
    entries = [
        E("a1", "Cash", "2026-01-15", "100"),
        E("a1", "Cash", "2026-02-15", "150"),
    ]
    series = build_series(entries, range_from=date(2026, 2, 1), range_to=date(2026, 3, 1))
    # Prefix point at 2026-02-01 carrying forward NW = 100, then 2026-02-15 → 150.
    # No pension here, so liquid == total at every point.
    assert series == [
        {"date": date(2026, 2, 1), "total_dkk": Decimal("100"), "liquid_dkk": Decimal("100")},
        {"date": date(2026, 2, 15), "total_dkk": Decimal("150"), "liquid_dkk": Decimal("150")},
    ]


def test_build_series_empty_when_no_history() -> None:
    series = build_series([], range_from=date(2026, 1, 1), range_to=date(2026, 3, 1))
    assert series == []


def test_build_series_entry_exactly_at_range_from() -> None:
    """Boundary: an entry whose date == range_from is included via the prefix
    point (compute_total_at uses <=) but is NOT in the change-dates set
    (build_series uses strict > range_from)."""
    entries = [E("a1", "Cash", "2026-01-10", "100")]
    series = build_series(entries, range_from=date(2026, 1, 10), range_to=date(2026, 2, 10))
    assert series == [
        {"date": date(2026, 1, 10), "total_dkk": Decimal("100"), "liquid_dkk": Decimal("100")},
    ]


def test_build_series_carries_liquid_per_point() -> None:
    """A pension entry mid-range should make its liquid value 40% of total at
    that point AND going forward."""
    entries = [
        E("a1", "Cash", "2026-01-01", "100000"),
        E("a2", "Pension", "2026-02-01", "100000"),
    ]
    series = build_series(entries, range_from=date(2026, 1, 1), range_to=date(2026, 3, 1))
    assert series == [
        {"date": date(2026, 1, 1), "total_dkk": Decimal("100000"), "liquid_dkk": Decimal("100000")},
        # 2026-02-01: cash 100k + pension 100k = 200k total; liquid = 200k - 60k = 140k.
        {"date": date(2026, 2, 1), "total_dkk": Decimal("200000"), "liquid_dkk": Decimal("140000")},
    ]


def test_build_deltas_basic() -> None:
    today = date(2026, 5, 1)
    entries = [
        E("a1", "Cash", "2025-05-01", "100"),
        E("a1", "Cash", "2026-04-01", "150"),
    ]
    deltas = build_deltas(entries, today=today)
    by_period = {d["period"]: d for d in deltas}
    # 1M anchor = today - 30d = 2026-04-01 → NW = 150. Today NW = 150 → delta = 0.
    assert by_period["1M"]["delta_dkk"] == Decimal("0")
    assert by_period["1M"]["delta_liquid_dkk"] == Decimal("0")
    assert by_period["1M"]["is_since_start"] is False
    # 1Y anchor = today - 365d = 2025-05-01 → NW = 100. Today = 150 → delta = 50.
    assert by_period["1Y"]["delta_dkk"] == Decimal("50")
    assert by_period["1Y"]["delta_liquid_dkk"] == Decimal("50")
    assert by_period["1Y"]["is_since_start"] is False
    # ALL → anchor = earliest entry = 2025-05-01 → NW = 100. delta = 50, since_start = True.
    assert by_period["ALL"]["delta_dkk"] == Decimal("50")
    assert by_period["ALL"]["delta_liquid_dkk"] == Decimal("50")
    assert by_period["ALL"]["is_since_start"] is True


def test_build_deltas_liquid_diverges_with_pension() -> None:
    """100k cash → today add 100k pension. ALL total-delta = +100k; liquid
    delta = +40k (pension haircut applied to today, not to anchor)."""
    today = date(2026, 5, 1)
    entries = [
        E("a1", "Cash", "2025-05-01", "100000"),
        E("a2", "Pension", "2026-05-01", "100000"),
    ]
    deltas = build_deltas(entries, today=today)
    by_period = {d["period"]: d for d in deltas}
    assert by_period["ALL"]["delta_dkk"] == Decimal("100000")
    assert by_period["ALL"]["delta_liquid_dkk"] == Decimal("40000")


def test_build_deltas_range_exceeds_history() -> None:
    """1Y goes back further than any data — anchor clips to earliest_known, is_since_start True."""
    today = date(2026, 5, 1)
    entries = [
        E("a1", "Cash", "2026-04-15", "100"),
    ]
    deltas = build_deltas(entries, today=today)
    by_period = {d["period"]: d for d in deltas}
    assert by_period["1Y"]["is_since_start"] is True
    assert by_period["1Y"]["anchor_date"] == date(2026, 4, 15)
    assert by_period["1Y"]["delta_dkk"] == Decimal("0")  # NW(earliest) = 100 = today


def test_build_deltas_no_history_all_zeros() -> None:
    today = date(2026, 5, 1)
    deltas = build_deltas([], today=today)
    for d in deltas:
        assert d["delta_dkk"] == Decimal("0")
        assert d["delta_liquid_dkk"] == Decimal("0")
        assert d["is_since_start"] is False
        assert d["anchor_date"] == today


def test_build_composition_groups_by_class() -> None:
    entries = [
        E("a1", "Cash", "2026-01-01", "100"),
        E("a2", "Cash", "2026-01-01", "50"),
        E("a3", "Stocks", "2026-01-01", "350"),
    ]
    comp = build_composition(entries, on=date(2026, 2, 1))
    by_class = {c["asset_class"]: c for c in comp}
    assert by_class["Cash"]["value_dkk"] == Decimal("150")
    assert by_class["Stocks"]["value_dkk"] == Decimal("350")
    # Pcts sum to 1.0 within tolerance.
    assert abs(sum(c["pct"] for c in comp) - 1.0) < 1e-6


def test_build_composition_hides_empty_classes() -> None:
    """An account with no entries on or before the date contributes 0 → its class is hidden."""
    entries = [
        E("a1", "Cash", "2026-02-01", "100"),  # no entry by 2026-01-15
    ]
    comp = build_composition(entries, on=date(2026, 1, 15))
    assert comp == []


def test_compute_liquid_no_pension_equals_total() -> None:
    """No pension holdings → liquid == total."""
    entries = [
        E("a1", "Cash", "2026-01-01", "100000"),
        E("a2", "Stocks", "2026-01-01", "50000"),
    ]
    total, liquid = compute_liquid_net_worth(entries, on=date(2026, 2, 1))
    assert total == Decimal("150000")
    assert liquid == Decimal("150000")


def test_compute_liquid_applies_60pct_pension_haircut() -> None:
    """100k pension early-withdrawn ≈ 40k after the DK haircut, so a portfolio
    of 100k cash + 100k pension reports total=200k, liquid=140k."""
    entries = [
        E("a1", "Cash", "2026-01-01", "100000"),
        E("a2", "Pension", "2026-01-01", "100000"),
    ]
    total, liquid = compute_liquid_net_worth(entries, on=date(2026, 2, 1))
    assert total == Decimal("200000")
    assert liquid == Decimal("140000")


def test_compute_liquid_multiple_pension_accounts() -> None:
    """Haircut applies to the sum of all Pension accounts, not just one."""
    entries = [
        E("a1", "Pension", "2026-01-01", "60000"),
        E("a2", "Pension", "2026-01-01", "40000"),
        E("a3", "Cash", "2026-01-01", "50000"),
    ]
    total, liquid = compute_liquid_net_worth(entries, on=date(2026, 2, 1))
    assert total == Decimal("150000")
    # Pension subtotal = 100000; haircut = 60000; liquid = 150000 - 60000 = 90000.
    assert liquid == Decimal("90000")


def test_compute_liquid_only_pension() -> None:
    """All-pension portfolio: liquid is 40% of total."""
    entries = [E("a1", "Pension", "2026-01-01", "100000")]
    total, liquid = compute_liquid_net_worth(entries, on=date(2026, 2, 1))
    assert total == Decimal("100000")
    assert liquid == Decimal("40000")


def test_compute_liquid_no_entries() -> None:
    total, liquid = compute_liquid_net_worth([], on=date(2026, 2, 1))
    assert total == Decimal("0")
    assert liquid == Decimal("0")
