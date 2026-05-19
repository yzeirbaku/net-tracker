from datetime import UTC, datetime
from uuid import uuid4

import pytest

from app.models import (
    AccountCreate,
    AccountKind,
    AssetClass,
    CategoryCreate,
    CategoryOut,
)


def test_category_create_strips_name() -> None:
    c = CategoryCreate(name="  Groceries  ")
    assert c.name == "Groceries"


def test_category_create_rejects_empty() -> None:
    with pytest.raises(ValueError):
        CategoryCreate(name="   ")


def test_account_create_validates_kind() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="bogus", asset_class="Cash")  # type: ignore[arg-type]


def test_account_create_validates_asset_class() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="wealth", asset_class="Foo")  # type: ignore[arg-type]


def test_account_create_wealth_requires_asset_class() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="wealth")


def test_account_create_spending_rejects_asset_class() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="spending", asset_class="Cash")


def test_account_create_put_aside_rejects_asset_class() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="put_aside", asset_class="Cash")


def test_account_create_spending_omits_asset_class_ok() -> None:
    a = AccountCreate(name="X", kind="spending")
    assert a.asset_class is None


def test_account_create_put_aside_omits_asset_class_ok() -> None:
    a = AccountCreate(name="X", kind="put_aside")
    assert a.asset_class is None


def test_category_out_round_trip() -> None:
    payload = {
        "id": uuid4(),
        "name": "Groceries",
        "color": "#22c55e",
        "exclude_from_spend": False,
        "sort_order": 0,
        "created_at": datetime.now(UTC),
    }
    out = CategoryOut(**payload)
    assert out.name == "Groceries"


def test_account_kind_enum_values() -> None:
    assert {k.value for k in AccountKind} == {"spending", "put_aside", "wealth"}


def test_asset_class_enum_values() -> None:
    assert {a.value for a in AssetClass} == {
        "Cash",
        "Stocks",
        "Crypto",
        "Gold",
        "Pension",
        "Other",
    }


# ── Balance entry model tests ─────────────────────────────────────────────


from datetime import date
from decimal import Decimal

from pydantic import ValidationError

from app.models import BalanceEntryCreate


def test_balance_entry_create_basic() -> None:
    m = BalanceEntryCreate(entry_date=date(2026, 1, 1), value_dkk=Decimal("100.50"))
    assert m.entry_date == date(2026, 1, 1)
    assert m.value_dkk == Decimal("100.50")


def test_balance_entry_create_allows_negative() -> None:
    """Margin / loan accounts can sit underwater."""
    m = BalanceEntryCreate(entry_date=date(2026, 1, 1), value_dkk=Decimal("-50"))
    assert m.value_dkk == Decimal("-50")


def test_balance_entry_create_requires_value() -> None:
    with pytest.raises(ValidationError):
        BalanceEntryCreate(entry_date=date(2026, 1, 1))  # type: ignore[call-arg]


def test_balance_entry_create_requires_date() -> None:
    with pytest.raises(ValidationError):
        BalanceEntryCreate(value_dkk=Decimal("100"))  # type: ignore[call-arg]
