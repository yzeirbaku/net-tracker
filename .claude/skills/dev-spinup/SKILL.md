---
name: dev-spinup
description: Spin up the local net-tracker dev stack (Postgres + FastAPI backend + frontend PWA) pre-logged-in as dev@local.com, or tear it down. Use when the user says any of - "start dev", "spin up dev", "bring up dev", "let me try it", "I want to test", "I want to play with it", "test it" - to bring it up; or - "tear down", "stop dev", "bring it down", "I'm done", "done testing", "kill the dev stack" - to bring it down. Skill is the only sanctioned way to start / stop dev locally - don't roll your own uvicorn invocations.
---

# Dev stack spin-up / tear-down

Repo-local skill that runs two Python scripts to manage a fully working local environment, pre-authenticated as `dev@local.com` so the user never has to click through a magic link in dev.

## How to invoke

**To bring the stack UP**, run from the repo root:

```bash
python scripts/dev_up.py
```

This will:
1. Verify Docker Postgres is up (on `localhost:5434`); start the `postgres` container via `docker compose up -d postgres` if not.
2. Start the FastAPI backend on `:8000` (the venv's `python -m uvicorn app.main:app`). Backend's lifespan runs `SCHEMA_SQL` on startup, so re-running is safe even if the DB is fresh.
3. Upsert `dev@local.com` in `users` and insert a fresh row in `sessions` with a generated UUID. The user record is `ON CONFLICT DO UPDATE` so it's idempotent.
4. Start the static frontend server on `:5500` (`python -m http.server` from `frontend/`).
5. Record both PIDs + the session token to `.dev/pids.json`.
6. Open the browser at `http://127.0.0.1:5500/dev-login.html?token=<session>`. That page stores the token in `localStorage` under the production key (`net-tracker.session-token`) and redirects to `/`, so the user arrives on the settings view already signed in.

**To bring it DOWN**, run from the repo root:

```bash
python scripts/dev_down.py
```

This reads `.dev/pids.json`, sends a kill signal to both processes (Windows `taskkill /F /T` or Unix `SIGTERM`), and deletes the pids file. Postgres is **left running** so the next spin-up is instant; the user can stop it with `docker compose down` if they want a fully cold reset.

## Operating notes

- The skill is the **only sanctioned way** to start dev locally. Don't shell out a one-off `uvicorn` + `http.server` invocation — that orphans processes when the user moves on.
- Backend logs land in `.dev/backend.log`, frontend logs in `.dev/frontend.log`. If startup hangs or the browser doesn't load, tail those files first.
- `dev_up.py` refuses to start a second time if `.dev/pids.json` already exists. Run `dev_down.py` first.
- Token is opaque; treat it like any other session token. It's only useful against the local backend.
- If the user reports stale auth (e.g. "I'm getting 401s"), run `dev_down.py` then `dev_up.py` — that issues a new session.

## Prerequisites

- Docker Desktop running (for the Postgres container).
- `backend/.venv` exists with dependencies installed. If missing:
  ```bash
  cd backend
  python -m venv .venv
  source .venv/Scripts/activate    # Windows bash; Linux/Mac: .venv/bin/activate
  pip install -r requirements-dev.txt
  ```

## Files involved

- `scripts/dev_up.py` — orchestrator (bring up).
- `scripts/dev_down.py` — orchestrator (bring down).
- `frontend/dev-login.html` — token-injection redirect page.
- `.dev/pids.json` — runtime state (gitignored).
- `.dev/backend.log`, `.dev/frontend.log` — process logs (gitignored).
