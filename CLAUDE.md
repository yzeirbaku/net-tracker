# net-tracker — Claude guide

Personal-finance PWA. Single-user, magic-link auth. Three subsystems (Budget / Spending / Net Worth) + a Home dashboard, all sharing a single category taxonomy. Stack modeled on `gold-bar-tracker` (sibling repo) — FastAPI on Render, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, Resend for magic-link email.

**Plans 1, 2, 3 shipped** (auth, accounts/categories CRUD, Net Worth, Budget). Plans 4 (Spending/CSV), 5 (Envelopes) and the Home dashboard are not built yet — see `docs/superpowers/specs/2026-05-18-net-tracker-design.md` for the original design and `docs/superpowers/specs/2026-05-20-budget-plan-3-design.md` for the Plan 3 spec.

## Git

All commits in this repo must be authored as `yzeirbaku@hotmail.com` (name: `Yzeir Baku`). Already set in the local config — verify with `git config user.email` before committing if anything looks off. Co-author trailers from Claude Code are fine; the *author* must remain the hotmail address.

## Five views

Side-drawer nav, same shell pattern as gold-bar-tracker:

- **Home** — future composite dashboard. Currently a stub showing "Welcome" / "Please sign in" depending on session state.
- **Budget** — live. Persistent template (one draft + N labelled snapshots) stamped into per-month plans with checkable items. Past months can't be stamped; archive locks a month read-only.
- **Spending** — stub. Plan 4 turns this into Danske-CSV-driven retrospective analysis + the merchant-rules engine + put-aside envelopes.
- **Net Worth** — live. Manually-entered balances per wealth account, total-over-time chart, composition donut, period deltas, global Total/Liquid toggle.
- **Settings** — live. Sign in/out, theme toggle, accounts CRUD, categories CRUD. Merchant rules + envelopes managers wait for Plans 4 & 5.

## Account kinds

Three flavors on the `accounts` table (`kind` column):

- **`spending`** — daily account where salary lands and outflows depart. CSV-imported (Plan 4). Has the monthly budget. **Not** counted in net worth.
- **`put_aside`** — pre-allocated cash earmarked for irregular bills. CSV-imported, has envelopes (Plan 5). **Not** counted in net worth — committed, not wealth.
- **`wealth`** — accumulating assets (bank savings, brokerage, crypto, precious metals, pension). **Counts** toward net worth.

The distinction is "wealth vs. money-in-transit." `asset_class` is set ONLY on `wealth` accounts (NULL otherwise), enforced by a DB CHECK constraint + Pydantic validator. Values: `Cash`, `Stocks`, `Crypto`, `Precious Metals`, `Pension`, `Other`.

## Net Worth

- **Source set**: only `kind = 'wealth'` accounts. Spending and put-aside balances are explicitly excluded from the math.
- **Balance entries**: `balance_entries(account_id, entry_date, value_dkk, source)`. Unique on `(account_id, entry_date)` so re-saving on a date is an upsert. `source` is `'manual'` (Plan 2) or `'csv_import'` (Plan 4, ignored for net-worth math). NW(D) = Σ latest `value_dkk` per wealth account on or before D.
- **First-entry cutoff invariant.** Once an account has any balance entry, `POST /accounts/{id}/balance` rejects `entry_date` earlier than the existing minimum with `400 before_earliest_entry`. Frontend mirrors this by locking the date picker's `min` to the earliest entry. Keeps historical deltas anchored to a user-defined start.
- **Liquid net worth.** Pension early-withdrawal in Denmark takes a ~60% combined-tax haircut, so `liquid = total − pension_subtotal × 0.60`. The Net Worth view has a global **Total / Liquid** toggle (shown only when the portfolio contains pension holdings) that applies the haircut to the big number, the active period delta, the line chart (per-point — historical pension shifts reflected), and the composition donut. Rate lives as `_PENSION_EARLY_WITHDRAWAL_PENALTY_RATE` in `backend/app/networth.py`.
- **`/networth` payload**: composite — `total_dkk`, `liquid_dkk`, `pension_total_dkk`, `pension_haircut_rate`, sparse stepped `series` of `{date, total_dkk, liquid_dkk}` (prefix point at `range_from` + one per change-date in the range), five `deltas` (1M/3M/6M/1Y/ALL) each with `delta_dkk` + `delta_liquid_dkk` + `is_since_start` clamp, a `composition` array by asset_class, and an `accounts` array in canonical asset-class order. Empty wealth accounts are listed (so the user can add a first balance) but excluded from totals + composition.
- **Charts**: Chart.js v4.4.0 UMD pinned via CDN — matches gold-bar. Main chart is a stepped area line; composition is a doughnut. Each chart instance is `.destroy()`ed before re-creation to avoid leaks.

## Budget

- **Template = one draft + N versions.** All in `budget_templates` keyed by `(user_id, status)` where status is `'draft'` or `'version'`. Exactly one `'draft'` per user (partial unique index). Snapshots deep-copy categories + items into a new `'version'` row — versions are read-only.
- **Monthly plan = deep copy of the draft at stamp time.** `budget_months` + `budget_month_categories` + `budget_month_items` are completely independent of the template after stamping. Editing the template never bleeds into stamped months; editing a month never touches the template.
- **Items model.** Each category contains named items; the category's planned total = sum of its items. No category-level planned amount stored. Free-form spend = items added on the fly via `POST /budget/months/.../items` (with `already_paid` for the "log a single expense now" path).
- **Tick lifecycle.** Each item has `planned_dkk`, `remaining_dkk`, `ticked_at`. Item is done iff `ticked_at IS NOT NULL OR remaining_dkk <= 0`. PATCH semantics — `{ticked: true}` zeroes remaining (paid in full); `{ticked: false}` restores remaining to planned BUT only when `ticked_at` was set (no-op untick on an open row leaves a partial-pay value alone); explicit `remaining_dkk` always wins over the implicit zero/restore.
- **Past-month gate.** `POST .../stamp` rejects `(year, month) < (today.year, today.month)` with `400 cannot_stamp_past_month`. Frontend hides the Stamp button on past months.
- **Archive = the only freeze.** Archive locked until every item is done (`409 not_fully_ticked`); archived months reject every mutating endpoint with `409 month_archived`; unarchive always allowed. No calendar-based freeze.
- **Category color uniqueness.** `UNIQUE(user_id, color)` partial index on `categories`. The color picker hides already-taken hues; backend surfaces `409 color_taken` if the constraint fires anyway.
- **Multi-select pickers.** Adding categories to a month or template goes through one shared dialog (checkbox list + single Add button). Per-category POSTs in `Promise.allSettled` so partial success still lands; toast summarizes (`"3 added · 1 already in this month"`).

## Auth

Magic-link → opaque session bearer tokens in `localStorage` (`net-tracker.session-token`). Sliding 90-day TTL with a 1h `last_seen_at` debounce. No public `X-API-Key` layer — nothing in this app is shared. Magic-link tokens are SHA-256 hashed at rest, 15-min TTL, single-use, rate-limited (3/10min per email, 30/hour per IP). Email transport: Resend; `MAGIC_LINK_DEV_PRINT=1` logs to stdout in local dev instead of sending.

## Theme

- Accent: saturated emerald (`#16a34a` light / `#22c55e` dark) with `#34d399` for gradients and active states.
- Dark base: cooler near-black (`#0d1117` / `#161c24` surfaces) — distinct from gold-bar's warm grey-black.
- Affirmative buttons paint a subtle green gradient + inset highlight + small glow. `dialog menu button[value="save"]` and `.btn-primary` are affirmative; everything else is neutral.
- Menu icons are inline SVG (Lucide-style strokes), not Unicode glyphs — Unicode chars drift across systems.
- Header title and drawer brand both say "Net Tracker" (green gradient).
- Date format site-wide: `DD-MM-YYYY` (and `DD-MM-YYYY HH:MM` for timestamps).

### Custom UI primitives (`frontend/shared/`)

- `dropdown.js::createDropdown(...)` — themed `<select>` replacement. Click-outside / Esc close.
- `datepicker.js::createDatePicker(...)` — themed calendar popup replacing `<input type="date">`. Monday-first, prev/next month, max/min bounds, keyboard nav (arrows ±1/±7 days, PageUp/Down ±1 month, Enter to commit), Today shortcut.
- `datepicker.js::createMonthPicker(...)` — month-only variant used by the Budget month nav. Same trigger styling; popup shows 12 months in a 3×4 grid; prev/next shifts the year. Value shape `"yyyy-mm"`.
- `color-picker.js::createColorPicker(...)` + exported `PALETTE` — popup-style picker with 24-hue palette. `takenColors` hides already-used hues. Use the inline-grid pattern (24px square cells, `aspect-ratio: 1`) inside dialogs instead of nesting another popup.
- `ui.js::confirmPrompt({title, message, okLabel, danger})` — themed `<dialog>` confirmation. Returns `Promise<boolean>`. `danger: true` paints the affirmative red — **don't use it on net-tracker**; user preference is "no red default buttons" (red-on-hover for delete icon buttons is fine).
- `ui.js::withBusyButton(btn, busyLabel, fn)` — see UI/UX rules below.
- `ui.js::friendlyError(err, fallbackPrefix)` — see UI/UX rules below.
- `ui.js::openDialog(id)` / `blurAutoFocusedInDialog(dlg)` — see UI/UX rules below.
- `view-loading.js::paintViewLoading(rootEl, _label)` / `paintViewError(rootEl, message)` — spinner-card pattern with the unified "Connecting…" copy across views (label arg accepted but ignored). Painted on first visit so a Render cold-start never leaves a blank page; skipped on re-renders (use `root.firstElementChild` as the sentinel) so Add/Delete don't blink.

## UI/UX rules

- **Busy buttons.** Any button that fires a backend call MUST switch to disabled + a verb-form busy label (`"Adding…"`, `"Saving…"`, `"Sending…"`, `"Deleting…"`) for the duration and restore on completion. Use `withBusyButton()` — don't roll the disable/restore manually. Reason: a double-tap fires two POSTs and surfaces a confusing duplicate-name error from the second one.
- **No backend leakage in user-facing errors.** Never show raw backend codes, SQL constraint names, Python field names, HTTP methods/paths, or status codes to the user. Route every API error through `friendlyError(err, fallbackPrefix)`. To add a new code: define the snake_case `detail` string in `backend/app/<module>.py`, then add the user-facing copy to `_ERROR_MESSAGES` in `shared/ui.js`. Unknown codes (incl. 500s / network errors) get the per-callsite `"{prefix}. Please try again."` fallback automatically.
- **No auto-focus ring on dialog open.** `<dialog>.showModal()` auto-focuses the first focusable child, and iOS Safari paints that as `:focus-visible`. Every `showModal()` call must follow with `blurAutoFocusedInDialog(dlg)` from `shared/ui.js`. `openDialog()` and `confirmPrompt()` already do this; bespoke open flows that call `dlg.showModal()` directly need the helper too.
- **Icon-button family.** Use `.budget-icon-btn` for per-row affordances (28×28 square, transparent at rest, green-accent border on hover). For destructive icon buttons add `.budget-icon-btn-danger` — that variant paints red ONLY on hover (color + border + soft red wash). Same family is used by Net Worth's account-history dialog (`.ah-action-btn` / `.ah-action-danger`). Don't reintroduce ad-hoc per-row buttons.
- **Multi-select dialog content is recreated each open.** The category-picker dialog (and the edit-category dialog) blow away their innerHTML on each open and use `el.onclick = …` (not `addEventListener`) to wire handlers — prevents listener accumulation across re-opens. The `ensureDialog` helper caches the wrapper element only.
- **Keyboard activation on `role="button"` / `role="link"` divs.** Any non-`<button>` clickable that uses a role attribute MUST be reachable via Enter / Space. `installBudgetClickHandler` already delegates keydown for elements with `data-budget-action`; bespoke handlers need to follow suit.

## Conventions

- **Currency: DKK only at MVP.** No foreign-currency handling.
- **Numbers:** display uses dots only (`12.345 dkk`, never commas). Danish parsing rules for CSV (Plan 4) — dot thousands, comma decimal.
- **Date format:** `DD-MM-YYYY` in the UI; ISO in API + DB.
- **Schema bootstrap:** `db.py::SCHEMA_SQL` runs idempotently on every backend boot. All migrations are inline `DROP CONSTRAINT IF EXISTS` → `UPDATE` → `ADD CONSTRAINT` blocks, safe to re-run.

## What MVP intentionally excludes

- No automatic / ML categorization — all rules are deterministic substring matches, user-confirmed (Plan 4).
- No cron jobs (no QStash). Everything user-initiated.
- No multi-currency, no automated bank API, no alerts beyond magic-link sign-in.
- No cross-coupling between Budget ticks and Spending CSV rows — they share categories, nothing else.
- No stamping past months — only current calendar month and future are stampable.
- No re-stamp / overwrite-stamp — once a `(year, month)` is stamped, it's independent. Deferred to a future plan if needed.
- No "restore from version" on template snapshots — version history is read-only inspection only.

## Local dev

```bash
# One-time backend setup
cd backend
python -m venv .venv && source .venv/Scripts/activate    # Windows bash
pip install -r requirements-dev.txt
docker compose up -d                                     # local Postgres on :5434
```

### Dev-spinup skill (preferred)

```bash
python scripts/dev_up.py     # Postgres + backend (:8000) + frontend (:5500) + pre-auth'd session
python scripts/dev_down.py   # kill backend + frontend; leaves Postgres running for fast restart
```

`dev_up.py` opens the browser at `/dev-login.html?token=<session>` so you arrive on the app already signed in as `dev@local.com`. The `dev-spinup` skill (`.claude/skills/dev-spinup/SKILL.md`) covers natural-language triggers: "start dev", "spin up", "tear down", "I'm done".

## Verification

```bash
# From backend/:
ruff check app tests
mypy app
pytest tests/ -v
```

CI (`.github/workflows/tests.yml`) runs all three on push/PR to `main` against a Postgres-16 sidecar container. The suite covers auth, accounts, categories (incl. color uniqueness), balance entries, net-worth math + endpoint, db migrations, and the full Budget surface (template lifecycle, stamp, item PATCH matrix, archive guard, cross-user isolation).
