"""Dev-stack teardown — kills the backend + frontend started by dev_up.py.

Usage from repo root:
    python scripts/dev_down.py

Reads .dev/pids.json and terminates the recorded processes. Postgres is left
running on purpose so the next dev_up.py spin-up is instant; stop it with
`docker compose down` if you want a fully cold reset.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEV_STATE_DIR = REPO_ROOT / ".dev"
PIDS_PATH = DEV_STATE_DIR / "pids.json"

IS_WINDOWS = os.name == "nt"


def _kill(pid: int, label: str) -> None:
    if IS_WINDOWS:
        r = subprocess.run(
            ["taskkill", "/F", "/PID", str(pid), "/T"],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0:
            print(f"  killed {label} (pid {pid})")
        else:
            msg = (r.stderr or r.stdout).strip().lower()
            if "not found" in msg or "no running" in msg or "not running" in msg:
                print(f"  {label} (pid {pid}) already gone")
            else:
                print(f"  taskkill {label}: {(r.stderr or r.stdout).strip()}")
    else:
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"  SIGTERM → {label} (pid {pid})")
        except ProcessLookupError:
            print(f"  {label} (pid {pid}) already gone")


def main() -> int:
    if not PIDS_PATH.exists():
        print(f"No {PIDS_PATH} — nothing to tear down.")
        return 0

    pids = json.loads(PIDS_PATH.read_text())
    print("Tearing down dev stack...")
    if "backend_pid" in pids:
        _kill(pids["backend_pid"], "backend")
    if "frontend_pid" in pids:
        _kill(pids["frontend_pid"], "frontend")

    PIDS_PATH.unlink()
    print("\nDone. Postgres is still running; `docker compose down` to stop it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
