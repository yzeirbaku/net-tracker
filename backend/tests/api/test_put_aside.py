from decimal import Decimal

from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_get_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/put-aside", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body == {"total_dkk": "0", "items": []}


async def test_requires_auth(client: AsyncClient) -> None:
    r = await client.get("/put-aside")
    assert r.status_code == 401


async def test_create_item(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.post(
        "/put-aside/items",
        json={"name": "Car insurance", "amount_dkk": "4200"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Car insurance"
    assert Decimal(body["amount_dkk"]) == Decimal("4200")
    assert "id" in body
    assert "created_at" in body
    assert "updated_at" in body


async def test_create_strips_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/put-aside/items",
        json={"name": "  Vacation  ", "amount_dkk": "1500"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["name"] == "Vacation"


async def test_create_rejects_empty_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/put-aside/items",
        json={"name": "   ", "amount_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_rejects_negative_amount(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/put-aside/items",
        json={"name": "X", "amount_dkk": "-1"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_get_sorts_by_amount_desc(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    for name, amt in [("Small", 100), ("Big", 5000), ("Medium", 1000)]:
        await client.post(
            "/put-aside/items", json={"name": name, "amount_dkk": str(amt)}, headers=headers
        )
    r = await client.get("/put-aside", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert [it["name"] for it in body["items"]] == ["Big", "Medium", "Small"]
    assert Decimal(body["total_dkk"]) == Decimal("6100")


async def test_update_name_and_amount(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items",
        json={"name": "Old", "amount_dkk": "100"},
        headers=headers,
    )
    item_id = create.json()["id"]
    r = await client.put(
        f"/put-aside/items/{item_id}",
        json={"name": "New", "amount_dkk": "200"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "New"
    assert Decimal(body["amount_dkk"]) == Decimal("200")


async def test_update_partial_name_only(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items",
        json={"name": "Old", "amount_dkk": "100"},
        headers=headers,
    )
    item_id = create.json()["id"]
    r = await client.put(
        f"/put-aside/items/{item_id}",
        json={"name": "Renamed"},
        headers=headers,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Renamed"
    assert Decimal(body["amount_dkk"]) == Decimal("100")


async def test_update_unknown_returns_404(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.put(
        "/put-aside/items/00000000-0000-0000-0000-000000000000",
        json={"name": "x"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "not_found"


async def test_delete_item(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items",
        json={"name": "Bye", "amount_dkk": "50"},
        headers=headers,
    )
    item_id = create.json()["id"]
    r = await client.delete(f"/put-aside/items/{item_id}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/put-aside", headers=headers)
    assert listing.json()["items"] == []


async def test_delete_unknown_returns_404(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.delete(
        "/put-aside/items/00000000-0000-0000-0000-000000000000",
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 404


async def test_other_user_cannot_see_my_items(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    from app import db

    await client.post(
        "/put-aside/items",
        json={"name": "Mine", "amount_dkk": "100"},
        headers=_h(authed_user["token"]),
    )

    pool = db.pool()
    async with pool.acquire() as conn:
        other_uid = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@example.com"
        )
        other_sid = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_uid
        )

    r = await client.get("/put-aside", headers=_h(str(other_sid)))
    assert r.status_code == 200
    body = r.json()
    assert body["items"] == []
    assert Decimal(body["total_dkk"]) == Decimal("0")


async def test_get_ties_broken_by_created_at_asc(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """When two items have the same amount, the oldest one comes first.

    This matters because the Home tile picks the top 3 by amount; without a
    deterministic tiebreaker the tile would flicker between renders when
    multiple items share an amount.
    """
    headers = _h(authed_user["token"])
    first = await client.post(
        "/put-aside/items", json={"name": "First", "amount_dkk": "1000"}, headers=headers
    )
    second = await client.post(
        "/put-aside/items", json={"name": "Second", "amount_dkk": "1000"}, headers=headers
    )
    assert first.status_code == 201
    assert second.status_code == 201
    r = await client.get("/put-aside", headers=headers)
    names = [it["name"] for it in r.json()["items"]]
    assert names == ["First", "Second"]


async def test_put_empty_body_is_noop(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items",
        json={"name": "Unchanged", "amount_dkk": "777"},
        headers=headers,
    )
    item_id = create.json()["id"]
    r = await client.put(
        f"/put-aside/items/{item_id}", json={}, headers=headers
    )
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "Unchanged"
    assert Decimal(body["amount_dkk"]) == Decimal("777")


async def test_put_rejects_negative_amount(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items", json={"name": "X", "amount_dkk": "100"}, headers=headers
    )
    item_id = create.json()["id"]
    r = await client.put(
        f"/put-aside/items/{item_id}",
        json={"amount_dkk": "-1"},
        headers=headers,
    )
    assert r.status_code == 422


async def test_put_rejects_whitespace_only_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/put-aside/items", json={"name": "X", "amount_dkk": "100"}, headers=headers
    )
    item_id = create.json()["id"]
    r = await client.put(
        f"/put-aside/items/{item_id}", json={"name": "   "}, headers=headers
    )
    assert r.status_code == 422


async def test_create_rejects_overlong_name(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/put-aside/items",
        json={"name": "x" * 201, "amount_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_decimal_precision_round_trips(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    r = await client.post(
        "/put-aside/items",
        json={"name": "Precise", "amount_dkk": "1234.56"},
        headers=headers,
    )
    assert r.status_code == 201
    assert Decimal(r.json()["amount_dkk"]) == Decimal("1234.56")
    listing = await client.get("/put-aside", headers=headers)
    assert Decimal(listing.json()["total_dkk"]) == Decimal("1234.56")


async def test_other_user_cannot_modify_my_items(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    from app import db

    create = await client.post(
        "/put-aside/items",
        json={"name": "Mine", "amount_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    item_id = create.json()["id"]

    pool = db.pool()
    async with pool.acquire() as conn:
        other_uid = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@example.com"
        )
        other_sid = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_uid
        )

    other_headers = _h(str(other_sid))
    r_put = await client.put(
        f"/put-aside/items/{item_id}", json={"name": "Hacked"}, headers=other_headers
    )
    assert r_put.status_code == 404
    r_del = await client.delete(f"/put-aside/items/{item_id}", headers=other_headers)
    assert r_del.status_code == 404
