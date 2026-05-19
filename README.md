# net-tracker

Personal-finance PWA for managing a monthly budget, analyzing bank-export spending, and tracking net worth over time. Single-user, magic-link auth.

**Status:** Plans 1 (foundation) + 2 (Net Worth) shipped. Budget and Spending pages are stubs awaiting Plans 3 & 4.

See [CLAUDE.md](./CLAUDE.md) for the project overview.

## What's there today

- Magic-link sign-in (Resend, opaque-bearer sessions in `localStorage`, 90-day sliding TTL).
- Settings → accounts + categories CRUD.
- Net Worth view:
  - Per-account balance-entry history (manual, wealth-accounts only).
  - Total + composition donut by asset class (Cash / Stocks / Crypto / Precious Metals / Pension / Other).
  - Total net-worth chart over time (Chart.js stepped area), 1M / 3M / 6M / 1Y / ALL period pills with deltas.
  - Global **Total / Liquid** toggle that applies the Danish 60% pension early-withdrawal haircut to the top number, the chart, the period delta, and the composition donut.
  - "First entry is the cutoff" invariant — once an account has a balance entry, nothing earlier can be inserted.
  - Custom themed date picker (Monday-first, keyboard nav, max/min bounds) replacing the native `<input type="date">`.
- Loading-card spinner on every view so the page is never blank while the backend cold-starts.

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

- **Backend:** Render free tier. Python pinned via `backend/.python-version` (3.12.7). `SCHEMA_SQL` runs idempotently on boot, so schema migrations (the kind rename, the asset-class rename, new tables like `balance_entries`) apply automatically on the next deploy — no manual step.
- **Frontend:** Cloudflare Pages. Static files; the service worker is intentionally a no-op so deploys are immediately visible after refresh.
- **DB:** Neon Postgres (separate DB from gold-bar-tracker).
- **Email:** Resend (magic-link only at MVP).
