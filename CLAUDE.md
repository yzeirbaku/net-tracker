# net-tracker — Claude guide

Personal-finance PWA. Single-user, magic-link auth. Three live subsystems (Budget / Net Worth / Put Aside) + a Home dashboard, all sharing a single category taxonomy. Stack modeled on `gold-price-tracker` (sibling repo) — FastAPI behind Caddy on an Oracle Cloud Always-Free VM, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, Resend for magic-link email.

Shipped: auth, accounts/categories CRUD, Net Worth, Budget, Put Aside, Home dashboard. Spending/CSV (the originally planned fifth view) was scrapped; the `spending` + `put_aside` *account kinds* remain in the schema but aren't user-facing today — the Put Aside view uses its own `put_aside_items` table, not the `accounts` table.

## Git

All commits in this repo must be authored as `yzeirbaku@hotmail.com` (name: `Yzeir Baku`). Already set in the local config — verify with `git config user.email` before committing if anything looks off. Co-author trailers from Claude Code are fine; the *author* must remain the hotmail address.

## Views

Side-drawer nav, same shell pattern as gold-price-tracker:

- **Home** — daily landing screen. Read-only tiles (net worth hero, composition strip, current-month budget tile, put-aside tile, next-up unticked items) composed from `/networth`, `/budget/months/{ym}`, and `/put-aside` in parallel. Taps deep-link to the source view. No Home-specific backend code.
- **Budget** — persistent template (draft + labelled snapshots) stamped into per-month plans with checkable items. Past months can't be stamped; archive locks a month read-only. Month + template both support CSV download; template editor also supports CSV upload (rejects unknown category names; Save commits).
- **Net Worth** — manually-entered balances per wealth account, total-over-time chart, composition donut, period deltas, global Total/Liquid/No-pension toggle. Toggle persists in `localStorage["net-tracker.networth.view-mode"]` and Home reflects it.
- **Put Aside** — flat list of named amounts earmarked for upcoming spend. Reachable only via the Home tile (no drawer entry, on purpose, to keep top-level nav lean). See dedicated section below.
- **Settings** — sign in/out, theme toggle, accounts CRUD, categories CRUD.

## Account kinds

Three flavors on the `accounts` table (`kind` column):

- **`wealth`** — accumulating assets (bank savings, brokerage, crypto, precious metals, pension). **Counts** toward net worth.
- **`spending`** / **`put_aside`** — schema-present but unused. The Spending/CSV view was scrapped, and the Put Aside view that shipped uses its own `put_aside_items` table — neither feature creates rows on `accounts` with these kinds. Excluded from net-worth math.

`asset_class` is set ONLY on `wealth` accounts (NULL otherwise), enforced by a DB CHECK + Pydantic validator. Values: `Cash`, `Stocks`, `Crypto`, `Precious Metals`, `Pension`, `Other`.

## Net Worth

- **Source set**: only `kind = 'wealth'` accounts. Spending and put-aside balances are explicitly excluded from the math.
- **Balance entries**: `balance_entries(account_id, entry_date, value_dkk, source)`. Unique on `(account_id, entry_date)` so re-saving on a date is an upsert. `source` is `'manual'` in practice (`'csv_import'` is a schema-only enum value left over from the scrapped CSV plan). NW(D) = Σ latest `value_dkk` per wealth account on or before D.
- **First-entry cutoff invariant.** Once an account has any balance entry, `POST /accounts/{id}/balance` rejects `entry_date` earlier than the existing minimum with `400 before_earliest_entry`. Frontend mirrors this by locking the date picker's `min` to the earliest entry. Keeps historical deltas anchored to a user-defined start.
- **Liquid net worth.** Pension early-withdrawal in Denmark takes a ~60% combined-tax haircut, so `liquid = total − pension_subtotal × 0.60`. Global **Total / Liquid / No pension** toggle (shown only when the portfolio holds pension) reshapes the headline, deltas, chart, and donut in place. Rate lives at `_PENSION_EARLY_WITHDRAWAL_PENALTY_RATE` in `backend/app/networth.py`.
- **EUR readout.** Supplementary `≈ X eur` line under the headline using the ERM II peg `7.46038 DKK/EUR` (`DKK_TO_EUR_RATE` in `frontend/networth.js`). Display sugar — storage and math stay DKK-only.
- **`/networth` payload**: composite shape with `total_dkk`, `liquid_dkk`, pension fields, sparse stepped `series`, five `deltas` (1M/3M/6M/1Y/ALL), `composition` by asset_class, and `accounts` in canonical asset-class order. Empty wealth accounts appear in `accounts` (so the user can seed a first balance) but are excluded from totals + composition. Exact field list in `backend/app/networth.py`.
- **Charts**: Chart.js v4.4.0 UMD via CDN. `.destroy()` every instance before re-creation to avoid leaks.

## Budget

- **Template = one draft + N versions.** All in `budget_templates` keyed by `(user_id, status)` where status is `'draft'` or `'version'`. Exactly one `'draft'` per user (partial unique index). Snapshots deep-copy categories + items into a new `'version'` row — versions are read-only.
- **Monthly plan = deep copy of the draft at stamp time.** `budget_months` + `budget_month_categories` + `budget_month_items` are completely independent of the template after stamping. Editing the template never bleeds into stamped months; editing a month never touches the template.
- **Items model.** Each category contains named items; the category's planned total = sum of its items. No category-level planned amount stored. Free-form spend = items added on the fly via `POST /budget/months/.../items`. The endpoint still accepts `already_paid` for backwards compatibility; the frontend no longer sends it (add the item, then tick it).
- **Tick lifecycle.** Each item has `planned_dkk`, `remaining_dkk`, `ticked_at`. Done iff `ticked_at IS NOT NULL OR remaining_dkk <= 0`. PATCH: `{ticked: true}` zeroes remaining; `{ticked: false}` restores remaining to planned only when `ticked_at` was set (no-op untick on a partial-pay row leaves it alone); explicit `remaining_dkk` always wins over the implicit zero/restore.
- **Past-month gate.** `POST .../stamp` rejects `(year, month) < (today.year, today.month)` with `400 cannot_stamp_past_month`. Frontend hides the Stamp button on past months.
- **Archive = the only freeze.** Archive locked until every item is done (`409 not_fully_ticked`); archived months reject every mutating endpoint with `409 month_archived`; unarchive always allowed. No calendar-based freeze.
- **Archive `Saved` column.** `BudgetMonthSummary.saved_total_dkk` (computed in `/budget/months` SQL): sum of ticked spend (`planned − remaining`) on items whose category name is `LOWER(name) IN ('investment','investments','saving','savings')`. Hardcoded names — promote to a per-category flag the moment a second pair of names is needed. The old `planned − spent` formula was always 0 (archive requires every item ticked → spent = planned).
- **Category color uniqueness.** `UNIQUE(user_id, color)` partial index on `categories`. The color picker hides already-taken hues; backend surfaces `409 color_taken` if the constraint fires anyway.
- **Multi-select pickers.** Adding categories to a month or template goes through one shared dialog (checkbox list + single Add button). Per-category POSTs in `Promise.allSettled` so partial success still lands; toast summarizes (`"3 added · 1 already in this month"`).
- **Sort behavior.** Shared `localStorage` preference (`net-tracker.budget.sort`, `amount` / `alpha`). Month view applies it for display only (`sortedMonth()`, server `sort_order` untouched). Template editor bakes it destructively into the draft on Save via `applyDraftSort()` so future stamps inherit the order. Reorder only happens at the save boundary — typing into the inline editor never jumps the cursor.
- **Totals footer.** Shared `.budget-footer` across month, template-editor, and version views: Total planned / Salary / Free money (month adds Spent so far, plus an Income row when `extra_income_name` is set). Free money = `(salary + extra_income_dkk) − planned`; green when ≥ 0, red below. Template editor uses `updateTemplateFooter()` to refresh in place without losing the input caret.
- **Extra income (per-month, optional).** `budget_months` carries a single nullable `extra_income_name` / `extra_income_dkk` pair — a one-off line for bonuses, refunds, gifts, etc. UI surfaces a `+ Add income` link under Salary when unset; once set, the row sits beside Salary with edit + delete affordances. `PUT /budget/months/{y}/{m}/extra-income` sets/overwrites, `DELETE` clears. Counted with Salary in the Free-money math and emitted as an `Income,<name>,<amount>,…` row in the month CSV (always sits below the `Salary,"",<amount>` meta row at the top of the file). Single item only — a future change can table-ify if you need multiple.
- **Amount input formatting.** Every monetary input (budget, template, salary, extra income, net-worth balance entries) is wired through `installAmountFormatter()` (in `budget-common.js`): live dot-thousands as the user types, caret preserved. `parseAmount()` strips dots on submit; `formatAmountForInput()` renders initial values.
- **Collapsible categories.** Both month and template category heads toggle on click (▾↔▸), persisted under separate `localStorage` namespaces so month and template collapsed-state don't collide.

## Put Aside

- **Purpose.** Money "parked" for an upcoming spend (e.g. car insurance due in 3 months, summer vacation in 6). The list IS the current state — no dates, no categories, no history, no per-item due reminders. Add when you decide to set money aside; delete when you actually spend it.
- **Data model.** `put_aside_items(id, user_id, name, amount_dkk, created_at, updated_at)`. One global list per user — no account abstraction, no buckets. CHECK constraint enforces `amount_dkk >= 0`.
- **Independent from the `put_aside` *account kind*.** The `accounts.kind` value `'put_aside'` still exists in the schema but is unused; the Put Aside view does not touch the `accounts` table.
- **Excluded from net worth math.** Same rule as before — only `kind = 'wealth'` accounts feed `/networth`. Put-aside money is budgeting state, not wealth.
- **Sort order.** `amount_dkk DESC, created_at ASC` everywhere. The tiebreaker on `created_at` is load-bearing: the Home tile slices the top 3 by amount, and without it equal-amount rows would flicker between renders.
- **API** (`/put-aside`):
  - `GET /put-aside` → `{total_dkk, items: [...]}`
  - `POST /put-aside/items` body `{name, amount_dkk}`
  - `PUT /put-aside/items/{id}` body `{name?, amount_dkk?}` — empty body is a no-op (keeps both fields)
  - `DELETE /put-aside/items/{id}`
- **No drawer entry — Home tile is the only entrypoint.** A `<button data-action="put-aside" hidden>` lives in `index.html` so `bindHomeClickThroughs()` can keep dispatching synthetic menu-item clicks the same way it does for every other tile (navigation routing stays centralized in `app.js`). Hamburger always works to navigate back to Home.
- **Home tile** sits between the Budget tile and Next-up: header `Put aside`, total, then up to 3 item rows (name + amount). Empty state shows `0 dkk · Nothing set aside yet` — tile always visible so the user can tap through to add the first item.

## Auth

Magic-link → opaque session bearer tokens in `localStorage` (`net-tracker.session-token`). Sliding 90-day TTL with a 1h `last_seen_at` debounce. No public `X-API-Key` layer — nothing in this app is shared. Magic-link tokens are SHA-256 hashed at rest, 15-min TTL, single-use, rate-limited (3/10min per email, 30/hour per IP). Email transport: Resend; `MAGIC_LINK_DEV_PRINT=1` logs to stdout in local dev instead of sending.

## Theme

- Accent: saturated emerald (`#16a34a` light / `#22c55e` dark) with `#34d399` for gradients and active states.
- Dark base: cooler near-black (`#0d1117` / `#161c24` surfaces) — distinct from gold-price's warm grey-black.
- Affirmative buttons paint a subtle green gradient + inset highlight + small glow. `dialog menu button[value="save"]` and `.btn-primary` are affirmative; everything else is neutral.
- Menu icons are inline SVG (Lucide-style strokes), not Unicode glyphs — Unicode chars drift across systems.
- Header title and drawer brand both say "Net Tracker" (green gradient).
- Date format site-wide: `DD-MM-YYYY` (and `DD-MM-YYYY HH:MM` for timestamps).

### Custom UI primitives (`frontend/shared/`)

- `dropdown.js::createDropdown(...)` — themed `<select>` replacement. Click-outside / Esc close.
- `datepicker.js::createDatePicker(...)` — themed calendar popup replacing `<input type="date">`. Monday-first, prev/next month, max/min bounds, keyboard nav (arrows ±1/±7 days, PageUp/Down ±1 month, Enter to commit), Today shortcut.
- `datepicker.js::createMonthPicker(...)` — month-only variant used by the Budget month nav. Same trigger styling; popup shows 12 months in a 3×4 grid; prev/next shifts the year. Value shape `"yyyy-mm"`.
- `color-picker.js::createColorPicker(...)` + exported `PALETTE` — popup-style picker with 24-hue palette. `takenColors` hides already-used hues. Use the inline-grid pattern (24px square cells, `aspect-ratio: 1`) inside dialogs instead of nesting another popup.
- `ui.js::confirmPrompt({title, message, okLabel, danger})` — themed `<dialog>` confirm. Returns `Promise<boolean>`. **Don't pass `danger: true`** — net-tracker has no red default buttons (red-on-hover for delete icons is fine).
- `ui.js::withBusyButton(btn, busyLabel, fn)` / `friendlyError(err, fallbackPrefix)` / `openDialog(id)` / `blurAutoFocusedInDialog(dlg)` — see UI/UX rules below.
- `view-loading.js::paintViewLoading(rootEl, _label)` / `paintViewError(rootEl, message)` — spinner-card with unified "Connecting…" copy. Painted on first visit so a backend cold-start doesn't leave a blank page; skipped on re-renders (uses `root.firstElementChild` as the sentinel) so Add/Delete don't blink.

## UI/UX rules

- **Busy buttons.** Any button that fires a backend call MUST switch to disabled + a verb-form busy label (`"Adding…"`, `"Saving…"`, `"Sending…"`, `"Deleting…"`) for the duration and restore on completion. Use `withBusyButton()` — don't roll the disable/restore manually. Reason: a double-tap fires two POSTs and surfaces a confusing duplicate-name error from the second one.
- **No backend leakage in user-facing errors.** Never show raw backend codes, SQL constraint names, Python field names, HTTP methods/paths, or status codes to the user. Route every API error through `friendlyError(err, fallbackPrefix)`. To add a new code: define the snake_case `detail` string in `backend/app/<module>.py`, then add the user-facing copy to `_ERROR_MESSAGES` in `shared/ui.js`. Unknown codes (incl. 500s / network errors) get the per-callsite `"{prefix}. Please try again."` fallback automatically.
- **No auto-focus ring on dialog open.** `<dialog>.showModal()` auto-focuses the first focusable child, and iOS Safari paints that as `:focus-visible` — leaving the accent border on the input/checkbox until the user taps elsewhere. Sync `.blur()` after `showModal` isn't fast enough on iOS, so `shared/ui.js::showDialog(dlg)` injects an invisible `<button autofocus>` ("focus absorber") as the dialog's first child so `showModal` lands focus there instead of on the visible field, then blurs the absorber sync + rAF. Use `showDialog(dlg)` everywhere — `openDialog()` and `confirmPrompt()` already do; bespoke open flows must use it instead of calling `dlg.showModal()` directly. `blurAutoFocusedInDialog` still exists as a smaller helper but `showDialog` is the right entry point.
- **Icon-button family.** Use `.budget-icon-btn` for per-row affordances (28×28, transparent at rest, green-accent border on hover). Destructive variant: `.budget-icon-btn-danger` (red on hover only). Same family covers Net Worth's account-history dialog (`.ah-action-btn` / `.ah-action-danger`) and the budget month-nav chevrons (`.budget-nav`, 32×32). Don't reintroduce ad-hoc per-row buttons.
- **Inline SVG icons, not Unicode glyphs.** Every icon-button uses an inline Lucide-style `<svg stroke="currentColor" …>` so the hover-color rule re-tints automatically. Sizing centralized on `> svg` selectors in `styles.css`. Reason: Unicode glyphs drift in size and baseline across iOS Safari vs Chrome — SVGs render pixel-identical.
- **Hover only on pointer devices.** Every `:hover` on the icon-button family is wrapped in `@media (hover: hover)` so iOS Safari doesn't latch the accent border after a tap. A matching `:active` rule outside the media query gives a brief tap-flash on touch.
- **Multi-select dialog content is recreated each open.** The category-picker dialog (and the edit-category dialog) blow away their innerHTML on each open and use `el.onclick = …` (not `addEventListener`) to wire handlers — prevents listener accumulation across re-opens. The `ensureDialog` helper caches the wrapper element only.
- **Keyboard activation on `role="button"` / `role="link"` divs.** Any non-`<button>` clickable that uses a role attribute MUST be reachable via Enter / Space. `installBudgetClickHandler` already delegates keydown for elements with `data-budget-action`; bespoke handlers need to follow suit.
- **Home tiles delegate navigation via menu-item clicks.** `home.js`'s `bindHomeClickThroughs` resolves `data-home-nav="<view>"` by dispatching a synthetic click on the matching `.menu-item[data-action="<view>"]` rather than calling `showView` directly. Keeps navigation routing in one place (`app.js`).

## Conventions

- **Currency: DKK only** for storage and math. The Net Worth EUR readout is a display-only conversion via the ERM II peg — no foreign-currency handling enters the data model.
- **Numbers:** display uses dots only (`12.345 dkk`, never commas).
- **Date format:** `DD-MM-YYYY` in the UI; ISO in API + DB.
- **Schema bootstrap:** `db.py::SCHEMA_SQL` runs idempotently on every backend boot. All migrations are inline `DROP CONSTRAINT IF EXISTS` → `UPDATE` → `ADD CONSTRAINT` blocks, safe to re-run.

## What MVP intentionally excludes

- No cron jobs, multi-currency, automated bank APIs, or alerts beyond magic-link sign-in. Everything user-initiated.
- No stamping or re-stamping past months. Once `(year, month)` is stamped, it's independent of the template — overwrite/restore is deferred to a future plan.
- No "restore from version" on template snapshots — version history is read-only inspection.

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
python scripts/dev_up.py     # Postgres + backend (:8000) + frontend (:5510) + pre-auth'd session
python scripts/dev_down.py   # kill backend + frontend; leaves Postgres running for fast restart
```

`dev_up.py` opens the browser at `/dev-login.html?token=<session>` so you arrive already signed in as `dev@local.com`. The `dev-spinup` skill (`.claude/skills/dev-spinup/SKILL.md`) covers natural-language triggers: "start dev", "spin up", "tear down".

Frontend port is `5510`, not 5500 — sibling `gold-price-tracker` occupies 5500. Don't change `FRONTEND_PORT` in `scripts/dev_up.py`.

## Verification

```bash
# From backend/:
ruff check app tests
mypy app
pytest tests/ -v
```

CI (`.github/workflows/tests.yml`) runs all three on push/PR to `main` against a Postgres-16 sidecar container.

## Production deploy

- **Backend:** FastAPI in Docker on an **Oracle Cloud Always-Free VM** (Ubuntu 24.04, AMD E2.1.Micro, Frankfurt), fronted by **Caddy** with auto-renewing Let's Encrypt TLS. Public URL: `https://yzeir-net.duckdns.org` (DuckDNS free dynamic-DNS pointing at the VM's static public IP).
- **Frontend:** Cloudflare Pages at `https://net-tracker.pages.dev`. `BACKEND_URL` env var is read at build time and written into `frontend/config.js`. The CSP `connect-src` allowlist in `frontend/_headers` MUST include the backend host — update both env var and CSP if the host ever changes.
- **DB:** Neon Postgres (separate DB from gold-price-tracker).
- **Email:** Resend.
- **Schema migrations:** `db.py::SCHEMA_SQL` runs idempotently on every backend boot, so deploys apply schema changes automatically — no manual step.
- **Deploy = `git pull` on the VM + `docker compose up -d --build`.** Use the **`deploy` skill** (`.claude/skills/deploy/SKILL.md`) — natural-language triggers: "deploy", "ship it", "deploy net-tracker". The skill reads VM connection details from the gitignored `.claude/skills/deploy/deploy.env.local` (template inside the SKILL.md "Setup" section). Pre-flight: code must be pushed to `origin/main` first.
- **VM-local files (not in this repo):** `Dockerfile` (in `repo/backend/`), `docker-compose.yml`, `Caddyfile`, `.env`. Reconstruct from the SKILL.md if the VM is ever recreated.
- **Secret rotation:** SSH in, edit `~/apps/net-tracker/.env`, then `sudo docker compose up -d --force-recreate backend`. The deploy skill does NOT touch `.env`.
