# net-tracker

Personal-finance PWA for managing a monthly budget and tracking net worth over time. Single-user, magic-link auth.

**Status:** auth, accounts/categories CRUD, Net Worth, Budget, and Home dashboard shipped. Spending/CSV view scrapped.

See [CLAUDE.md](./CLAUDE.md) for architecture, conventions, and operational rules.

## What's there today

- **Magic-link sign-in** via Resend; opaque-bearer sessions in `localStorage`, 90-day sliding TTL.
- **Home** dashboard composing the existing endpoints — net worth hero (headline, EUR readout, 1M delta, 30-day sparkline), composition strip, current-month budget tile, and next-up unticked items. All tiles read-only; tap to deep-link.
- **Net Worth** — per-account manual balance entries (wealth accounts only), total-over-time stepped chart, composition donut, 1M/3M/6M/1Y/ALL period deltas, and a global Total/Liquid/No-pension toggle (Liquid applies a 60% Danish pension haircut). EUR readout via the ERM II peg.
- **Budget** — persistent template (editable draft + read-only versions) stamped into per-month plans. Items with a tick lifecycle (planned / remaining / ticked_at); past months can't be stamped; archive locks a month read-only. CSV-export icon downloads the current month entirely in the browser.
- **Settings** — accounts + categories CRUD with per-user color uniqueness.
- **Custom UI primitives** in `frontend/shared/` — Monday-first datepicker, monthpicker, popup color picker with taken-hue suppression, themed dialogs/dropdowns, busy-button + friendly-error helpers, loading-card spinner with unified "Connecting…" copy.

## Local dev

One-time setup:

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate    # Linux/Mac: .venv/bin/activate
pip install -r requirements-dev.txt
docker compose up -d                                     # local Postgres on :5434
```

Then use the `dev-spinup` skill:

```bash
python scripts/dev_up.py     # Postgres + backend (:8000) + frontend (:5510) + pre-auth'd session
python scripts/dev_down.py   # kill backend + frontend (Postgres stays up)
```

`dev_up.py` opens the browser at `/dev-login.html?token=<session>` so you arrive signed in as `dev@local.com`. See `.claude/skills/dev-spinup/SKILL.md` for natural-language triggers ("start dev", "tear down").

Tests:

```bash
cd backend
ruff check app tests
mypy app
pytest tests/ -v
```

## Production deploy

- **Backend:** FastAPI in Docker on an Oracle Cloud Always-Free VM (Frankfurt), behind Caddy with auto-renewing Let's Encrypt TLS. Public URL: `https://yzeir-net.duckdns.org`. Python pinned via `backend/.python-version` (3.12.7). `SCHEMA_SQL` runs idempotently on boot, so schema migrations apply automatically — no manual step.
- **Frontend:** Cloudflare Pages at `https://net-tracker.pages.dev`. `BACKEND_URL` env var injected at build time. CSP `connect-src` in `frontend/_headers` must include the backend host.
- **DB:** Neon Postgres (separate DB from gold-price-tracker).
- **Email:** Resend (magic-link only at MVP).
- **Deploying:** use the `deploy` skill — say "deploy" / "ship it" in a Claude Code conversation in this repo. The skill SSHes into the VM, pulls `origin/main`, rebuilds the Docker image, restarts containers, and verifies the public health endpoint. See `.claude/skills/deploy/SKILL.md`. One-time per machine: create `.claude/skills/deploy/deploy.env.local` (gitignored) with the VM connection details — format in the SKILL.md "Setup" section.
