# net-tracker

Personal-finance PWA for managing a monthly budget and tracking net worth over time. Single-user, magic-link auth.

**Status:** Plans 1 (foundation), 2 (Net Worth), 3 (Budget) shipped, plus a composite Home dashboard. Plan 4 (Spending / Danske CSV / merchant rules) was scrapped.

See [CLAUDE.md](./CLAUDE.md) for the project overview.

## What's there today

- Magic-link sign-in (Resend, opaque-bearer sessions in `localStorage`, 90-day sliding TTL).
- Settings → accounts + categories CRUD with unique per-user color enforcement.
- Home dashboard:
  - Net worth hero tile (gradient headline, EUR readout, 1M delta, 30-day stepped-area sparkline).
  - Composition strip — stacked horizontal bar by asset class with a percentage legend.
  - Current-month budget tile (free money in green/red, gradient progress, `spent of planned · ticked` counts).
  - Next-up tile (3 largest unticked items, sorted desc, each with a colored category dot).
  - All tiles read-only; taps deep-link to the source view. Composes the existing `/networth` and `/budget/months/{ym}` endpoints — no Home-specific backend.
- Net Worth view:
  - Per-account balance-entry history (manual, wealth-accounts only).
  - Total + composition donut by asset class (Cash / Stocks / Crypto / Precious Metals / Pension / Other).
  - Total net-worth chart over time (Chart.js stepped area), 1M / 3M / 6M / 1Y / ALL period pills with deltas.
  - Global **Total / Liquid / No pension** toggle (shown when the portfolio holds pension): Liquid applies the Danish 60% pension early-withdrawal haircut; No pension drops the Pension slice entirely and renormalizes composition. Selection slides the pill indicator and updates the headline, EUR readout, period delta, line chart, and donut in-place. Persists across reloads under `localStorage["net-tracker.networth.view-mode"]` — Home reflects it too.
  - Supplementary `≈ X eur` line under the headline DKK total, ERM II peg (7.46038 DKK/EUR).
  - "First entry is the cutoff" invariant — once an account has a balance entry, nothing earlier can be inserted.
- Budget view:
  - Persistent template (one editable draft + N labelled read-only snapshots / "versions" of past template states).
  - Monthly plans stamped from the current draft as deep-copies — edits to the template never bleed back into a stamped month, and vice versa.
  - Items inside each category with a tick lifecycle: `planned_dkk` + `remaining_dkk` + `ticked_at`. Tick zeroes remaining; untick restores; partial-pay flow auto-ticks when remaining hits zero.
  - Sort dropdown (Amount-desc / A→Z, localStorage-persisted) reorders categories + items live on the month view, and bakes destructively into the template on Save / Save new version so future stamps inherit the order.
  - Total planned / Salary / Free money footer on month, template, and version views — Free money paints green or red depending on sign.
  - Collapsible category heads on both month and template views (caret flips ▾↔▸); collapsed state persists in localStorage.
  - Amount inputs live-format with dot-thousands as you type ("20000" → "20.000"), cursor preserved.
  - Past months can't be stamped (current calendar month + future only).
  - Archive locks a month read-only; unlock with one click in the Archive view.
  - Multi-select category picker shared between month + template flows.
  - CSV-export icon in the month-nav row downloads `budget-YYYY-MM.csv` (UTF-8 with BOM, columns: Category / Item / Planned / Remaining / Ticked / Ticked at) — generated entirely in the browser, no new endpoint.
- Custom themed primitives (Monday-first day picker, month picker, popup color picker with auto-disabled taken hues, themed checkboxes, dialogs, dropdowns).
- Loading-card spinner with a unified "Connecting…" message on every view so the page is never blank while the backend cold-starts.

## Local dev

### Backend

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate    # Windows bash; Linux/Mac: .venv/bin/activate
pip install -r requirements-dev.txt

# Start Postgres (separate shell or already running)
docker compose up -d

DATABASE_URL='postgresql://net:net@localhost:5434/nettracker' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://127.0.0.1:5500 \
  uvicorn app.main:app --port 8000 --reload
```

`MAGIC_LINK_DEV_PRINT=1` logs the magic link to stdout instead of sending via Resend.

### Frontend

```bash
cd frontend
python -m http.server 5500
```

Open `http://127.0.0.1:5500/`. Enter your email; the magic link appears in the backend terminal — click it to sign in.

### Tests

```bash
cd backend
ruff check app tests
mypy app
pytest tests/ -v
```

### Dev-spinup skill (preferred)

```bash
python scripts/dev_up.py     # Postgres + backend + frontend + pre-auth'd session
python scripts/dev_down.py   # kill backend + frontend (Postgres left running)
```

`scripts/dev_up.py` opens the browser at `/dev-login.html?token=<session>` so you arrive on the app already signed in as `dev@local.com`. See `.claude/skills/dev-spinup/SKILL.md`.

## Production deploy

- **Backend:** FastAPI in Docker on an Oracle Cloud Always-Free VM (Frankfurt), behind Caddy with auto-renewing Let's Encrypt TLS. Public URL: `https://yzeir-net.duckdns.org`. Python pinned via `backend/.python-version` (3.12.7). `SCHEMA_SQL` runs idempotently on boot, so schema migrations apply automatically — no manual step.
- **Frontend:** Cloudflare Pages at `https://net-tracker.pages.dev`. `BACKEND_URL` env var injected at build time. CSP `connect-src` in `frontend/_headers` must include the backend host.
- **DB:** Neon Postgres (separate DB from gold-bar-tracker).
- **Email:** Resend (magic-link only at MVP).
- **Deploying:** use the `deploy` skill — say "deploy" / "ship it" in a Claude Code conversation in this repo. The skill SSHes into the VM, pulls `origin/main`, rebuilds the Docker image, restarts containers, and verifies the public health endpoint. See `.claude/skills/deploy/SKILL.md`. One-time per machine: create `.claude/skills/deploy/deploy.env.local` (gitignored) with the VM connection details — format in the SKILL.md "Setup" section.
