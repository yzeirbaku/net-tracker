from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_categories_list_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/categories", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/categories",
        json={"name": "Groceries", "color": "#6ba47a"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Groceries"
    assert body["color"] == "#6ba47a"
    assert body["exclude_from_spend"] is False


async def test_create_category_strips_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/categories",
        json={"name": "  Coffee  "},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["name"] == "Coffee"


async def test_create_category_unique_per_user(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    r1 = await client.post("/categories", json={"name": "Rent"}, headers=headers)
    assert r1.status_code == 201
    r2 = await client.post("/categories", json={"name": "Rent"}, headers=headers)
    assert r2.status_code == 409


async def test_patch_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post("/categories", json={"name": "Old"}, headers=headers)
    cat_id = create.json()["id"]
    r = await client.patch(
        f"/categories/{cat_id}",
        json={"name": "New", "exclude_from_spend": True},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["name"] == "New"
    assert r.json()["exclude_from_spend"] is True


async def test_delete_category(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post("/categories", json={"name": "Bye"}, headers=headers)
    cat_id = create.json()["id"]
    r = await client.delete(f"/categories/{cat_id}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/categories", headers=headers)
    assert listing.json() == []


async def test_category_color_persisted_on_create_and_listing(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    r = await client.post(
        "/categories",
        json={"name": "Groceries", "color": "#22c55e"},
        headers=headers,
    )
    assert r.status_code == 201
    assert r.json()["color"] == "#22c55e"

    listing = await client.get("/categories", headers=headers)
    assert len(listing.json()) == 1
    assert listing.json()[0]["color"] == "#22c55e"


async def test_category_color_updated_via_patch(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/categories",
        json={"name": "X", "color": "#22c55e"},
        headers=headers,
    )
    cat_id = create.json()["id"]
    r = await client.patch(
        f"/categories/{cat_id}",
        json={"color": "#ef4444"},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["color"] == "#ef4444"


async def test_categories_listed_by_sort_order_then_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    # sort_order: B=1, A=2, C=1 → expected: B (1), C (1), A (2)
    # — sort_order ASC, then name ASC for ties.
    await client.post("/categories", json={"name": "B", "sort_order": 1}, headers=headers)
    await client.post("/categories", json={"name": "A", "sort_order": 2}, headers=headers)
    await client.post("/categories", json={"name": "C", "sort_order": 1}, headers=headers)
    r = await client.get("/categories", headers=headers)
    assert [c["name"] for c in r.json()] == ["B", "C", "A"]


async def test_other_user_cannot_see_my_categories(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    from app import db

    headers = _h(authed_user["token"])
    await client.post("/categories", json={"name": "Mine"}, headers=headers)

    pool = db.pool()
    async with pool.acquire() as conn:
        other_uid = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@example.com"
        )
        other_sid = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_uid
        )

    r = await client.get("/categories", headers=_h(str(other_sid)))
    assert r.status_code == 200
    assert r.json() == []
