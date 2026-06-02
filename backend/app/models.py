"""Pydantic models for request/response payloads and shared enums."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AccountKind(str, Enum):
    SPENDING = "spending"
    PUT_ASIDE = "put_aside"
    WEALTH = "wealth"


class AssetClass(str, Enum):
    CASH = "Cash"
    STOCKS = "Stocks"
    CRYPTO = "Crypto"
    PRECIOUS_METALS = "Precious Metals"
    PENSION = "Pension"
    OTHER = "Other"


def _strip_nonempty(v: str) -> str:
    stripped = v.strip()
    if not stripped:
        raise ValueError("must not be empty after stripping whitespace")
    return stripped


class CategoryCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    color: str | None = None
    exclude_from_spend: bool = False
    sort_order: int = 0

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)


class CategoryUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    exclude_from_spend: bool | None = None
    sort_order: int | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    color: str | None
    exclude_from_spend: bool
    sort_order: int
    created_at: datetime


class AccountCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=80)]
    kind: AccountKind
    asset_class: AssetClass | None = None
    sort_order: int = 0

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)

    @model_validator(mode="after")
    def _validate_asset_class_for_kind(self) -> AccountCreate:
        if self.kind == AccountKind.WEALTH and self.asset_class is None:
            raise ValueError("asset_class is required when kind is 'wealth'")
        if self.kind != AccountKind.WEALTH and self.asset_class is not None:
            raise ValueError("asset_class must be omitted when kind is not 'wealth'")
        return self


class AccountUpdate(BaseModel):
    name: str | None = None
    asset_class: AssetClass | None = None
    sort_order: int | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    kind: AccountKind
    asset_class: AssetClass | None
    sort_order: int
    created_at: datetime


class MagicLinkRequest(BaseModel):
    email: Annotated[str, Field(min_length=3, max_length=320)]

    @field_validator("email")
    @classmethod
    def _validate_email(cls, v: str) -> str:
        stripped = v.strip().lower()
        if "@" not in stripped or "." not in stripped.split("@", 1)[1]:
            raise ValueError("not a valid email")
        return stripped


class MagicLinkVerify(BaseModel):
    token: Annotated[str, Field(min_length=10, max_length=128)]


class SessionOut(BaseModel):
    user_id: UUID
    email: str
    token: UUID


class UserOut(BaseModel):
    user_id: UUID
    email: str


# ── Balance entries + net-worth payload ──────────────────────────────────


class BalanceEntryCreate(BaseModel):
    entry_date: date
    value_dkk: Decimal


class BalanceEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    account_id: UUID
    entry_date: date
    value_dkk: Decimal
    source: str
    created_at: datetime


class NetWorthSeriesPoint(BaseModel):
    date: date
    total_dkk: Decimal
    liquid_dkk: Decimal


class NetWorthDelta(BaseModel):
    period: str
    delta_dkk: Decimal
    delta_liquid_dkk: Decimal
    anchor_date: date
    is_since_start: bool


class NetWorthCompositionSlice(BaseModel):
    asset_class: str
    value_dkk: Decimal
    pct: float


class NetWorthAccountSparkPoint(BaseModel):
    date: date
    value_dkk: Decimal


class NetWorthAccountSummary(BaseModel):
    id: UUID
    name: str
    asset_class: str
    latest_value_dkk: Decimal | None
    latest_entry_date: date | None
    sparkline: list[NetWorthAccountSparkPoint]


class NetWorthOut(BaseModel):
    total_dkk: Decimal
    liquid_dkk: Decimal
    pension_total_dkk: Decimal
    pension_haircut_rate: float
    as_of: date
    series: list[NetWorthSeriesPoint]
    deltas: list[NetWorthDelta]
    composition: list[NetWorthCompositionSlice]
    accounts: list[NetWorthAccountSummary]


class AccountHistoryAccountInfo(BaseModel):
    id: UUID
    name: str
    kind: str
    asset_class: str | None


class AccountHistoryEntry(BaseModel):
    id: UUID
    entry_date: date
    value_dkk: Decimal
    source: str


class AccountHistoryOut(BaseModel):
    account: AccountHistoryAccountInfo
    entries: list[AccountHistoryEntry]


# ── Budget (Plan 3) ──────────────────────────────────────────────────────


class BudgetTemplateItemPatch(BaseModel):
    """One item inside a category, in a PATCH /budget/template payload."""

    name: Annotated[str, Field(min_length=1, max_length=200)]
    planned_dkk: Decimal
    sort_order: int = 0

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)

    @field_validator("planned_dkk")
    @classmethod
    def _non_negative_planned(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("planned_dkk must be >= 0")
        return v


class BudgetTemplateCategoryPatch(BaseModel):
    """One category in a PATCH /budget/template payload."""

    category_id: UUID
    sort_order: int = 0
    items: list[BudgetTemplateItemPatch] = Field(default_factory=list)


class BudgetTemplatePatch(BaseModel):
    """Bulk replace the draft (or a version, indirectly via version-snapshot
    of a patched draft)."""

    salary_dkk: Decimal = Decimal("0")
    categories: list[BudgetTemplateCategoryPatch] = Field(default_factory=list)

    @field_validator("salary_dkk")
    @classmethod
    def _non_negative_salary(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("salary_dkk must be >= 0")
        return v


class BudgetTemplateItemOut(BaseModel):
    id: UUID
    name: str
    planned_dkk: Decimal
    sort_order: int


class BudgetTemplateCategoryOut(BaseModel):
    id: UUID
    category_id: UUID
    category_name: str
    category_color: str | None
    sort_order: int
    items: list[BudgetTemplateItemOut]


class BudgetTemplateOut(BaseModel):
    id: UUID
    status: str
    label: str | None
    salary_dkk: Decimal
    created_at: datetime
    categories: list[BudgetTemplateCategoryOut]


_VERSION_LABEL_MAX_LEN = 120


class BudgetTemplateVersionCreate(BaseModel):
    label: str | None = None

    @field_validator("label")
    @classmethod
    def _trim_label(cls, v: str | None) -> str | None:
        if v is None:
            return None
        trimmed = v.strip()
        if not trimmed:
            return None
        if len(trimmed) > _VERSION_LABEL_MAX_LEN:
            raise ValueError(f"label must be <= {_VERSION_LABEL_MAX_LEN} chars")
        return trimmed


class BudgetTemplateVersionSummary(BaseModel):
    """Row in the version-history list."""

    id: UUID
    label: str | None
    created_at: datetime
    salary_dkk: Decimal
    category_count: int
    item_count: int


# ── Budget months ────────────────────────────────────────────────────────


class BudgetMonthItemOut(BaseModel):
    id: UUID
    name: str
    planned_dkk: Decimal
    remaining_dkk: Decimal
    ticked_at: datetime | None
    sort_order: int


class BudgetMonthCategoryOut(BaseModel):
    id: UUID
    category_id: UUID
    category_name: str
    category_color: str | None
    sort_order: int
    items: list[BudgetMonthItemOut]


class BudgetMonthOut(BaseModel):
    id: UUID
    year: int
    month: int
    salary_dkk: Decimal
    extra_income_name: str | None
    extra_income_dkk: Decimal
    archived_at: datetime | None
    created_at: datetime
    categories: list[BudgetMonthCategoryOut]


class BudgetMonthExtraIncomeSet(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    amount_dkk: Decimal

    @field_validator("amount_dkk")
    @classmethod
    def _non_negative_amount(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("amount_dkk must be >= 0")
        return v


class BudgetMonthSummary(BaseModel):
    year: int
    month: int
    stamped_at: datetime
    archived_at: datetime | None
    salary_dkk: Decimal
    planned_total_dkk: Decimal
    spent_total_dkk: Decimal
    saved_total_dkk: Decimal
    items_open: int
    items_total: int


class BudgetMonthSalaryPatch(BaseModel):
    salary_dkk: Decimal

    @field_validator("salary_dkk")
    @classmethod
    def _non_negative_salary(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("salary_dkk must be >= 0")
        return v


class BudgetMonthItemCreate(BaseModel):
    category_id: UUID
    name: Annotated[str, Field(min_length=1, max_length=200)]
    planned_dkk: Decimal
    already_paid: bool = False

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)

    @field_validator("planned_dkk")
    @classmethod
    def _non_negative_planned(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("planned_dkk must be >= 0")
        return v


class BudgetMonthItemPatch(BaseModel):
    """Workhorse PATCH. Each field is optional — apply whichever subset the
    client sent. `ticked` is the explicit-tick verb (true = tick now,
    false = untick); `remaining_dkk` is the partial-payment verb. Both can be
    sent in the same request."""

    name: str | None = None
    planned_dkk: Decimal | None = None
    remaining_dkk: Decimal | None = None
    ticked: bool | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)

    @field_validator("planned_dkk")
    @classmethod
    def _non_negative_planned(cls, v: Decimal | None) -> Decimal | None:
        if v is None:
            return None
        if v < 0:
            raise ValueError("planned_dkk must be >= 0")
        return v

    @field_validator("remaining_dkk")
    @classmethod
    def _non_negative_remaining(cls, v: Decimal | None) -> Decimal | None:
        if v is None:
            return None
        if v < 0:
            raise ValueError("remaining_dkk must be >= 0")
        return v


class BudgetMonthCategoryAdd(BaseModel):
    category_id: UUID


# ── Put-aside (flat list of named amounts) ───────────────────────────────


class PutAsideItemCreate(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=200)]
    amount_dkk: Decimal

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str) -> str:
        return _strip_nonempty(v)

    @field_validator("amount_dkk")
    @classmethod
    def _non_negative_amount(cls, v: Decimal) -> Decimal:
        if v < 0:
            raise ValueError("amount_dkk must be >= 0")
        return v


class PutAsideItemUpdate(BaseModel):
    name: str | None = None
    amount_dkk: Decimal | None = None

    @field_validator("name")
    @classmethod
    def _validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return None
        return _strip_nonempty(v)

    @field_validator("amount_dkk")
    @classmethod
    def _non_negative_amount(cls, v: Decimal | None) -> Decimal | None:
        if v is None:
            return None
        if v < 0:
            raise ValueError("amount_dkk must be >= 0")
        return v


class PutAsideItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    amount_dkk: Decimal
    created_at: datetime
    updated_at: datetime


class PutAsideOut(BaseModel):
    total_dkk: Decimal
    items: list[PutAsideItemOut]
