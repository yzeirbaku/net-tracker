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
        AccountCreate(name="X", kind="bogus", asset_class="Savings")  # type: ignore[arg-type]


def test_account_create_validates_asset_class() -> None:
    with pytest.raises(ValueError):
        AccountCreate(name="X", kind="spending", asset_class="Foo")  # type: ignore[arg-type]


def test_category_out_round_trip() -> None:
    payload = {
        "id": uuid4(),
        "name": "Groceries",
        "color": "#6ba47a",
        "exclude_from_spend": False,
        "sort_order": 0,
        "created_at": datetime.now(UTC),
    }
    out = CategoryOut(**payload)
    assert out.name == "Groceries"


def test_account_kind_enum_values() -> None:
    assert {k.value for k in AccountKind} == {"spending", "savings", "sinking_fund"}


def test_asset_class_enum_values() -> None:
    assert {a.value for a in AssetClass} == {
        "Savings",
        "Stocks",
        "Crypto",
        "Gold",
        "Pension",
        "Other",
    }
