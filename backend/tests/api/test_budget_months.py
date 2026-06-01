"""Tests for the month-level endpoints under /budget/months.

Covers:
- stamp happy path + deep-copy invariant (independent from template)
- stamp error paths (empty draft, already stamped, past month)
- GET /budget/months summary math
- archive guard + idempotency
- archived months reject all mutations (table-driven)
- unarchive restores writability
- salary patch on a month
- past-month rule via the calendar
"""

from __future__ import annotations

from httpx import AsyncClient

from tests.api._budget_helpers import (
    auth_headers,
    create_category,
    current_year_month,
    far_future_month,
    far_past_month,
    next_calendar_month,
    patch_template,
    seed_template_with_one_category,
    stamp_current_month,
)

# ── Stamp lifecycle ──────────────────────────────────────────────────────


async def test_stamp_deep_copies_template_into_month(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    year, month, body = await stamp_current_month(client, token)

    assert body["year"] == year
    assert body["month"] == month
    assert body["archived_at"] is None
    assert body["salary_dkk"] == "30000.00"
    assert len(body["categories"]) == 1
    items = body["categories"][0]["items"]
    assert [i["name"] for i in items] == ["Rent", "Internet"]
    # remaining starts equal to planned, ticked_at NULL.
    for it in items:
        assert it["remaining_dkk"] == it["planned_dkk"]
        assert it["ticked_at"] is None

    # The month carries DIFFERENT IDs than the template's items — proves
    # it's a deep copy, not a pointer.
    tpl_item_ids = {
        i["id"] for i in seed["template"]["categories"][0]["items"]
    }
    month_item_ids = {i["id"] for i in items}
    assert tpl_item_ids.isdisjoint(month_item_ids)


async def test_template_edits_do_not_bleed_into_stamped_month(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    cat = (await seed_template_with_one_category(client, token))["category"]
    year, month, _ = await stamp_current_month(client, token)

    # Mutate the template after stamping — items renamed, planned amounts
    # changed, salary bumped.
    await patch_template(
        client,
        token,
        salary=99999,
        categories=[
            {
                "category_id": cat["id"],
                "sort_order": 0,
                "items": [{"name": "RENAMED", "planned_dkk": 1, "sort_order": 0}],
            }
        ],
    )

    refreshed = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    body = refreshed.json()
    assert body["salary_dkk"] == "30000.00"  # frozen from stamp time
    item_names = [i["name"] for i in body["categories"][0]["items"]]
    assert item_names == ["Rent", "Internet"]  # template change didn't bleed


async def test_stamp_empty_draft_returns_template_empty(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    year, month = current_year_month()
    r = await client.post(
        f"/budget/months/{year}/{month}/stamp",
        headers=auth_headers(authed_user["token"]),
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "template_empty"


async def test_stamp_already_stamped_returns_409(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    second = await client.post(
        f"/budget/months/{year}/{month}/stamp", headers=auth_headers(token)
    )
    assert second.status_code == 409
    assert second.json()["detail"] == "month_already_stamped"


async def test_stamp_past_month_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month = far_past_month()
    r = await client.post(
        f"/budget/months/{year}/{month}/stamp", headers=auth_headers(token)
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "cannot_stamp_past_month"


async def test_stamp_future_month_allowed(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month = far_future_month()
    r = await client.post(
        f"/budget/months/{year}/{month}/stamp", headers=auth_headers(token)
    )
    assert r.status_code == 201


async def test_stamp_next_month_allowed(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Next calendar month is the boundary case for the past-month guard."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month = next_calendar_month()
    r = await client.post(
        f"/budget/months/{year}/{month}/stamp", headers=auth_headers(token)
    )
    assert r.status_code == 201


async def test_invalid_year_or_month_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    # Month 13.
    r = await client.get(
        "/budget/months/2099/13", headers=auth_headers(token)
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_month"
    # Year before 1900.
    r2 = await client.get(
        "/budget/months/1700/5", headers=auth_headers(token)
    )
    assert r2.status_code == 400
    assert r2.json()["detail"] == "invalid_year"


async def test_get_month_404_when_not_stamped(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    year, month = current_year_month()
    r = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(authed_user["token"])
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "month_not_stamped"


# ── Month list summary ──────────────────────────────────────────────────


async def test_months_summary_math(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Stamp a month, tick one item, partial-pay another. Verify the
    summary's planned_total / spent_total / items_open / items_total."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    items = stamped["categories"][0]["items"]
    rent_id, internet_id = items[0]["id"], items[1]["id"]

    # Tick Rent → remaining drops to 0, ticked.
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{rent_id}",
        json={"ticked": True},
        headers=auth_headers(token),
    )
    assert r.status_code == 200

    # Partial-pay Internet from 299 → 100 remaining.
    r = await client.patch(
        f"/budget/months/{year}/{month}/items/{internet_id}",
        json={"remaining_dkk": 100},
        headers=auth_headers(token),
    )
    assert r.status_code == 200

    listing = await client.get("/budget/months", headers=auth_headers(token))
    rows = listing.json()
    assert len(rows) == 1
    row = rows[0]
    assert row["planned_total_dkk"] == "8299.00"
    # spent = (8000-0) + (299-100) = 8199
    assert row["spent_total_dkk"] == "8199.00"
    assert row["items_open"] == 1  # only internet, still has remaining > 0
    assert row["items_total"] == 2


async def test_months_list_orders_newest_first(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    cur_y, cur_m = current_year_month()
    fut_y, fut_m = far_future_month()
    await client.post(
        f"/budget/months/{cur_y}/{cur_m}/stamp", headers=auth_headers(token)
    )
    await client.post(
        f"/budget/months/{fut_y}/{fut_m}/stamp", headers=auth_headers(token)
    )
    listing = await client.get("/budget/months", headers=auth_headers(token))
    rows = listing.json()
    # Future first, current second.
    assert rows[0]["year"] == fut_y and rows[0]["month"] == fut_m
    assert rows[1]["year"] == cur_y and rows[1]["month"] == cur_m


# ── Salary on the month ─────────────────────────────────────────────────


async def test_patch_month_salary(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    r = await client.patch(
        f"/budget/months/{year}/{month}",
        json={"salary_dkk": 40000},
        headers=auth_headers(token),
    )
    assert r.status_code == 200
    assert r.json()["salary_dkk"] == "40000.00"


async def test_patch_month_salary_rejects_negative(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    r = await client.patch(
        f"/budget/months/{year}/{month}",
        json={"salary_dkk": -1},
        headers=auth_headers(token),
    )
    assert r.status_code == 422


# ── Extra income on the month ───────────────────────────────────────────


async def test_put_extra_income_sets_and_get_reflects(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    # Fresh stamp: defaults are name=NULL, amount=0.
    assert stamped["extra_income_name"] is None
    assert stamped["extra_income_dkk"] == "0.00"

    r = await client.put(
        f"/budget/months/{year}/{month}/extra-income",
        json={"name": "Bonus", "amount_dkk": 2500},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["extra_income_name"] == "Bonus"
    assert body["extra_income_dkk"] == "2500.00"

    # GET reflects the set fields.
    r = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    assert r.json()["extra_income_name"] == "Bonus"
    assert r.json()["extra_income_dkk"] == "2500.00"


async def test_put_extra_income_overwrites(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    H = auth_headers(token)
    url = f"/budget/months/{year}/{month}/extra-income"

    await client.put(url, json={"name": "Bonus", "amount_dkk": 1000}, headers=H)
    r = await client.put(
        url, json={"name": "Tax refund", "amount_dkk": 700}, headers=H
    )
    assert r.status_code == 200
    assert r.json()["extra_income_name"] == "Tax refund"
    assert r.json()["extra_income_dkk"] == "700.00"


async def test_delete_extra_income_clears(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    H = auth_headers(token)
    url = f"/budget/months/{year}/{month}/extra-income"

    await client.put(url, json={"name": "Bonus", "amount_dkk": 1500}, headers=H)
    r = await client.delete(url, headers=H)
    assert r.status_code == 200
    assert r.json()["extra_income_name"] is None
    assert r.json()["extra_income_dkk"] == "0.00"

    # DELETE is idempotent: a second call on an already-cleared month succeeds.
    r2 = await client.delete(url, headers=H)
    assert r2.status_code == 200
    assert r2.json()["extra_income_name"] is None


async def test_extra_income_validators(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    H = auth_headers(token)
    url = f"/budget/months/{year}/{month}/extra-income"

    # Empty name → 422.
    r = await client.put(url, json={"name": "", "amount_dkk": 100}, headers=H)
    assert r.status_code == 422

    # Negative amount → 422.
    r = await client.put(
        url, json={"name": "Bonus", "amount_dkk": -1}, headers=H
    )
    assert r.status_code == 422


async def test_extra_income_blocked_on_archived_month(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    H = auth_headers(token)
    # Tick every item, then archive.
    for it in stamped["categories"][0]["items"]:
        await client.patch(
            f"/budget/months/{year}/{month}/items/{it['id']}",
            json={"ticked": True},
            headers=H,
        )
    await client.post(f"/budget/months/{year}/{month}/archive", headers=H)
    # Suppress unused-import warning on seed (kept for parity with sibling tests).
    _ = seed

    url = f"/budget/months/{year}/{month}/extra-income"
    r = await client.put(
        url, json={"name": "Bonus", "amount_dkk": 1000}, headers=H
    )
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"
    r = await client.delete(url, headers=H)
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"


# ── Archive guard + idempotency ─────────────────────────────────────────


async def test_archive_blocked_when_items_open(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, _ = await stamp_current_month(client, token)
    r = await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )
    assert r.status_code == 409
    assert r.json()["detail"] == "not_fully_ticked"


async def test_archive_succeeds_when_all_done(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    for it in stamped["categories"][0]["items"]:
        await client.patch(
            f"/budget/months/{year}/{month}/items/{it['id']}",
            json={"ticked": True},
            headers=auth_headers(token),
        )
    r = await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )
    assert r.status_code == 200
    assert r.json()["archived_at"] is not None


async def test_archive_is_idempotent(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Calling archive on a month that's already archived must return 200
    with the same archived_at — not 409 and not re-stamp."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    for it in stamped["categories"][0]["items"]:
        await client.patch(
            f"/budget/months/{year}/{month}/items/{it['id']}",
            json={"ticked": True},
            headers=auth_headers(token),
        )
    first = await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )
    first_archived_at = first.json()["archived_at"]
    second = await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )
    assert second.status_code == 200
    assert second.json()["archived_at"] == first_archived_at


async def test_unarchive_restores_writability(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    item_id = stamped["categories"][0]["items"][0]["id"]
    # Tick everything → archive.
    for it in stamped["categories"][0]["items"]:
        await client.patch(
            f"/budget/months/{year}/{month}/items/{it['id']}",
            json={"ticked": True},
            headers=auth_headers(token),
        )
    await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )

    # PATCH while archived → 409.
    blocked = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False},
        headers=auth_headers(token),
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"] == "month_archived"

    # Unarchive.
    unar = await client.post(
        f"/budget/months/{year}/{month}/unarchive", headers=auth_headers(token)
    )
    assert unar.status_code == 200
    assert unar.json()["archived_at"] is None

    # PATCH now succeeds.
    ok = await client.patch(
        f"/budget/months/{year}/{month}/items/{item_id}",
        json={"ticked": False},
        headers=auth_headers(token),
    )
    assert ok.status_code == 200


async def test_delete_month_category_cascades_to_items(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Removing a category from a stamped month must also delete every
    item the user had inside it — driven by ON DELETE CASCADE on the FK
    from budget_month_items to budget_month_categories."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    year, month, stamped = await stamp_current_month(client, token)
    mcat_id = stamped["categories"][0]["id"]
    # Confirm the category has its 2 stamped items.
    assert len(stamped["categories"][0]["items"]) == 2

    r = await client.delete(
        f"/budget/months/{year}/{month}/categories/{mcat_id}",
        headers=auth_headers(token),
    )
    assert r.status_code == 204

    # Re-fetch the month — the category is gone AND no orphan items remain.
    detail = await client.get(
        f"/budget/months/{year}/{month}", headers=auth_headers(token)
    )
    cats = detail.json()["categories"]
    assert cats == []

    # Belt + braces: query the DB directly for orphaned items pointing at
    # the deleted category.
    from app import db
    pool = db.pool()
    async with pool.acquire() as conn:
        orphans = await conn.fetchval(
            "SELECT COUNT(*) FROM budget_month_items "
            "WHERE month_category_id = $1",
            mcat_id,
        )
    assert orphans == 0


async def test_archived_month_rejects_all_mutations(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Every mutating endpoint under /budget/months/{y}/{m}/ should 409
    when the month is archived."""
    token = authed_user["token"]
    seed = await seed_template_with_one_category(client, token)
    cat = seed["category"]
    year, month, stamped = await stamp_current_month(client, token)
    mcat_id = stamped["categories"][0]["id"]
    item_id = stamped["categories"][0]["items"][0]["id"]
    # Tick everything → archive.
    for it in stamped["categories"][0]["items"]:
        await client.patch(
            f"/budget/months/{year}/{month}/items/{it['id']}",
            json={"ticked": True},
            headers=auth_headers(token),
        )
    await client.post(
        f"/budget/months/{year}/{month}/archive", headers=auth_headers(token)
    )

    base = f"/budget/months/{year}/{month}"
    H = auth_headers(token)

    # PATCH salary.
    r = await client.patch(base, json={"salary_dkk": 50000}, headers=H)
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"

    # POST item (need a new category to avoid uniqueness issues — but the
    # archived guard fires before any of that, so even a bad category is OK).
    r = await client.post(
        base + "/items",
        json={"category_id": cat["id"], "name": "x", "planned_dkk": 1},
        headers=H,
    )
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"

    # PATCH item.
    r = await client.patch(
        base + f"/items/{item_id}", json={"ticked": False}, headers=H
    )
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"

    # DELETE item.
    r = await client.delete(base + f"/items/{item_id}", headers=H)
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"

    # POST category (use a fresh one).
    new_cat = await create_category(client, token, "Fresh")
    r = await client.post(
        base + "/categories",
        json={"category_id": new_cat["id"]},
        headers=H,
    )
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"

    # DELETE category.
    r = await client.delete(base + f"/categories/{mcat_id}", headers=H)
    assert r.status_code == 409 and r.json()["detail"] == "month_archived"
