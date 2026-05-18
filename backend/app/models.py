"""Pydantic models for request/response payloads and shared enums."""

from __future__ import annotations

from datetime import datetime
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
    GOLD = "Gold"
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
