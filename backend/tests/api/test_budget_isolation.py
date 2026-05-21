"""Cross-user isolation tests — Plan 3 is single-user, but the data is
keyed by user_id and every endpoint must scope by the session. Verifies
that user B can't read or write user A's templates, versions, months,
or items even when guessing valid UUIDs.
"""

from __future__ import annotations

from httpx import AsyncClient

from tests.api._budget_helpers import (
    auth_headers,
    create_another_user,
    create_category,
    seed_template_with_one_category,
    stamp_current_month,
)


async def test_user_b_cannot_see_user_a_template_versions(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    snap = await client.post(
        "/budget/template/versions",
        json={"label": "A's secret"},
        headers=auth_headers(a_token),
    )
    version_id = snap.json()["id"]

    b = await create_another_user()
    # B lists versions → empty (the list is scoped by user_id).
    listing = await client.get(
        "/budget/template/versions", headers=auth_headers(b["token"])
    )
    assert listing.json() == []
    # B tries to GET the version by id → 404.
    r = await client.get(
        f"/budget/template/versions/{version_id}",
        headers=auth_headers(b["token"]),
    )
    assert r.status_code == 404


async def test_user_b_cannot_delete_user_a_version(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    snap = await client.post(
        "/budget/template/versions", json={}, headers=auth_headers(a_token)
    )
    version_id = snap.json()["id"]

    b = await create_another_user()
    r = await client.delete(
        f"/budget/template/versions/{version_id}",
        headers=auth_headers(b["token"]),
    )
    assert r.status_code == 404
    # A's version still exists.
    a_check = await client.get(
        f"/budget/template/versions/{version_id}",
        headers=auth_headers(a_token),
    )
    assert a_check.status_code == 200


async def test_user_b_cannot_read_user_a_month(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    year, month, _ = await stamp_current_month(client, a_token)

    b = await create_another_user()
    # B's GET on this (year, month) → 404 (B has no stamped month).
    r = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(b["token"])
    )
    assert r.status_code == 404


async def test_user_b_cannot_patch_user_a_item(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    year, month, stamped = await stamp_current_month(client, a_token)
    item_id = stamped["categories"][0]["items"][0]["id"]

    b = await create_another_user()
    # B's PATCH for that month/item — month_not_stamped (B has no month).
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True},
        headers=auth_headers(b["token"]),
    )
    assert r.status_code == 404


async def test_user_b_cannot_delete_user_a_item(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    year, month, stamped = await stamp_current_month(client, a_token)
    item_id = stamped["categories"][0]["items"][0]["id"]

    b = await create_another_user()
    r = await client.delete(
        f"/budget/months/{year}/{month}/items/{item_id}",
        headers=auth_headers(b["token"]),
    )
    assert r.status_code == 404


async def test_users_independent_drafts(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    a_template = await seed_template_with_one_category(
        client, a_token, cat_name="A-Housing"
    )
    a_template_id = a_template["template"]["id"]

    b = await create_another_user()
    # B has no draft yet — GET will auto-create an empty one.
    b_draft = await client.get(
        "/budget/template", headers=auth_headers(b["token"])
    )
    assert b_draft.json()["id"] != a_template_id
    assert b_draft.json()["salary_dkk"] == "0.00"
    assert b_draft.json()["categories"] == []


async def test_two_users_can_share_a_color(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """The UNIQUE(user_id, color) partial index must NOT prevent two
    different users from both using the same hex."""
    a_token = authed_user["token"]
    await create_category(client, a_token, "A's Housing", "#22c55e")

    b = await create_another_user()
    r = await client.post(
        "/categories",
        json={"name": "B's Housing", "color": "#22c55e"},
        headers=auth_headers(b["token"]),
    )
    assert r.status_code == 201


async def test_users_independent_months_list(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a_token = authed_user["token"]
    await seed_template_with_one_category(client, a_token)
    await stamp_current_month(client, a_token)

    b = await create_another_user()
    listing = await client.get("/budget/months", headers=auth_headers(b["token"]))
    assert listing.json() == []
