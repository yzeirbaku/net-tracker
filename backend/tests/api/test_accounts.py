from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_accounts_list_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/accounts", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_spending_account_no_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Danske Salary", "kind": "spending"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Danske Salary"
    assert body["kind"] == "spending"
    assert body["asset_class"] is None


async def test_create_put_aside_account_no_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Put-aside", "kind": "put_aside"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["kind"] == "put_aside"
    assert r.json()["asset_class"] is None


async def test_create_wealth_account_requires_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Nordnet", "kind": "wealth"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_wealth_account_with_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Nordnet", "kind": "wealth", "asset_class": "Stocks"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["kind"] == "wealth"
    assert body["asset_class"] == "Stocks"


async def test_create_spending_rejects_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "spending", "asset_class": "Cash"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_account_rejects_bad_kind(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "bogus"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_account_rejects_bad_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "wealth", "asset_class": "Bonds"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_accounts_unique_per_user(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    payload = {"name": "Same", "kind": "wealth", "asset_class": "Cash"}
    r1 = await client.post("/accounts", json=payload, headers=headers)
    assert r1.status_code == 201
    r2 = await client.post("/accounts", json=payload, headers=headers)
    assert r2.status_code == 409


async def test_patch_wealth_account_change_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Old", "kind": "wealth", "asset_class": "Cash"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.patch(
        f"/accounts/{aid}",
        json={"name": "Renamed", "asset_class": "Crypto"},
        headers=headers,
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Renamed"
    assert r.json()["asset_class"] == "Crypto"


async def test_patch_spending_cannot_add_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Salary", "kind": "spending"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.patch(
        f"/accounts/{aid}",
        json={"asset_class": "Cash"},
        headers=headers,
    )
    assert r.status_code == 400


async def test_delete_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Bye", "kind": "wealth", "asset_class": "Cash"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.delete(f"/accounts/{aid}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/accounts", headers=headers)
    assert listing.json() == []
