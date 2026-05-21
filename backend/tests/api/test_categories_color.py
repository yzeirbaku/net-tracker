"""Color-uniqueness tests for categories.

The new partial unique index on `(user_id, color) WHERE color IS NOT NULL`
makes color a constraint, not just a hint. These tests pin the behavior:
duplicate hex → 409 color_taken; NULL doesn't conflict; per-user scoping.

(Cross-user sharing of the same color is covered in
test_budget_isolation.py::test_two_users_can_share_a_color.)
"""

from __future__ import annotations

from httpx import AsyncClient

from tests.api._budget_helpers import auth_headers, create_category


async def test_duplicate_color_on_create_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await create_category(client, token, "First", "#22c55e")
    r = await client.post(
        "/categories",
        json={"name": "Second", "color": "#22c55e"},
        headers=auth_headers(token),
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "color_taken"


async def test_duplicate_color_on_patch_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await create_category(client, token, "First", "#22c55e")
    second = await create_category(client, token, "Second", "#f59e0b")
    r = await client.patch(
        f"/categories/{second['id']}",
        json={"color": "#22c55e"},
        headers=auth_headers(token),
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "color_taken"


async def test_null_colors_do_not_conflict(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Two categories with NULL color must coexist — the unique index has
    a WHERE clause that excludes NULL rows."""
    token = authed_user["token"]
    r1 = await client.post(
        "/categories", json={"name": "A"}, headers=auth_headers(token)
    )
    assert r1.status_code == 201
    assert r1.json()["color"] is None
    r2 = await client.post(
        "/categories", json={"name": "B"}, headers=auth_headers(token)
    )
    assert r2.status_code == 201
    assert r2.json()["color"] is None


async def test_same_color_after_other_freed_succeeds(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """If a category that used #22c55e is deleted (or its color cleared),
    another category should be allowed to claim that color."""
    token = authed_user["token"]
    first = await create_category(client, token, "First", "#22c55e")
    # Free up the color by setting it to None via PATCH.
    r = await client.patch(
        f"/categories/{first['id']}",
        json={"color": None},
        headers=auth_headers(token),
    )
    # Note: the existing PATCH model treats `None` as "no change" (because
    # `color: str | None = None` is the default-unset signal). So we
    # achieve the same outcome by deleting + re-creating.
    if r.status_code == 200 and r.json()["color"] == "#22c55e":
        # PATCH didn't actually clear — delete instead.
        await client.delete(
            f"/categories/{first['id']}", headers=auth_headers(token)
        )
    # Now a new category claiming #22c55e should be fine.
    r2 = await client.post(
        "/categories",
        json={"name": "Second", "color": "#22c55e"},
        headers=auth_headers(token),
    )
    assert r2.status_code == 201
    assert r2.json()["color"] == "#22c55e"
