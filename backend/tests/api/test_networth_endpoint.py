from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _wealth(
    client: AsyncClient, token: str, name: str, asset_class: str = "Cash"
) -> str:
    r = await client.post(
        "/accounts",
        json={"name": name, "kind": "wealth", "asset_class": asset_class},
        headers=_h(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _balance(
    client: AsyncClient, token: str, account_id: str, d: str, v: str
) -> None:
    r = await client.post(
        f"/accounts/{account_id}/balance",
        json={"entry_date": d, "value_dkk": v},
        headers=_h(token),
    )
    assert r.status_code in (200, 201), r.text


async def test_networth_empty(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["total_dkk"] == "0"
    assert body["series"] == []
    assert body["composition"] == []
    assert body["accounts"] == []
    assert len(body["deltas"]) == 5


async def test_networth_single_entry(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _wealth(client, authed_user["token"], "Nordnet", "Stocks")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], aid, today, "100000")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert Decimal(body["total_dkk"]) == Decimal("100000")
    assert len(body["composition"]) == 1
    assert body["composition"][0]["asset_class"] == "Stocks"
    assert len(body["accounts"]) == 1
    assert body["accounts"][0]["name"] == "Nordnet"


async def test_networth_spending_account_excluded(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Even if (via Plan 4 in the future) a spending account had a balance_entries
    row, it should not enter the net-worth math. Today: spending accounts can't
    even accept a POST /balance, so this is a forward-compat assertion."""
    wid = await _wealth(client, authed_user["token"], "W")
    await _balance(client, authed_user["token"], wid, "2026-01-01", "100")
    r = await client.post(
        "/accounts",
        json={"name": "S", "kind": "spending"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert Decimal(body["total_dkk"]) == Decimal("100")
    assert [a["name"] for a in body["accounts"]] == ["W"]


async def test_networth_composition_pcts_sum_to_one(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    cash = await _wealth(client, authed_user["token"], "Bank", "Cash")
    stocks = await _wealth(client, authed_user["token"], "ISK", "Stocks")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], cash, today, "200")
    await _balance(client, authed_user["token"], stocks, today, "800")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    pct_sum = sum(c["pct"] for c in body["composition"])
    assert abs(pct_sum - 1.0) < 1e-6


async def test_networth_account_without_entries_omitted(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    a = await _wealth(client, authed_user["token"], "With", "Cash")
    await _wealth(client, authed_user["token"], "Without", "Cash")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], a, today, "100")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert [acct["name"] for acct in body["accounts"]] == ["With"]


async def test_networth_invalid_range(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.get(
        "/networth?from=2026-05-01&to=2026-04-01",
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_range"


async def test_networth_series_sparse(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _wealth(client, authed_user["token"], "W")
    headers = _h(authed_user["token"])
    today = date.today()
    d1 = (today - timedelta(days=200)).isoformat()
    d2 = (today - timedelta(days=100)).isoformat()
    await _balance(client, authed_user["token"], aid, d1, "100")
    await _balance(client, authed_user["token"], aid, d2, "150")
    r = await client.get("/networth", headers=headers)
    body = r.json()
    # Sparse: prefix point at `from` (defaults to today-365)
    # + the two change dates that fall inside the range.
    assert 2 <= len(body["series"]) <= 3
