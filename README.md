# net-tracker

Personal-finance PWA for managing a monthly budget, analyzing bank-export spending, and tracking net worth over time. Single-user, magic-link auth.

See [CLAUDE.md](./CLAUDE.md) for the project overview.

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

## Production deploy

Backend on Render (free tier), frontend on Cloudflare Pages, Postgres on Neon. Magic-link emails via Resend. Specific deploy configs will be added in a later plan.
