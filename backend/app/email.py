"""Resend wrapper. When MAGIC_LINK_DEV_PRINT=1 is set, log to stdout instead
of sending. Magic-link only at MVP — alert emails arrive later if/when
notifications are introduced.

Email shape mirrors gold-price-tracker (sibling repo): themed HTML body with
a green sign-in button, plus a parallel text/plain body so plain-text mail
clients render cleanly. Sender display name is 'Net Tracker' to match the
in-app brand."""

from __future__ import annotations

import logging
import os
from http import HTTPStatus

import httpx

log = logging.getLogger("net_tracker.email")

_DEFAULT_FROM = "Net Tracker <onboarding@resend.dev>"


def _dev_print_only() -> bool:
    return os.environ.get("MAGIC_LINK_DEV_PRINT") == "1"


def _html_body(link: str) -> str:
    body_style = (
        "font-family: -apple-system, BlinkMacSystemFont, sans-serif;"
        " max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;"
    )
    btn_style = (
        "display: inline-block; padding: 12px 24px; background: #22c55e;"
        " color: #ffffff; text-decoration: none; border-radius: 6px;"
        " font-weight: 600;"
    )
    return f"""\
<!DOCTYPE html>
<html><body style="{body_style}">
  <h2 style="margin: 0 0 16px;">Sign in to Net Tracker</h2>
  <p>You requested a sign-in link. Click the button below to continue — valid for 15 minutes.</p>
  <p style="margin: 24px 0;">
    <a href="{link}" style="{btn_style}">Sign in to Net Tracker</a>
  </p>
  <p style="color: #666; font-size: 0.9em;">Or paste this link into your browser:<br>
    <span style="word-break: break-all;">{link}</span></p>
  <p style="color: #666; font-size: 0.85em; margin-top: 32px;">
    If you didn't request this, ignore this email.
  </p>
</body></html>"""


def _text_body(link: str) -> str:
    return (
        "Sign in to Net Tracker\n\n"
        "You requested a sign-in link. Open this URL to continue — valid for 15 minutes:\n\n"
        f"{link}\n\n"
        "If you didn't request this, ignore this email."
    )


async def send_magic_link(*, to: str, link: str) -> None:
    if _dev_print_only():
        print(f"[DEV magic link] to={to} link={link}", flush=True)
        return

    api_key = os.environ.get("RESEND_API_KEY")
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is required when MAGIC_LINK_DEV_PRINT is not set")

    from_addr = os.environ.get("RESEND_FROM", _DEFAULT_FROM)
    body = {
        "from": from_addr,
        "to": [to],
        "subject": "Sign in to Net Tracker",
        "html": _html_body(link),
        "text": _text_body(link),
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
