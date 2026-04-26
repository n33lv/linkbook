"""Harvest-specific account resolver.

After OAuth, Harvest doesn't tell us which account-id to scope API calls
to — every API call requires a `Harvest-Account-Id` header, and a token
can be authorized against multiple accounts. We have to call the
identity service with the bearer token to find out.

Endpoint: GET https://id.getharvest.com/api/v2/accounts
Returns: { "user": {...}, "accounts": [ {"id": ..., "name": ...}, ... ] }

For our single-tenant single-user PoC, we pick the first account.
"""

from __future__ import annotations

from typing import Any

import httpx

ACCOUNTS_URL = "https://id.getharvest.com/api/v2/accounts"
USER_AGENT = "Linkbook (linkbook@flightdesign.co)"


async def resolve_harvest_account(access_token: str) -> dict[str, Any]:
    """Return the first Harvest account the token has access to.

    Raises if the API call fails or no accounts are returned.
    """
    async with httpx.AsyncClient(timeout=15.0) as client:
        res = await client.get(
            ACCOUNTS_URL,
            headers={
                "Authorization": f"Bearer {access_token}",
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
        )
    res.raise_for_status()
    payload = res.json()
    accounts = payload.get("accounts") or []
    if not accounts:
        raise RuntimeError("harvest returned no accounts for this token")
    first = accounts[0]
    return {
        "id": str(first["id"]),
        "name": first.get("name", "Harvest"),
        "user": payload.get("user", {}),
    }
