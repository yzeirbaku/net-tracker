"""Resend wrapper. When MAGIC_LINK_DEV_PRINT=1 is set, log to stdout instead of sending."""

from __future__ import annotations

import logging
import os
from http import HTTPStatus

import httpx

log = logging.getLogger("net_tracker.email")


def _dev_print_only() -> bool:
    return os.environ.get("MAGIC_LINK_DEV_PRINT") == "1"


async def send_magic_link(*, to: str, link: str) -> None:
    if _dev_print_only():
        print(f"[DEV magic link] to={to} link={link}", flush=True)
        return

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is required when MAGIC_LINK_DEV_PRINT is not set")

    from_addr = os.environ.get("RESEND_FROM", "onboarding@resend.dev")
    body = {
        "from": from_addr,
        "to": [to],
        "subject": "Your net-tracker sign-in link",
        "html": (
            "<p>Click to sign in to net-tracker. This link expires in 15 minutes.</p>"
            f'<p><a href="{link}">Sign in</a></p>'
            f'<p style="color:#888">Or paste this URL: {link}</p>'
        ),
    }
    async with httpx.AsyncClient(timeout=10.0) as http:
        r = await http.post(
            "https://api.resend.com/emails",
            json=body,
            headers={"Authorization": f"Bearer {api_key}"},
        )
        if r.status_code >= HTTPStatus.BAD_REQUEST:
            log.error("resend_failed status=%s body=%s", r.status_code, r.text)
            r.raise_for_status()
