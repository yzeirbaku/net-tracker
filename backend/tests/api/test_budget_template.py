"""Tests for the template + version endpoints under /budget/template.

Covers:
- draft auto-creation on first GET
- PATCH validates ownership + dedupes
- PATCH is a true wipe-and-replace (no orphan rows)
- snapshot deep-copies independently of the draft
- snapshot listing + version GET + version DELETE
"""

from __future__ import annotations

from httpx import AsyncClient

from app import db
from tests.api._budget_helpers import (
    auth_headers,
    create_another_user,
    create_category,
    patch_template,
    seed_template_with_one_category,
)

# ── Draft lifecycle ──────────────────────────────────────────────────────


async def test_get_template_auto_creates_empty_draft(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.get("/budget/template", headers=auth_headers(authed_user["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "draft"
    assert body["label"] is None
    assert body["salary_dkk"] == "0.00"
    assert body["categories"] == []
    # Second read should return the SAME draft id (not create a new one).
    again = await client.get(
        "/budget/template", headers=auth_headers(authed_user["token"])
    )
    assert again.json()["id"] == body["id"]


async def test_patch_template_replaces_salary_and_categories(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    seed = await seed_template_with_one_category(client, authed_user["token"])
    assert seed["template"]["salary_dkk"] == "30000.00"
    assert len(seed["template"]["categories"]) == 1
    assert len(seed["template"]["categories"][0]["items"]) == 2
    names = [it["name"] for it in seed["template"]["categories"][0]["items"]]
    assert names == ["Rent", "Internet"]


async def test_patch_template_wipes_orphan_items(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Patching twice with shrinking sets must leave zero orphans in
    budget_template_items + budget_template_categories."""
    token = authed_user["token"]
    cat_a = await create_category(client, token, "A", "#22c55e")
    cat_b = await create_category(client, token, "B", "#f59e0b")

    # First patch: both categories + 3 items in A, 2 in B.
    await patch_template(
        client,
        token,
        salary=10000,
        categories=[
            {
                "category_id": cat_a["id"],
                "sort_order": 0,
                "items": [
                    {"name": f"A-{i}", "planned_dkk": 100, "sort_order": i}
                    for i in range(3)
                ],
            },
            {
                "category_id": cat_b["id"],
                "sort_order": 1,
                "items": [
                    {"name": f"B-{i}", "planned_dkk": 200, "sort_order": i}
                    for i in range(2)
                ],
            },
        ],
    )

    # Second patch: drop B entirely + only one item in A.
    await patch_template(
        client,
        token,
        salary=20000,
        categories=[
            {
                "category_id": cat_a["id"],
                "sort_order": 0,
                "items": [{"name": "A-only", "planned_dkk": 999, "sort_order": 0}],
            }
        ],
    )

    pool = db.pool()
    async with pool.acquire() as conn:
        tpl_cat_rows = await conn.fetch(
            "SELECT btc.id FROM budget_template_categories btc "
            "JOIN budget_templates t ON t.id = btc.template_id "
            "WHERE t.user_id = $1 AND t.status = 'draft'",
            authed_user["user_id"],
        )
        item_rows = await conn.fetch(
            "SELECT bti.id FROM budget_template_items bti "
            "JOIN budget_template_categories btc "
            "  ON btc.id = bti.template_category_id "
            "JOIN budget_templates t ON t.id = btc.template_id "
            "WHERE t.user_id = $1 AND t.status = 'draft'",
            authed_user["user_id"],
        )
    assert len(tpl_cat_rows) == 1, "Expected exactly one cat after second patch"
    assert len(item_rows) == 1, "Expected exactly one item after second patch"


async def test_patch_template_rejects_unowned_category(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    # Create a category as ANOTHER user; try to use its id in our patch.
    other = await create_another_user()
    other_cat = await create_category(client, other["token"], "Sneaky")
    r = await client.patch(
        "/budget/template",
        json={
            "salary_dkk": 1000,
            "categories": [
                {"category_id": other_cat["id"], "sort_order": 0, "items": []}
            ],
        },
        headers=auth_headers(authed_user["token"]),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "category_not_found"


async def test_patch_template_rejects_duplicate_category(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    cat = await create_category(client, token, "Dup")
    r = await client.patch(
        "/budget/template",
        json={
            "salary_dkk": 0,
            "categories": [
                {"category_id": cat["id"], "sort_order": 0, "items": []},
                {"category_id": cat["id"], "sort_order": 1, "items": []},
            ],
        },
        headers=auth_headers(token),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "duplicate_category_in_template"


async def test_patch_template_rejects_negative_salary(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.patch(
        "/budget/template",
        json={"salary_dkk": -1, "categories": []},
        headers=auth_headers(authed_user["token"]),
    )
    assert r.status_code == 422  # pydantic validator


# ── Versions ──────────────────────────────────────────────────────────────


async def test_snapshot_deep_copies_draft(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)

    # Snapshot with a label.
    snap = await client.post(
        "/budget/template/versions",
        json={"label": "Initial"},
        headers=auth_headers(token),
    )
    assert snap.status_code == 201
    snap_body = snap.json()
    assert snap_body["label"] == "Initial"
    assert snap_body["salary_dkk"] == "30000.00"
    assert snap_body["category_count"] == 1
    assert snap_body["item_count"] == 2

    # Mutate the draft after snapshotting — version must NOT change.
    await patch_template(
        client,
        token,
        salary=99999,
        categories=[],
    )

    versions = await client.get(
        "/budget/template/versions", headers=auth_headers(token)
    )
    assert versions.status_code == 200
    listing = versions.json()
    assert len(listing) == 1
    assert listing[0]["salary_dkk"] == "30000.00"
    assert listing[0]["item_count"] == 2

    # Detail of the snapshot still preserves the items + sort orders.
    detail = await client.get(
        f"/budget/template/versions/{snap_body['id']}",
        headers=auth_headers(token),
    )
    assert detail.status_code == 200
    detail_body = detail.json()
    assert detail_body["status"] == "version"
    assert detail_body["salary_dkk"] == "30000.00"
    items = detail_body["categories"][0]["items"]
    assert [i["name"] for i in items] == ["Rent", "Internet"]
    assert [i["sort_order"] for i in items] == [0, 1]


async def test_snapshot_with_empty_label_string_normalizes_to_none(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    r = await client.post(
        "/budget/template/versions",
        json={"label": "   "},  # whitespace-only
        headers=auth_headers(token),
    )
    assert r.status_code == 201
    assert r.json()["label"] is None


async def test_snapshot_label_too_long_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    r = await client.post(
        "/budget/template/versions",
        json={"label": "x" * 200},
        headers=auth_headers(token),
    )
    assert r.status_code == 422


async def test_delete_version(client: AsyncClient, authed_user: dict[str, str]) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    snap = await client.post(
        "/budget/template/versions",
        json={"label": "Bye"},
        headers=auth_headers(token),
    )
    vid = snap.json()["id"]
    r = await client.delete(
        f"/budget/template/versions/{vid}", headers=auth_headers(token)
    )
    assert r.status_code == 204
    # GET that version → 404
    g = await client.get(
        f"/budget/template/versions/{vid}", headers=auth_headers(token)
    )
    assert g.status_code == 404
    assert g.json()["detail"] == "template_version_not_found"


async def test_delete_version_404_when_missing(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.delete(
        "/budget/template/versions/00000000-0000-0000-0000-000000000000",
        headers=auth_headers(authed_user["token"]),
    )
    assert r.status_code == 404


async def test_versions_list_excludes_drafts(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """The draft template row has status='draft' and must not show up in
    the versions list even though it shares the budget_templates table."""
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    versions = await client.get(
        "/budget/template/versions", headers=auth_headers(token)
    )
    assert versions.json() == []  # no snapshots yet
    await client.post(
        "/budget/template/versions",
        json={"label": None},
        headers=auth_headers(token),
    )
    versions = await client.get(
        "/budget/template/versions", headers=auth_headers(token)
    )
    assert len(versions.json()) == 1
    assert versions.json()[0]["label"] is None  # untitled


async def test_versions_listed_newest_first(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    for label in ["v1", "v2", "v3"]:
        r = await client.post(
            "/budget/template/versions",
            json={"label": label},
            headers=auth_headers(token),
        )
        assert r.status_code == 201
    versions = await client.get(
        "/budget/template/versions", headers=auth_headers(token)
    )
    labels = [v["label"] for v in versions.json()]
    assert labels == ["v3", "v2", "v1"]


async def test_snapshot_does_not_mutate_draft_categories(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    token = authed_user["token"]
    await seed_template_with_one_category(client, token)
    before = await client.get("/budget/template", headers=auth_headers(token))
    await client.post(
        "/budget/template/versions",
        json={"label": "test"},
        headers=auth_headers(token),
    )
    after = await client.get("/budget/template", headers=auth_headers(token))
    # Draft must be byte-identical (modulo any timestamps) before vs after snapshot.
    before_cats = before.json()["categories"]
    after_cats = after.json()["categories"]
    assert len(before_cats) == len(after_cats) == 1
    assert before_cats[0]["category_id"] == after_cats[0]["category_id"]
    assert [i["name"] for i in before_cats[0]["items"]] == [
        i["name"] for i in after_cats[0]["items"]
    ]
