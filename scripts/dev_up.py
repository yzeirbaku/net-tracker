"""Dev-stack spin-up: Postgres + backend + frontend, pre-signed-in as dev@local.com.

Usage from repo root:
    python scripts/dev_up.py

When done testing, tear down with:
    python scripts/dev_down.py

What it does:
1. Ensures Docker Postgres is up.
2. Starts the FastAPI backend on :8000 (which runs SCHEMA_SQL on boot).
3. Inserts/refreshes a session for dev@local.com (creates the user if missing).
4. Starts the static frontend server on :5500.
5. Writes pids to .dev/pids.json so dev_down.py can clean up.
6. Opens the browser at /dev-login.html?token=<session> — frontend stores the
   token in localStorage and redirects to /, so you arrive already signed in.

The script is idempotent at the Postgres + schema layer (re-running is safe);
it refuses to start a second time if .dev/pids.json already exists, to avoid
orphaning processes. Run dev_down.py first.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid
import webbrowser
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
FRONTEND_DIR = REPO_ROOT / "frontend"
DEV_STATE_DIR = REPO_ROOT / ".dev"
PIDS_PATH = DEV_STATE_DIR / "pids.json"

BACKEND_PORT = 8000
FRONTEND_PORT = 5510
DEV_EMAIL = "dev@local.com"
DSN = "postgresql://net:net@localhost:5434/nettracker"


def _ensure_postgres() -> None:
    print("Checking Postgres...")
    result = subprocess.run(
        ["docker", "compose", "ps", "-q", "postgres"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if not result.stdout.strip():
        print("  starting via docker compose...")
        subprocess.run(
            ["docker", "compose", "up", "-d", "postgres"],
            cwd=REPO_ROOT,
            check=True,
        )

    for _ in range(30):
        r = subprocess.run(
            ["docker", "compose", "exec", "-T", "postgres", "pg_isready", "-U", "net"],
            cwd=REPO_ROOT,
            capture_output=True,
        )
        if r.returncode == 0:
            print("  Postgres ready")
            return
        time.sleep(1)
    raise RuntimeError("Postgres did not become ready within 30s")


def _venv_python() -> str:
    win = BACKEND_DIR / ".venv" / "Scripts" / "python.exe"
    if win.exists():
        return str(win)
    nix = BACKEND_DIR / ".venv" / "bin" / "python"
    if nix.exists():
        return str(nix)
    raise RuntimeError(
        f"No venv found at {BACKEND_DIR}/.venv. Create one with:\n"
        f"  cd backend && python -m venv .venv && "
        f"source .venv/Scripts/activate && pip install -r requirements-dev.txt"
    )


def _start_backend() -> int:
    venv_python = _venv_python()
    env = os.environ.copy()
    env["DATABASE_URL"] = DSN
    env["MAGIC_LINK_DEV_PRINT"] = "1"
    env["MAGIC_LINK_BASE_URL"] = f"http://127.0.0.1:{FRONTEND_PORT}"

    log_path = DEV_STATE_DIR / "backend.log"
    proc = subprocess.Popen(
        [venv_python, "-m", "uvicorn", "app.main:app", "--port", str(BACKEND_PORT)],
        cwd=BACKEND_DIR,
        env=env,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
    )
    print(f"Backend starting (pid {proc.pid}); logs at {log_path}")

    for _ in range(30):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{BACKEND_PORT}/", timeout=1).read()
            print("  backend ready")
            return proc.pid
        except Exception:  # noqa: BLE001, S110
            time.sleep(1)
    raise RuntimeError(f"Backend did not start within 30s — check {log_path}")


def _upsert_dev_session() -> str:
    """Insert dev user (idempotent) + a fresh session row. Returns the session UUID."""
    session_id = str(uuid.uuid4())
    sql = (
        "WITH u AS (INSERT INTO users (email) VALUES ('"
        + DEV_EMAIL
        + "') ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id) "
        "INSERT INTO sessions (id, user_id) SELECT '"
        + session_id
        + "', u.id FROM u RETURNING id;"
    )
    r = subprocess.run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "postgres",
            "psql",
            "-U",
            "net",
            "-d",
            "nettracker",
            "-At",
            "-c",
            sql,
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    # psql `-At` prints the returned row plus an "INSERT 0 1" tag line.
    # Be liberal: just check the expected UUID is present anywhere in stdout.
    if session_id not in r.stdout:
        raise RuntimeError(
            f"Session insert didn't return expected UUID.\n"
            f"stdout: {r.stdout!r}\nstderr: {r.stderr!r}"
        )
    print(f"Dev session created: {session_id}")
    return session_id


def _start_frontend() -> int:
    log_path = DEV_STATE_DIR / "frontend.log"
    proc = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(FRONTEND_PORT)],
        cwd=FRONTEND_DIR,
        stdout=log_path.open("w"),
        stderr=subprocess.STDOUT,
    )
    time.sleep(1)
    print(f"Frontend up (pid {proc.pid}); logs at {log_path}")
    return proc.pid


def main() -> int:
    DEV_STATE_DIR.mkdir(exist_ok=True)

    if PIDS_PATH.exists():
        print(
            f"\n{PIDS_PATH} already exists — dev stack is (or was) already running.\n"
            f"Tear it down first: python scripts/dev_down.py\n"
        )
        return 1

    _ensure_postgres()
    backend_pid = _start_backend()
    try:
        token = _upsert_dev_session()
        frontend_pid = _start_frontend()
    except Exception:
        # Don't orphan the backend if a later step fails — write what we have
        # so dev_down.py can clean up.
        PIDS_PATH.write_text(json.dumps({"backend_pid": backend_pid}, indent=2))
        print(
            f"\nSetup failed after backend started. Run `python scripts/dev_down.py` "
            f"to clean up pid {backend_pid}."
        )
        raise

    PIDS_PATH.write_text(
        json.dumps(
            {
                "backend_pid": backend_pid,
                "frontend_pid": frontend_pid,
                "session_token": token,
            },
            indent=2,
        )
    )

    url = f"http://127.0.0.1:{FRONTEND_PORT}/dev-login.html?token={token}"
    print(f"\n-> Opening {url}")
    webbrowser.open(url)
    print("\nDev stack up. Tear down with: python scripts/dev_down.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
