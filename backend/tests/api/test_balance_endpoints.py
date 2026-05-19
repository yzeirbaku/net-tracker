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


async def test_delete_balance_entry(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    headers = _h(authed_user["token"])
    created = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers=headers,
    )
    eid = created.json()["id"]
    r = await client.delete(f"/accounts/{aid}/balance/{eid}", headers=headers)
    assert r.status_code == 204


async def test_delete_balance_entry_not_found(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    r = await client.delete(
        f"/accounts/{aid}/balance/00000000-0000-0000-0000-000000000000",
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 404


async def test_delete_balance_entry_wrong_account(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """Entry belongs to account A; DELETE under account B's URL → 404."""
    headers = _h(authed_user["token"])
    aid_a = await _create_wealth_account(client, authed_user["token"], name="A")
    aid_b = await _create_wealth_account(client, authed_user["token"], name="B")
    created = await client.post(
        f"/accounts/{aid_a}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers=headers,
    )
    eid = created.json()["id"]
    r = await client.delete(f"/accounts/{aid_b}/balance/{eid}", headers=headers)
    assert r.status_code == 404


async def test_delete_balance_entry_other_user(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    created = await client.post(
        f"/accounts/{aid}/balance",
        json={"entry_date": "2026-01-01", "value_dkk": "100"},
        headers=_h(authed_user["token"]),
    )
    eid = created.json()["id"]
    from app import db

    pool = db.pool()
    async with pool.acquire() as conn:
        other_user_id = await conn.fetchval(
            "INSERT INTO users (email) VALUES ($1) RETURNING id", "other@x.com"
        )
        other_session = await conn.fetchval(
            "INSERT INTO sessions (user_id) VALUES ($1) RETURNING id", other_user_id
        )
    r = await client.delete(
        f"/accounts/{aid}/balance/{eid}",
        headers={"Authorization": f"Bearer {other_session}"},
    )
    assert r.status_code == 404


async def test_get_history_empty(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    r = await client.get(f"/accounts/{aid}/history", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    body = r.json()
    assert body["account"]["id"] == aid
    assert body["account"]["kind"] == "wealth"
    assert body["account"]["asset_class"] == "Cash"
    assert body["entries"] == []


async def test_get_history_ascending(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    aid = await _create_wealth_account(client, authed_user["token"])
    headers = _h(authed_user["token"])
    # Insert out-of-order to make sure ORDER BY does the work.
    for d, v in [("2026-03-01", "300"), ("2026-01-01", "100"), ("2026-02-01", "200")]:
        await client.post(
            f"/accounts/{aid}/balance",
            json={"entry_date": d, "value_dkk": v},
            headers=headers,
        )
    r = await client.get(f"/accounts/{aid}/history", headers=headers)
    dates = [e["entry_date"] for e in r.json()["entries"]]
    assert dates == ["2026-01-01", "2026-02-01", "2026-03-01"]


async def test_get_history_account_not_found(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    r = await client.get(
        "/accounts/00000000-0000-0000-0000-000000000000/history",
        headers=_h(authed_user["token"]),
    )
    assert r.status_code == 404


async def test_get_history_works_for_non_wealth(
    client: AsyncClient, authed_user: dict[str, str]
) -> None:
    """History endpoint is read-only; spending/put_aside can have CSV-imported
    rows in Plan 4. Reads must work regardless of kind."""
    aid = await _create_spending_account(client, authed_user["token"])
    r = await client.get(f"/accounts/{aid}/history", headers=_h(authed_user["token"]))
    assert r.status_code == 200
    assert r.json()["entries"] == []


async def test_get_history_other_user_account_404(
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
    r = await client.get(
        f"/accounts/{aid}/history",
        headers={"Authorization": f"Bearer {other_session}"},
    )
    assert r.status_code == 404
