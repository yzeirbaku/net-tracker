from __future__ import annotations

from datetime import date
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
    assert Decimal(body["total_dkk"]) == Decimal("0")
    assert Decimal(body["liquid_dkk"]) == Decimal("0")
    assert Decimal(body["pension_total_dkk"]) == Decimal("0")
    assert abs(body["pension_haircut_rate"] - 0.60) < 1e-9
    assert body["series"] == []
    assert body["composition"] == []
    assert body["accounts"] == []
    assert len(body["deltas"]) == 5


async def test_networth_liquid_applies_pension_haircut(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """100k cash + 100k pension → total=200k, liquid=140k (DK ~60% early-WD tax)."""
    cash = await _wealth(client, authed_user["token"], "Bank", "Cash")
    pension = await _wealth(client, authed_user["token"], "Velliv", "Pension")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], cash, today, "100000")
    await _balance(client, authed_user["token"], pension, today, "100000")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert Decimal(body["total_dkk"]) == Decimal("200000")
    assert Decimal(body["liquid_dkk"]) == Decimal("140000")
    assert Decimal(body["pension_total_dkk"]) == Decimal("100000")


async def test_networth_liquid_equals_total_with_no_pension(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    cash = await _wealth(client, authed_user["token"], "Bank", "Cash")
    stocks = await _wealth(client, authed_user["token"], "ISK", "Stocks")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], cash, today, "50000")
    await _balance(client, authed_user["token"], stocks, today, "75000")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert Decimal(body["total_dkk"]) == Decimal("125000")
    assert Decimal(body["liquid_dkk"]) == Decimal("125000")
    assert Decimal(body["pension_total_dkk"]) == Decimal("0")


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


async def test_networth_account_without_entries_listed_but_not_in_math(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Wealth accounts with no balance entries must still appear in `accounts`
    so the user can add their first balance from the Net Worth view. They
    contribute 0 to the total and don't appear in the composition donut.
    """
    a = await _wealth(client, authed_user["token"], "With", "Cash")
    await _wealth(client, authed_user["token"], "Without", "Cash")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], a, today, "100")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    # Both accounts listed (sorted by class then name → alphabetical inside Cash).
    by_name = {acct["name"]: acct for acct in body["accounts"]}
    assert set(by_name.keys()) == {"With", "Without"}
    # The one without entries has null latest fields and an empty sparkline.
    assert by_name["Without"]["latest_entry_date"] is None
    assert by_name["Without"]["latest_value_dkk"] is None
    assert by_name["Without"]["sparkline"] == []
    # Math only sums the account with an entry.
    assert Decimal(body["total_dkk"]) == Decimal("100")
    # Donut still excludes the empty account.
    assert [c["asset_class"] for c in body["composition"]] == ["Cash"]
    assert Decimal(body["composition"][0]["value_dkk"]) == Decimal("100")


async def test_networth_composition_omits_class_with_only_empty_account(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """A class containing only accounts-without-entries must not appear in
    composition or contribute to the total. Pinned variant of the broader
    'account without entries' test, focused on the composition side."""
    cash = await _wealth(client, authed_user["token"], "Bank", "Cash")
    await _wealth(client, authed_user["token"], "Vault", "Precious Metals")
    today = date.today().isoformat()
    await _balance(client, authed_user["token"], cash, today, "200")
    r = await client.get("/networth", headers=_h(authed_user["token"]))
    body = r.json()
    assert [c["asset_class"] for c in body["composition"]] == ["Cash"]
    assert Decimal(body["total_dkk"]) == Decimal("200")
    # Vault still appears in `accounts` so it has an entry point — pinned.
    names = {a["name"] for a in body["accounts"]}
    assert names == {"Bank", "Vault"}


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
    await _balance(client, authed_user["token"], aid, "2026-01-10", "100")
    await _balance(client, authed_user["token"], aid, "2026-02-10", "150")
    # Pin the range so the assertion is deterministic — change dates 2026-01-10
    # and 2026-02-10 fall strictly inside (2026-01-01, 2026-03-01], producing
    # exactly: prefix at 2026-01-01 (NW=0, before any entry) + the two changes.
    r = await client.get(
        "/networth?from=2026-01-01&to=2026-03-01", headers=headers
    )
    body = r.json()
    assert [p["date"] for p in body["series"]] == [
        "2026-01-01",
        "2026-01-10",
        "2026-02-10",
    ]
    assert [Decimal(p["total_dkk"]) for p in body["series"]] == [
        Decimal("0"),
        Decimal("100"),
        Decimal("150"),
    ]
