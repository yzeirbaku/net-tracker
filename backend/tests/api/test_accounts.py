from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_accounts_list_empty(client: AsyncClient, authed_user: dict[str, str]) -> None:
    r = await client.get("/accounts", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json() == []


async def test_create_spending_account(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Danske Salary", "kind": "spending", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["name"] == "Danske Salary"
    assert body["kind"] == "spending"
    assert body["asset_class"] == "Savings"


async def test_create_sinking_fund_account(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Sinking", "kind": "sinking_fund", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["kind"] == "sinking_fund"


async def test_create_savings_account(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "Nordnet", "kind": "savings", "asset_class": "Stocks"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    assert r.json()["asset_class"] == "Stocks"


async def test_create_account_rejects_bad_kind(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "bogus", "asset_class": "Savings"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_create_account_rejects_bad_asset_class(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.post(
        "/accounts",
        json={"name": "X", "kind": "savings", "asset_class": "Bonds"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 422


async def test_accounts_unique_per_user(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    headers = _h(authed_user["token"])
    payload = {"name": "Same", "kind": "savings", "asset_class": "Savings"}
    r1 = await client.post("/accounts", json=payload, headers=headers)
    assert r1.status_code == 201
    r2 = await client.post("/accounts", json=payload, headers=headers)
    assert r2.status_code == 409


async def test_patch_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Old", "kind": "savings", "asset_class": "Savings"},
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


async def test_patch_account_ignores_kind(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """AccountUpdate doesn't include kind, so sending it is ignored or rejected."""
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "X", "kind": "savings", "asset_class": "Savings"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.patch(f"/accounts/{aid}", json={"kind": "spending"}, headers=headers)
    # Either 200 with kind unchanged, or 422 if Pydantic rejects the extra field. Both fine.
    assert r.status_code in (200, 422)
    if r.status_code == 200:
        assert r.json()["kind"] == "savings"


async def test_delete_account(client: AsyncClient, authed_user: dict[str, str]) -> None:
    headers = _h(authed_user["token"])
    create = await client.post(
        "/accounts",
        json={"name": "Bye", "kind": "savings", "asset_class": "Savings"},
        headers=headers,
    )
    aid = create.json()["id"]
    r = await client.delete(f"/accounts/{aid}", headers=headers)
    assert r.status_code == 204

    listing = await client.get("/accounts", headers=headers)
    assert listing.json() == []
