---
name: deploy
description: Deploy net-tracker backend to the live Oracle Cloud VM. Use when the user says "deploy", "deploy net-tracker", "ship it", "push to prod", "redeploy", or similar — anything implying they want the latest committed code running in production. Pulls latest origin/main on the VM over SSH, rebuilds the Docker image, restarts the containers, and verifies the public health endpoint.
---

# Deploy net-tracker to production

Production runs on an Oracle Cloud Always-Free VM. A deploy is two commands run over SSH, plus a health check.

## How to invoke

User says any of: "deploy", "deploy net-tracker", "ship it", "push to prod", "redeploy", "deploy to oracle".

**Pre-flight assumption:** the code is already committed AND pushed to `origin/main` on GitHub. The skill does a `git pull` on the VM — local-only commits won't be deployed. If unsure, check `git status` and `git log origin/main..HEAD` first.

## VM layout

```
~/apps/net-tracker/
├── repo/                       # this repo, cloned via deploy key
│   └── backend/Dockerfile      # VM-local, not in this repo's git
├── docker-compose.yml          # backend + Caddy stack (VM-local)
├── Caddyfile                   # reverse proxy + Let's Encrypt (VM-local)
└── .env                        # secrets — DATABASE_URL, RESEND_API_KEY (VM-local, 0600)
```

`docker-compose.yml`, `Caddyfile`, `Dockerfile`, and `.env` exist only on the VM. They are intentionally not in this repo. If the VM is ever recreated, they need to be reconstructed (see the original setup conversation or `~/apps/net-tracker/` on the live VM).

## Procedure

1. **Read connection details** from `.claude/skills/deploy/deploy.env.local` (gitignored). Required keys: `SSH_HOST`, `SSH_USER`, `SSH_KEY`, `REMOTE_PATH`, `HEALTH_URL`.

   If the file is missing, **refuse to deploy** and tell the user to create it (see Setup below).

2. **Confirm with the user** before deploying. Tell them: "Pulling latest from origin/main on the VM, rebuilding the Docker image, restarting containers." Wait for their go-ahead unless they were explicit ("deploy now").

3. **Run the deploy** over SSH:

   ```bash
   ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$SSH_USER@$SSH_HOST" \
     "cd $REMOTE_PATH/repo && git pull && cd .. && sudo docker compose up -d --build 2>&1 | tail -30"
   ```

   Stream the tail back to the user so they see the build + restart output.

4. **Verify** the public health endpoint:

   ```bash
   curl -sS -o /dev/null -w "HTTP %{http_code} in %{time_total}s\n" "$HEALTH_URL"
   ```

   Expect HTTP 200 with `{"status":"ok"}` body. If you want to confirm the body, drop the `-o /dev/null`.

5. **On failure**, tail the backend container logs and surface what broke:

   ```bash
   ssh -i "$SSH_KEY" "$SSH_USER@$SSH_HOST" "sudo docker logs net-tracker-backend --tail 60"
   ```

## Setup (one-time per machine)

The skill needs `.claude/skills/deploy/deploy.env.local`. Gitignored. Format:

```
SSH_HOST=<vm-public-ip>
SSH_USER=ubuntu
SSH_KEY=<absolute-path-to-private-key>
REMOTE_PATH=~/apps/net-tracker
HEALTH_URL=https://yzeir-net.duckdns.org/
```

Refresh this file if the VM IP changes (only happens if the instance is stopped and reassigned — rare on Always Free) or if the SSH key is rotated.

## Operating notes

- **Updating a secret** (Neon password rotation, new Resend key): SSH in, edit `~/apps/net-tracker/.env`, then `sudo docker compose up -d --force-recreate backend` to reload env. The skill does NOT touch `.env` — that's a manual privileged action.
- **Memory pressure**: the VM has 954 MB RAM + 2 GB swap. Two FastAPI apps + Caddy fit, but watch `free -h` if more backends are added.
- **Idle reclaim**: Oracle reclaims Always Free VMs with < 20% CPU 95th percentile over 7 days. Real traffic + periodic pings keep it alive.
- **DNS**: `yzeir-net.duckdns.org` → VM public IP. DuckDNS IP is updated manually on the dashboard; if the VM IP ever changes, update there too.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Permission denied (publickey)` | Wrong `SSH_KEY` path in `deploy.env.local` | Verify path; key file should be `0600` on Unix or restricted-ACL on Windows |
| `git pull` says `Authentication failed` | GitHub deploy key broken/removed on VM | Re-add VM's `~/.ssh/github_net_tracker.pub` at https://github.com/yzeirbaku/net-tracker/settings/keys |
| Build fails on `pip install` | Dependency version conflict | Check `backend/requirements.txt` diff; rebuild may need `--no-cache` |
| Health check returns 502 | Backend crashed on startup | Tail container logs (step 5) — usually missing/wrong env var or DB connection |
| Health check returns 200 but app broken | Schema drift or runtime error post-startup | Tail logs; check Neon for migration state |
| `no space left on device` | Docker build cache filled the 45 GB disk | `ssh ... "sudo docker system prune -af --volumes"` then redeploy |

## Cross-references

- Sibling skill: `.claude/skills/dev-spinup/SKILL.md` — local dev (different concern; localhost FastAPI + local Postgres).
