from __future__ import annotations

from datetime import date, timedelta

from httpx import AsyncClient


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_wealth_account(client: AsyncClient, token: str, name: str = "W") -> str:
    r = await client.post(
        "/accounts",
        json={"name": name, "kind": "wealth", "asset_class": "Cash"},
        headers=_h(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _create_spending_account(client: AsyncClient, token: str, name: str = "S") -> str:
    r = await client.post(
        "/accounts",
        json={"name": name, "kind": "spending"},
        headers=_h(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_post_balance_wealth_account_inserts(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    r = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100000.50"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201
    body = r.json()
    assert body["entry_date"] == "2026-01-01"
    assert body["value_dkk"] == "100000.50"
    assert body["source"] == "manual"
    assert body["account_id"] == aid


async def test_post_balance_spending_account_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_spending_account(client, authed_user["token"])
    r = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "not_a_wealth_account"


async def test_post_balance_future_date_rejected(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    future = (date.today() + timedelta(days=1)).isoformat()
    r = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": future, "value_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "future_date_not_allowed"


async def test_post_balance_today_allowed(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    r = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": date.today().isoformat(), "value_dkk": "1"},
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 201


async def test_post_balance_upsert_same_date(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    headers = _h(authed_user["token"])
    r1 = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers=headers,
    )
    assert r1.status_code == 201
    r2 = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "200"},
        headers=headers,
    )
    assert r2.status_code == 200
    assert r2.json()["value_dkk"] == "200.00"


async def test_post_balance_other_user_account_404(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    from app import db

    pool = db.pool()
    async with pool.acquire() as conn:
        other_user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@x.com"
        )
        other_session = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_user_id
        )
    r = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers={"Authorization": f"Bearer {other_session}"},
    )
    assert r.status_code == 404
