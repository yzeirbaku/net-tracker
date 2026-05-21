"""Shared helpers for the budget test suite.

Every public function here keeps fixtures small and assertions tight — tests
should read as "do business X, expect business Y," not "build 30 lines of
setup, expect Y."
"""

from __future__ import annotations

import datetime
from typing import Any

from httpx import AsyncClient

from app import db


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_category(
    client: AsyncClient,
    token: str,
    name: str,
    color: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name}
    if color is not None:
        body["color"] = color
    r = await client.post("/categories", json=body, headers=auth_headers(token))
    assert r.status_code == 201, r.text
    return r.json()


async def create_another_user(email: str = "other@example.com") -> dict[str, str]:
    """Create a second user + session via the DB pool. Used for cross-user
    isolation tests so we don't reuse the autouse `authed_user` fixture."""
    pool = db.pool()
    async with pool.acquire() as conn:
        user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", email
        )
        sid = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", user_id
        )
    return {"user_id": str(user_id), "token": str(sid), "email": email}


async def patch_template(
    client: AsyncClient,
    token: str,
    salary: float,
    categories: list[dict[str, Any]],
) -> dict[str, Any]:
    """Bulk-set the draft template. `categories` is a list of dicts:
    `[{"category_id": uuid, "sort_order": 0, "items": [{"name", "planned_dkk", "sort_order"}]}]`."""
    r = await client.patch(
        "/budget/template",
        json={"salary_dkk": salary, "categories": categories},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()


async def seed_template_with_one_category(
    client: AsyncClient,
    token: str,
    *,
    salary: float = 30000,
    cat_name: str = "Housing",
    items: list[tuple[str, float]] | None = None,
) -> dict[str, Any]:
    """One-call helper: create a category, seed it with N items in the
    draft, return {category, template} for follow-up assertions."""
    if items is None:
        items = [("Rent", 8000), ("Internet", 299)]
    cat = await create_category(client, token, cat_name, color="#22c55e")
    template = await patch_template(
        client,
        token,
        salary=salary,
        categories=[
            {
                "category_id": cat["id"],
                "sort_order": 0,
                "items": [
                    {"name": n, "planned_dkk": p, "sort_order": i}
                    for i, (n, p) in enumerate(items)
                ],
            }
        ],
    )
    return {"category": cat, "template": template}


async def stamp_current_month(
    client: AsyncClient, token: str
) -> tuple[int, int, dict[str, Any]]:
    """Stamp the current calendar month. Returns (year, month, body)."""
    year, month = current_year_month()
    r = await client.post(
        f"/budget/months/{year}/{month}/stamp", headers=auth_headers(token)
    )
    assert r.status_code == 201, r.text
    return year, month, r.json()


def current_year_month() -> tuple[int, int]:
    today = datetime.date.today()
    return today.year, today.month


def next_calendar_month() -> tuple[int, int]:
    today = datetime.date.today()
    if today.month == 12:
        return today.year + 1, 1
    return today.year, today.month + 1


def far_future_month() -> tuple[int, int]:
    """A year+month definitely in the future and not equal to next_calendar_month."""
    today = datetime.date.today()
    return today.year + 5, 6


def far_past_month() -> tuple[int, int]:
    """A year+month definitely in the past (well before today)."""
    return 2000, 1
