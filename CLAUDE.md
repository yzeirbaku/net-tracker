# net-tracker — Claude guide

Personal-finance PWA. Single-user, magic-link auth. Two live subsystems (Budget / Net Worth) + a Home dashboard, all sharing a single category taxonomy. Stack modeled on `gold-bar-tracker` (sibling repo) — FastAPI behind Caddy on an Oracle Cloud Always-Free VM, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, Resend for magic-link email.

**Plans 1, 2, 3 + Home dashboard shipped** (auth, accounts/categories CRUD, Net Worth, Budget, Home). Plan 5 (Envelopes) is not built; Plan 4 (Spending/CSV) was scrapped — see `docs/superpowers/specs/2026-05-21-home-dashboard-design.md` for the cleanup. Original design lives in `docs/superpowers/specs/2026-05-18-net-tracker-design.md`; the Plan 3 spec is `docs/superpowers/specs/2026-05-20-budget-plan-3-design.md`.

## Git

All commits in this repo must be authored as `yzeirbaku@hotmail.com` (name: `Yzeir Baku`). Already set in the local config — verify with `git config user.email` before committing if anything looks off. Co-author trailers from Claude Code are fine; the *author* must remain the hotmail address.

## Four views

Side-drawer nav, same shell pattern as gold-bar-tracker:

- **Home** — daily landing screen. Hero tile (net worth headline, EUR readout, 1M delta, 30-day sparkline) + composition strip (asset-class stacked bar with legend) + current-month budget tile (free money, gradient progress, ticked counts) + next-up tile (3 largest unticked items). All tiles are read-only — taps deep-link to the source view. Composes `/networth?range_from=today-30d` and `/budget/months/{ym}` in parallel; no Home-specific backend code.
- **Budget** — live. Persistent template (one draft + N labelled snapshots) stamped into per-month plans with checkable items. Past months can't be stamped; archive locks a month read-only. CSV-export icon in the month-nav row builds a UTF-8-with-BOM CSV in the browser from the already-loaded payload. Template editor has its own download / upload icon pair (`Category, Item, Planned (dkk)` columns plus a `Salary,,N` meta row) — upload replaces the draft after a confirm prompt, rejects unknown category names, and leaves the Save button as the commit step.
- **Net Worth** — live. Manually-entered balances per wealth account, total-over-time chart, composition donut, period deltas, global Total/Liquid/No-pension toggle. Toggle choice persists across reloads under `localStorage["net-tracker.networth.view-mode"]` and Home's hero + composition strip reflect it.
- **Settings** — live. Sign in/out, theme toggle, accounts CRUD, categories CRUD.

(Spending was a planned fifth view — Plan 4 / Danske CSV / merchant-rules. Cancelled. Menu entry, view section, and `frontend/spending.js` were deleted; the `kind = 'spending'` account flavor stays in the schema since it's still relevant to net-worth exclusion logic.)

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
- **Liquid net worth.** Pension early-withdrawal in Denmark takes a ~60% combined-tax haircut, so `liquid = total − pension_subtotal × 0.60`. The Net Worth view has a global **Total / Liquid / No pension** toggle (shown only when the portfolio contains pension holdings) that applies the chosen treatment to the big number, the active period delta, the line chart (per-point — historical pension shifts reflected), and the composition donut. **No pension** drops the Pension slice entirely and renormalizes percentages. Pension at any historical point is derivable from the existing `(total, liquid)` pair via `pension = (total − liquid) / haircut_rate`, so the No-pension view requires no extra backend fields. Rate lives as `_PENSION_EARLY_WITHDRAWAL_PENALTY_RATE` in `backend/app/networth.py`.
- **EUR readout.** A supplementary `≈ X eur` line sits directly under the headline DKK total (muted color, no green gradient, 0.95rem) for users who think in euros. Conversion uses the ERM II central peg `7.46038 DKK/EUR` hardcoded as `DKK_TO_EUR_RATE` in `frontend/networth.js`; daily drift is ±2.25% so a static rate is fine for a glanceable conversion. Storage and math stay DKK-only — this is display sugar.
- **`/networth` payload**: composite — `total_dkk`, `liquid_dkk`, `pension_total_dkk`, `pension_haircut_rate`, sparse stepped `series` of `{date, total_dkk, liquid_dkk}` (prefix point at `range_from` + one per change-date in the range), five `deltas` (1M/3M/6M/1Y/ALL) each with `delta_dkk` + `delta_liquid_dkk` + `is_since_start` clamp, a `composition` array by asset_class, and an `accounts` array in canonical asset-class order. Empty wealth accounts are listed (so the user can add a first balance) but excluded from totals + composition.
- **Charts**: Chart.js v4.4.0 UMD pinned via CDN — matches gold-bar. Main chart is a stepped area line; composition is a doughnut. Each chart instance is `.destroy()`ed before re-creation to avoid leaks.

## Budget

- **Template = one draft + N versions.** All in `budget_templates` keyed by `(user_id, status)` where status is `'draft'` or `'version'`. Exactly one `'draft'` per user (partial unique index). Snapshots deep-copy categories + items into a new `'version'` row — versions are read-only.
- **Monthly plan = deep copy of the draft at stamp time.** `budget_months` + `budget_month_categories` + `budget_month_items` are completely independent of the template after stamping. Editing the template never bleeds into stamped months; editing a month never touches the template.
- **Items model.** Each category contains named items; the category's planned total = sum of its items. No category-level planned amount stored. Free-form spend = items added on the fly via `POST /budget/months/.../items`. (The endpoint still accepts `already_paid` for backwards compatibility, but the frontend dialog no longer offers it — add the item, then tick it.)
- **Tick lifecycle.** Each item has `planned_dkk`, `remaining_dkk`, `ticked_at`. Item is done iff `ticked_at IS NOT NULL OR remaining_dkk <= 0`. PATCH semantics — `{ticked: true}` zeroes remaining (paid in full); `{ticked: false}` restores remaining to planned BUT only when `ticked_at` was set (no-op untick on an open row leaves a partial-pay value alone); explicit `remaining_dkk` always wins over the implicit zero/restore.
- **Past-month gate.** `POST .../stamp` rejects `(year, month) < (today.year, today.month)` with `400 cannot_stamp_past_month`. Frontend hides the Stamp button on past months.
- **Archive = the only freeze.** Archive locked until every item is done (`409 not_fully_ticked`); archived months reject every mutating endpoint with `409 month_archived`; unarchive always allowed. No calendar-based freeze.
- **Category color uniqueness.** `UNIQUE(user_id, color)` partial index on `categories`. The color picker hides already-taken hues; backend surfaces `409 color_taken` if the constraint fires anyway.
- **Multi-select pickers.** Adding categories to a month or template goes through one shared dialog (checkbox list + single Add button). Per-category POSTs in `Promise.allSettled` so partial success still lands; toast summarizes (`"3 added · 1 already in this month"`).
- **Sort behavior.** Single shared preference in `localStorage` (`net-tracker.budget.sort`, values `amount` / `alpha`) drives two flows. Month view: a slim pill dropdown under the salary panel applies the sort *for display* via `sortedMonth()`, leaving server-side `sort_order` alone. Template editor: `applyDraftSort()` bakes the same preference *destructively* into the draft at Save / Save new version time so every future stamp lands in that order. Editing in place still preserves manual insertion order — reorder only happens at the save boundary so the cursor doesn't jump.
- **Totals footer.** Month / template-editor / version views all share a `.budget-footer` block with Total planned / Salary / Free money rows (month adds Spent so far). Free money paints `.remain` green when ≥ 0, `.negative` red when below; computed inline from `templatePlannedTotal()`. Template editor refreshes the footer in place via `updateTemplateFooter()` on every salary / item-amount input so the cursor stays put.
- **Amount input formatting.** Every salary / planned / remaining input across the Budget surface is wired through `installAmountFormatter()` (in `budget.js`). It live-formats with dot-thousands as the user types and re-anchors the caret relative to typed digits; `parseAmount()` strips the dots back to a `Number` on submit. Initial values render via `formatAmountForInput()` so a 20000 salary appears as `20.000` immediately on load.
- **Collapsible categories.** Both month and template category heads collapse their bodies on click (caret flips ▾↔▸). Persisted in `state.collapsed` under different key namespaces — `<year>-<month>-<month_cat_id>` for months, `tpl-<category_id>` for the template — so the two don't collide.

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
- `view-loading.js::paintViewLoading(rootEl, _label)` / `paintViewError(rootEl, message)` — spinner-card pattern with the unified "Connecting…" copy across views (label arg accepted but ignored). Painted on first visit so a backend cold-start never leaves a blank page; skipped on re-renders (use `root.firstElementChild` as the sentinel) so Add/Delete don't blink.

## UI/UX rules

- **Busy buttons.** Any button that fires a backend call MUST switch to disabled + a verb-form busy label (`"Adding…"`, `"Saving…"`, `"Sending…"`, `"Deleting…"`) for the duration and restore on completion. Use `withBusyButton()` — don't roll the disable/restore manually. Reason: a double-tap fires two POSTs and surfaces a confusing duplicate-name error from the second one.
- **No backend leakage in user-facing errors.** Never show raw backend codes, SQL constraint names, Python field names, HTTP methods/paths, or status codes to the user. Route every API error through `friendlyError(err, fallbackPrefix)`. To add a new code: define the snake_case `detail` string in `backend/app/<module>.py`, then add the user-facing copy to `_ERROR_MESSAGES` in `shared/ui.js`. Unknown codes (incl. 500s / network errors) get the per-callsite `"{prefix}. Please try again."` fallback automatically.
- **No auto-focus ring on dialog open.** `<dialog>.showModal()` auto-focuses the first focusable child, and iOS Safari paints that as `:focus-visible`. Every `showModal()` call must follow with `blurAutoFocusedInDialog(dlg)` from `shared/ui.js`. `openDialog()` and `confirmPrompt()` already do this; bespoke open flows that call `dlg.showModal()` directly need the helper too.
- **Icon-button family.** Use `.budget-icon-btn` for per-row affordances (28×28 square, transparent at rest, green-accent border on hover). For destructive icon buttons add `.budget-icon-btn-danger` — that variant paints red ONLY on hover (color + border + soft red wash). Same family is used by Net Worth's account-history dialog (`.ah-action-btn` / `.ah-action-danger`) and the budget month-nav chevrons (`.budget-nav`, 32×32 variant). Don't reintroduce ad-hoc per-row buttons.
- **Inline SVG icons, not Unicode glyphs.** Every icon inside the icon-button family is an inline Lucide-style `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" …>` with `stroke="currentColor"` so the danger hover-color rule re-tints automatically. Sizing is centralized on `> svg` selectors in `styles.css` (~14px for the heavier delete ×, ~12–13px for the multi-stroke pencil/check/rotate, larger for `.budget-nav` chevrons and the header burger). Reason: Unicode glyphs (`✎` `×` `✓` `↺` `‹` `›` `☰`) drift in size, baseline, and centering across iOS Safari vs Chrome — SVGs render pixel-identical.
- **Hover only on pointer devices.** Every `:hover` rule on the icon-button family is wrapped in `@media (hover: hover)` so iOS Safari doesn't latch the accent border on tap and leave it "stuck." A matching `:active` rule outside the media query gives a brief tap-flash on touch (snap to accent on press, fade back over the existing 120ms `border-color` transition on release).
- **Multi-select dialog content is recreated each open.** The category-picker dialog (and the edit-category dialog) blow away their innerHTML on each open and use `el.onclick = …` (not `addEventListener`) to wire handlers — prevents listener accumulation across re-opens. The `ensureDialog` helper caches the wrapper element only.
- **Keyboard activation on `role="button"` / `role="link"` divs.** Any non-`<button>` clickable that uses a role attribute MUST be reachable via Enter / Space. `installBudgetClickHandler` already delegates keydown for elements with `data-budget-action`; bespoke handlers need to follow suit.
- **Home tiles delegate navigation via menu-item clicks.** `home.js`'s `bindHomeClickThroughs` resolves `data-home-nav="<view>"` by dispatching a synthetic click on the matching `.menu-item[data-action="<view>"]` rather than calling `showView` directly. Keeps navigation routing in one place (`app.js`).

## Conventions

- **Currency: DKK only at MVP** for storage, math, and CSV parsing. The EUR readout on Net Worth is a glanceable display conversion via a hardcoded ERM II peg — no foreign-currency handling enters the data model.
- **Numbers:** display uses dots only (`12.345 dkk`, never commas). Danish parsing rules for CSV (Plan 4) — dot thousands, comma decimal.
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

`dev_up.py` opens the browser at `/dev-login.html?token=<session>` so you arrive on the app already signed in as `dev@local.com`. The `dev-spinup` skill (`.claude/skills/dev-spinup/SKILL.md`) covers natural-language triggers: "start dev", "spin up", "tear down", "I'm done".

Frontend port is `5510` (not VS Code Live Server's default 5500) because the sibling `gold-bar-tracker` workspace permanently occupies 5500. Windows allows two listeners on the same TCP port via `SO_REUSEADDR` but only the first-bound process accepts connections, so colliding silently broke `127.0.0.1:5500` for net-tracker. Don't change `FRONTEND_PORT` in `scripts/dev_up.py` back to 5500.

## Verification

```bash
# From backend/:
ruff check app tests
mypy app
pytest tests/ -v
```

CI (`.github/workflows/tests.yml`) runs all three on push/PR to `main` against a Postgres-16 sidecar container. The suite covers auth, accounts, categories (incl. color uniqueness), balance entries, net-worth math + endpoint, db migrations, and the full Budget surface (template lifecycle, stamp, item PATCH matrix, archive guard, cross-user isolation).

## Production deploy

- **Backend:** FastAPI in Docker on an **Oracle Cloud Always-Free VM** (Ubuntu 24.04, AMD E2.1.Micro, Frankfurt), fronted by **Caddy** with auto-renewing Let's Encrypt TLS. Public URL: `https://yzeir-net.duckdns.org` (DuckDNS free dynamic-DNS pointing at the VM's static public IP).
- **Frontend:** Cloudflare Pages at `https://net-tracker.pages.dev`. `BACKEND_URL` env var is read at build time and written into `frontend/config.js`. The CSP `connect-src` allowlist in `frontend/_headers` MUST include the backend host — update both env var and CSP if the host ever changes.
- **DB:** Neon Postgres (separate DB from gold-bar-tracker).
- **Email:** Resend.
- **Schema migrations:** `db.py::SCHEMA_SQL` runs idempotently on every backend boot, so deploys apply schema changes automatically — no manual step.
- **Deploy = `git pull` on the VM + `docker compose up -d --build`.** Use the **`deploy` skill** (`.claude/skills/deploy/SKILL.md`) — natural-language triggers: "deploy", "ship it", "deploy net-tracker". The skill reads VM connection details from the gitignored `.claude/skills/deploy/deploy.env.local` (template inside the SKILL.md "Setup" section). Pre-flight: code must be pushed to `origin/main` first.
- **VM-local files (not in this repo):** `Dockerfile` (in `repo/backend/`), `docker-compose.yml`, `Caddyfile`, `.env`. Reconstruct from the SKILL.md if the VM is ever recreated.
- **Secret rotation:** SSH in, edit `~/apps/net-tracker/.env`, then `sudo docker compose up -d --force-recreate backend`. The deploy skill does NOT touch `.env`.
