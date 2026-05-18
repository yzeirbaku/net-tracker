# net-tracker — Claude guide

Personal-finance PWA. Single-user, magic-link auth. Three subsystems (Budget / Spending Analysis / Net Worth) plus a Home dashboard, all sharing a single category taxonomy. Stack and shell are modeled on `gold-bar-tracker` (sibling repo in the same projects folder) — FastAPI on Render, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, Resend for magic-link email. No cron, no public API-key layer, no foreign-currency handling at MVP.

## Git

**All commits in this repo must be authored as `yzeirbaku@hotmail.com` (name: `Yzeir Baku`).** Set in the local repo config — do not change it, and verify with `git config user.email` before committing if anything looks off.

Co-author trailers from Claude Code's default workflow are fine; the *author* must remain the hotmail address.

## Five views

The PWA has five top-level views in a side drawer (same shell pattern as gold-bar-tracker):

- **Home** — four at-a-glance cards: this month's budget remaining (with progress bar + days left), top 3 spending categories last 30 days, net-worth sparkline + delta vs last month, and a "review queue" card that only renders when uncategorized transactions are waiting. Each card taps through to its full view.
- **Budget** — edit the persistent **ideal monthly budget template** (categories + planned amounts). For any month, **stamp template → month** to materialize that month's plan. Once stamped, the month is editable independently; re-stamping overwrites with confirmation. Manual checkoff of expenses; running "remaining" per category + per month.
- **Spending** — retrospective analysis of imported bank CSVs. Per-account filter, transaction table, review queue for uncategorized rows, monthly averages over 1m/3m/6m/12m, per-category breakdown, reports. Put-aside accounts also show an envelope panel above the transaction table.
- **Net Worth** — list of accounts grouped by asset class (Savings / Stocks / Crypto / Gold / Pension / Other). Each account has a history of `(date, balance)` entries; net-worth-over-time chart + period change (1M/3M/6M/1Y/all) + composition breakdown.
- **Settings** — sign in/out, light/dark toggle, manage categories, manage merchant rules, manage envelopes.

The three subsystems share a global **category taxonomy** but otherwise own their data. Budget is manual planning + checkoff; Spending is the retrospective from imported CSVs; Net Worth is the savings/investments overview. They intentionally do *not* cross-couple at the transaction level — categorization in one does not flow to the other. Only categories are shared.

## Account kinds

Three flavors on the `accounts` table (`kind` column):

- **`spending`** — daily account where salary lands and outflows are distributed. CSV-imported (Plan 4). Has the monthly budget. **Not** counted in net worth.
- **`put_aside`** — pre-allocated cash earmarked for irregular bills (insurance, quarterly subscriptions). CSV-imported, has envelopes (Plan 5). **Not** counted in net worth — the money is committed, not wealth.
- **`wealth`** — accumulating assets. Examples: bank savings account, brokerage, crypto wallet, physical gold, pension. **Counts** toward net worth.

The distinction isn't "what's in the account" — it's "is this account wealth or money-in-transit?" Both `spending` and `put_aside` are working capital and exclude themselves from the net-worth calculation.

`asset_class` is **only set on `wealth` accounts** and is NULL otherwise. It groups wealth accounts for the Net Worth view's composition donut. Values: `Cash` (bank savings), `Stocks` (brokerage), `Crypto`, `Gold`, `Pension`, `Other`. The DB enforces "asset_class IS NOT NULL iff kind = 'wealth'" via a CHECK constraint; Pydantic validates the same rule at the API boundary.

Same table for all three kinds; `kind` drives the UI and what fields apply. The Net Worth view (Plan 2) reads accounts where `kind = 'wealth'`. The CSV importer (Plan 4) only attaches to `spending` and `put_aside` accounts.

**User-facing labels:** `spending` shows as "Spending", `put_aside` as "Put-aside", `wealth` as "Wealth". The DB column stores the snake-case values.

## Categorization workflow

A small **rules engine** drives both auto-categorization and "hide forever." No fuzzy / ML / LLM-based guessing — every rule is a deterministic substring match on the Danske `Tekst` (merchant) field, created by user confirmation.

**Rule shape:**

- `pattern` (case-insensitive substring against `Tekst`)
- `action` ∈ `{categorize, hide}`
- `category_id` (NULL when `action='hide'`)
- `envelope_id` (NULL unless the rule scopes to a put-aside account)
- `account_id` (NULL = applies to all accounts; specific = scoped)
- Longest pattern wins; ties broken by most-recently-created. Conflicts visible in the rules manager.

**Bootstrap flow (6-month historical upload):**

1. Upload one or more CSVs. Dedupe is by content-hash `sha256(date + amount_cents + text + bank_category)` — re-uploading the same file is a no-op; overlapping ranges silently skip dupes.
2. Review queue **groups uncategorized rows by extracted pattern** (e.g., "APPLE.COM/BILL — 8 transactions"). One click can categorize all 47 Nettos at once.
3. Each manual categorization prompts "Make this a rule?" with an auto-extracted pattern the user can tweak. Confirm → rule saved → retro-applied to every matching uncategorized transaction across all months.
4. Categories can be created inline from the review-queue dropdown (`+ New category…`) without leaving the flow — small dialog with name, exclude-by-default flag, color.

**Subsequent imports:** the rule engine pre-classifies most rows. Only new merchants land in the queue. Aim is 70-80%+ auto-categorization once the bootstrap is done — predictable because it's purely "did this merchant ever show up before, yes or no."

**Hide forever:** the review queue offers a "Hide forever" button alongside the category dropdown. Creates a `hide` rule; future imports auto-flag matching rows as `hidden = true`. Hidden rows stay in the DB for audit but never appear in totals, charts, averages, or default lists. A "show hidden" toggle in Settings → Rules can reveal them.

**Per-row override:** transactions have a `hidden` boolean that the rules engine can set, but a user can also flip on/off directly from the transaction list — independent of any rule.

## Exclude-by-default categories

Two layers of "don't count this as spending":

- **Category-level:** specific categories (e.g., `Internal transfer`, `Income`, `Savings movement`) are flagged `exclude_from_spend = true`. Honored everywhere spending totals/averages are computed. Surfaced as a small footer note in Spending ("3.250 DKK in transfers hidden").
- **Per-row override:** the `hidden` flag above.

These two are independent — a transaction can be categorized normally but per-row-hidden, or category-excluded but per-row-unhidden.

## Budget side

- **Template** — one persistent row set: `(category_id, planned_amount_dkk)`. Edited anytime in the Budget view.
- **Monthly plan** — when you press "Stamp template" on a given month (current, past, future), the template's rows are copied into a `budget_plan` table keyed by `(year, month)`. After stamping, the month is independent — add/remove categories, edit amounts, none of it touches the template. Re-stamping overwrites with confirmation.
- **Ticks** — within a month, you check off expenses against each category as they happen (running "remaining" per category). Ticks live on the monthly plan, not the template; copying never carries ticks.

## Net Worth side

- **Source set**: only accounts where `kind = 'wealth'`. `spending` and `put_aside` balances are explicitly excluded — they're money-in-transit, not wealth.
- **Balance entries** — `(account_id, date, value_dkk)`. Each manual update is a new row; system never overwrites. Net worth at any date = sum of latest `value_dkk` per wealth account on or before that date.
- **Asset classes:** fixed set — Cash / Stocks / Crypto / Gold / Pension / Other. DKK only at MVP.
- **Charts:** total over time (sparkline + full chart with range pills 1M/3M/6M/1Y/all), composition pie/donut sliced by `asset_class`, per-account history.

## Put-aside (envelopes)

Only relevant for `kind = 'put_aside'` accounts.

- `envelopes(id, account_id, name, target_monthly_dkk, cadence_months?, expected_amount_dkk?, color?)`
- Transactions in put-aside accounts gain an optional `envelope_id`.
- **Balance per envelope** = `sum(signed amount where envelope_id = X)`. Account `Saldo` (from latest CSV row) remains the source of truth for the account total.
- **Unallocated** = `account_total − sum(envelope_balances)`. Money sitting in the account not yet earmarked.
- **Splitting deposits:** when a positive transaction (the monthly lump from salary) is reviewed, a split dialog distributes it across envelopes (must sum to the deposit amount; default split is proportional to `target_monthly`). User can leave it unallocated and split later.
- **Cadence + expected** are planning hints only — drive the "next due" indicator (covered ✓ / short by N ✗) but never enter the balance calculation.

## Auth

Single scheme: magic-link → opaque session bearer tokens in `localStorage` (`net-tracker.session-token`). Sliding 90-day TTL with the same `last_seen_at` debounce gold-bar-tracker uses. No public `X-API-Key` layer — nothing in this app is intended to be shared.

Magic-link rate limits and one-time SHA-256-hashed tokens follow the gold-bar-tracker pattern. Email transport: Resend; `MAGIC_LINK_DEV_PRINT=1` logs to stdout in local dev instead of sending.

## Theme

- Accent: saturated emerald (`#16a34a` light / `#22c55e` dark) with a lighter strong variant (`#34d399` dark) for gradients and active states. Distinct from gold-bar-tracker's gold.
- Dark base: cooler near-black (`#0d1117` / `#161c24` surfaces), distinct from gold-bar-tracker's warm grey-black.
- Light theme: its own design, not a copy.
- **Buttons sized to match gold-bar-tracker exactly:**
  - Standard `.btn-primary` (Add Category, Add Account, future standalone CTAs): desktop `padding: 0.45rem 0.85rem`; mobile (<600px) `padding: 0.375rem 0.75rem`, `font-size: 0.82rem`.
  - Dialog `<menu>` buttons (Cancel + Save): desktop `padding: 0.55rem 0.95rem`; mobile (<480px) `padding: 0.45rem 0.82rem`, `font-size: 0.87rem`. Dialog buttons are intentionally larger than Add — gold-bar's hierarchy.
- Affirmative gets a subtle gradient + inset highlight + tiny colored glow (no halo). `dialog menu button[value="save"]` and `.btn-primary` paint affirmative; default neutral surface otherwise.
- **Menu icons are inline SVG** (Lucide-style stroke icons), not unicode glyphs. Unicode chars had font-metric drift across systems (especially `⌂`); SVG gives pixel-exact sizing and clean alignment. Icon slot is a fixed `1.5rem × 1.5rem` flex box; SVG inside is 16px base with Home bumped to 18px and Budget to 17px.
- **Header sizing copied from gold-bar verbatim:** desktop `padding: 1rem`, `h1 1.3rem`, burger 46×46 with 1.25rem glyph. Mobile (<480px): `padding: 0.7rem 1rem`, `h1 1.05rem`, burger 36×36 with 1.55rem glyph (smaller frame, beefier icon).
- Header title: "Personal Finance Tracker" (green gradient). Drawer brand: "Net Tracker".
- Date format site-wide: `DD-MM-YYYY` for dates, `DD-MM-YYYY HH:MM` for timestamps.
- **Custom UI components:**
  - `frontend/shared/dropdown.js` — themed div-based dropdown with chevron, popup list, click-outside / Esc close, keyboard nav. Used wherever native `<select>` would leak browser-default option styling.
  - `frontend/shared/ui.js::confirmPrompt({title, message, okLabel, danger})` — themed `<dialog>` confirmation, returns `Promise<boolean>`. Replaces native `window.confirm`. `danger: true` paints the affirmative red.
  - Category color picker (in `settings.js`) — compact circular trigger with "Pick a color" prompt; hidden until the category name input has text. Click → floating swatch popup (18 colors, 6-column grid).

## Conventions

- **Currency: DKK only at MVP.** No foreign-currency handling.
- **Numbers:** Danish format on parsing (dot thousands, comma decimal). Display formatting TBD but follows the gold-bar-tracker rule (dots only, never commas).
- **Encoding:** Danske Bank CSV is **ISO-8859-1**, not UTF-8 — parser must specify it explicitly.
- **Padded fields:** Danske's `Kategori` / `Underkategori` are right-padded with spaces to ~80 chars — strip everywhere.
- **Date format:** `DD-MM-YYYY` in the UI; `DD.MM.YYYY` in Danske CSV input.

## What MVP intentionally excludes

- No automatic / heuristic / ML-based transaction categorization. All categorization is deterministic substring rules, user-confirmed.
- No cron jobs (no QStash). Everything is user-initiated. CSV import happens when you upload.
- No public `X-API-Key` layer. Single auth scheme: magic-link bearer tokens.
- No multi-currency.
- No automated bank API connection — CSV upload only.
- No alerts / email notifications beyond magic-link sign-in.
- No cross-coupling between Budget ticks and Spending CSV rows (option A from brainstorming). They share categories, nothing else.

## Local dev

```bash
# Backend (one-time setup)
cd backend
python -m venv .venv
source .venv/Scripts/activate    # Windows bash; Linux/Mac: .venv/bin/activate
pip install -r requirements-dev.txt

# Local Postgres on port 5434 (separate from gold-bar-tracker's 5433)
docker compose up -d
```

### Dev-spinup skill (preferred)

The `dev-spinup` skill (committed under `.claude/skills/dev-spinup/`) wraps everything in one command. It:

1. Ensures Docker Postgres is up.
2. Starts the FastAPI backend on `:8000` (which runs `SCHEMA_SQL` on boot — idempotent migrations).
3. Upserts user `dev@local.com` and creates a fresh session.
4. Starts the static frontend server on `:5500`.
5. Records PIDs to `.dev/pids.json` (gitignored).
6. Opens the browser at `/dev-login.html?token=<session>` — frontend stores the token in `localStorage` and redirects to `/`, so you arrive already signed in.

```bash
python scripts/dev_up.py    # spin up
python scripts/dev_down.py  # tear down
```

`dev_down.py` kills the backend + frontend processes from `.dev/pids.json` but leaves Postgres running for fast re-spinup. The Skill tool's natural-language triggers (in `.claude/skills/dev-spinup/SKILL.md`) cover "start dev", "spin up", "tear down", "I'm done", etc.

### Manual mode

```bash
DATABASE_URL='postgresql://net:net@localhost:5434/nettracker' \
  MAGIC_LINK_DEV_PRINT=1 \
  MAGIC_LINK_BASE_URL=http://127.0.0.1:5500 \
  uvicorn app.main:app --port 8000 --reload

# In a second shell:
cd frontend && python -m http.server 5500
```

`MAGIC_LINK_DEV_PRINT=1` makes the magic-link email log to stdout instead of sending via Resend — useful for testing without burning quota.

## Verification

```bash
# From backend/:
ruff check app tests
mypy app
pytest tests/ -v        # full suite (unit + api against real Postgres)
```

CI (`.github/workflows/tests.yml`) runs all three on push/PR to `main` against a Postgres-16 sidecar container.
