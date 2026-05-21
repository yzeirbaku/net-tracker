"""Tests for /budget/months/{y}/{m}/items/* — item creation, the PATCH
verb matrix, deletion, and the ad-hoc category auto-create on POST.

Covers:
- POST item adds to an existing month category
- POST item auto-creates the month_category row when missing
- POST item with already_paid records remaining=0 + ticked
- PATCH tick zeroes remaining, untick restores to planned
- PATCH ticked:false + explicit remaining=0 round-trips honestly
- PATCH partial-pay to 0 auto-ticks
- PATCH partial-pay to non-zero leaves untouched
- PATCH name + planned change
- DELETE item works only within own month
"""

from __future__ import annotations

from httpx import AsyncClient

from tests.api._budget_helpers import (
    auth_headers,
    create_category,
    seed_template_with_one_category,
    stamp_current_month,
)

# ── POST /items ──────────────────────────────────────────────────────────


async def test_post_item_adds_to_existing_month_category(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    cat = seed["category"]
    year, month, _ = await stamp_current_month(client, token)
    r = await client.post(
        f"/budget/months/{year}/{month}/items",
        json={"category_id": cat["id"], "name": "Surprise", "planned_dkk": 50},
        headers=auth_headers(token),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Surprise"
    assert body["planned_dkk"] == "50.00"
    assert body["remaining_dkk"] == "50.00"
    assert body["ticked_at"] is None


async def test_post_item_auto_creates_month_category(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """User adds an item under a category that wasn't in the stamped month
    yet — endpoint should auto-create the month_category row."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    # Create a NEW category that's not in the month.
    fresh = await create_category(client, token, "Hobbies", "#a855f7")
    r = await client.post(
        f"/budget/months/{year}/{month}/items",
        json={"category_id": fresh["id"], "name": "Climbing", "planned_dkk": 200},
        headers=auth_headers(token),
    )
    assert r.status_code == 201
    # GET the month — should now have a second category with one item.
    detail = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    cats = detail.json()["categories"]
    assert len(cats) == 2
    fresh_cat = next(c for c in cats if c["category_id"] == fresh["id"])
    assert [i["name"] for i in fresh_cat["items"]] == ["Climbing"]


async def test_post_item_already_paid_records_done_state(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    cat = seed["category"]
    year, month, _ = await stamp_current_month(client, token)
    r = await client.post(
        f"/budget/months/{year}/{month}/items",
        json={
            "category_id": cat["id"],
            "name": "Dinner out",
            "planned_dkk": 350,
            "already_paid": True,
        },
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_post_item_already_paid_with_zero_planned(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Edge case: an `already_paid` row with `planned_dkk = 0` (e.g., a
    "Lent 0 to Alice" placeholder). remaining must stay at 0 and the row
    must be ticked — same outcome as the non-zero case."""
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    cat = seed["category"]
    year, month, _ = await stamp_current_month(client, token)
    r = await client.post(
        f"/budget/months/{year}/{month}/items",
        json={
            "category_id": cat["id"],
            "name": "Free swag",
            "planned_dkk": 0,
            "already_paid": True,
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["planned_dkk"] == "0.00"
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_post_item_rejects_unowned_category(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    # category_id that doesn't belong to us
    r = await client.post(
        f"/budget/months/{year}/{month}/items",
        json={
            "category_id": "00000000-0000-0000-0000-000000000000",
            "name": "x",
            "planned_dkk": 1,
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "category_not_found"
    # Suppress unused var
    _ = seed


# ── PATCH item matrix ───────────────────────────────────────────────────


async def _get_rent_id(client: AsyncClient, token: str, year: int, month: int) -> str:
    detail = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    return detail.json()["categories"][0]["items"][0]["id"]


async def test_patch_tick_zeroes_remaining(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_patch_tick_with_explicit_remaining_keeps_user_value(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Partial-pay-and-tick combo: user paid half, ticking marks done with
    the rest as "saved." Backend keeps the explicit remaining."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True, "remaining_dkk": 200},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["remaining_dkk"] == "200.00"
    assert body["ticked_at"] is not None


async def test_patch_untick_restores_remaining_to_planned(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    # Tick first.
    await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True},
        headers=auth_headers(token),
    )
    # Untick — remaining should be restored.
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["remaining_dkk"] == "8000.00"  # back to planned
    assert body["ticked_at"] is None


async def test_patch_untick_with_explicit_remaining_keeps_user_value(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False, "remaining_dkk": 50},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["remaining_dkk"] == "50.00"
    assert body["ticked_at"] is None


async def test_patch_untick_on_open_row_does_not_overwrite_partial_pay(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Defensive: if `{ticked: false}` lands on a row that's already open
    (a no-op untick), the backend must NOT restore remaining to planned —
    that would silently clobber any partial-pay value the user set while
    the row was open. The restore-on-untick branch only fires when the
    row was actually ticked."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    # Partial-pay the row from 8000 → 3000 (still open).
    await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"remaining_dkk": 3000},
        headers=auth_headers(token),
    )
    # Send {ticked: false} on the already-open row — should be a no-op.
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    # remaining must STAY at 3000 — not be silently restored to 8000.
    assert body["remaining_dkk"] == "3000.00"
    assert body["ticked_at"] is None


async def test_patch_explicit_untick_wins_over_auto_tick(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Sending {ticked:false, remaining_dkk:0} should NOT auto-tick. The
    explicit untick verb beats the predicate."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False, "remaining_dkk": 0},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is None


async def test_patch_remaining_to_zero_auto_ticks(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"remaining_dkk": 0},
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_patch_remaining_partial_leaves_open(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"remaining_dkk": 4000},
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["remaining_dkk"] == "4000.00"
    assert body["ticked_at"] is None


async def test_patch_tick_with_explicit_zero_remaining(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """`{ticked: true, remaining_dkk: 0}` — explicit zero from the user.
    Both signals point the same direction; the row should be done with
    remaining = 0."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True, "remaining_dkk": 0},
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_patch_whitespace_name_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Name validator should treat whitespace-only as empty → 422."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"name": "   "},
        headers=auth_headers(token),
    )
    assert r.status_code == 422


async def test_patch_rename_on_zero_remaining_stays_done(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """If a row was previously ticked (remaining 0, ticked_at set), a
    rename-only PATCH must leave the done state alone — no surprise
    untick from the auto-tick-on-remaining≤0 path interacting with the
    "no explicit ticked verb" branch."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    # Tick first → remaining 0, ticked.
    await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": True},
        headers=auth_headers(token),
    )
    # Rename only.
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"name": "Mortgage"},
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["name"] == "Mortgage"
    assert body["remaining_dkk"] == "0.00"
    assert body["ticked_at"] is not None


async def test_patch_name_and_planned(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"name": "Mortgage", "planned_dkk": 9000},
        headers=auth_headers(token),
    )
    body = r.json()
    assert body["name"] == "Mortgage"
    assert body["planned_dkk"] == "9000.00"


async def test_patch_negative_remaining_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"remaining_dkk": -1},
        headers=auth_headers(token),
    )
    assert r.status_code == 422


async def test_patch_item_404_when_wrong_month(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """An item ID that belongs to month A can't be PATCHed via month B's URL."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    # Try to PATCH via a non-stamped month.
    r = await client.patch(
        "/budget/months/2099/6/items/" + item_id,
        json={"ticked": True},
        headers=auth_headers(token),
    )
    assert r.status_code == 404


# ── DELETE item ─────────────────────────────────────────────────────────


async def test_delete_item(client: AsyncClient, authed_user: dict[str, str]) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    item_id = await _get_rent_id(client, token, year, month)
    r = await client.delete(
        f"/budget/months/{year}/{month}/items/{item_id}",
        headers=auth_headers(token),
    )
    assert r.status_code == 204
    detail = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    remaining = detail.json()["categories"][0]["items"]
    assert all(i["id"] != item_id for i in remaining)


async def test_delete_item_404_unknown(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    r = await client.delete(
        f"/budget/months/{year}/{month}/items/00000000-0000-0000-0000-000000000000",
        headers=auth_headers(token),
    )
    assert r.status_code == 404
