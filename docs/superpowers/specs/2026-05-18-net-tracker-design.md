# net-tracker — design spec

**Date:** 2026-05-18
**Status:** approved, moving to implementation plan
**Author:** Yzeir + Claude (brainstorming session)

## 1. Goal

A single-user personal-finance PWA covering three things at MVP, plus a Home dashboard tying them together:

1. **Budget** — a persistent monthly-budget template that can be stamped into any month; manual checkoff of expenses against each category.
2. **Spending analysis** — import Danske Bank CSVs, categorize transactions deterministically via a merchant-rule engine, see monthly averages and trends over 1m/3m/6m/12m, manage sinking-fund envelopes on the third account.
3. **Net worth** — list of accounts grouped by asset class; per-account balance history; net-worth-over-time chart.

Modeled on the `gold-bar-tracker` stack (sibling repo): FastAPI on Render, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, magic-link auth, Resend for email. Deliberately differs in: theme (muted-green accent + cool-slate dark base), no public API-key layer (everything is per-user), no cron jobs at MVP, no foreign-currency, no auto-fetch from banks.

## 2. Scope

### In scope (MVP)

- Magic-link auth, single user, bearer-token sessions in `localStorage` (no `X-API-Key` layer).
- Five views in a side-drawer shell: Home / Budget / Spending / Net Worth / Settings.
- Three account kinds: `spending`, `savings`, `sinking_fund`.
- One shared category taxonomy across Budget and Spending.
- Budget template + per-month stamps + per-category ticks (manual expense log).
- Danske Bank CSV import (ISO-8859-1; Danish date + number formats), dedup by content hash, deterministic merchant-rule auto-categorization, grouped review queue, "Hide forever" rule, inline category creation, deposit-splitting for sinking-fund accounts.
- Envelopes on `sinking_fund` accounts (target/month, optional cadence + expected, balance from tagged transactions).
- Net-worth history via `balance_entries` (manual for `savings`, auto-upserted by CSV import for `spending`/`sinking_fund`).
- Home dashboard with four cards: this-month budget remaining, top categories last 30d, net-worth sparkline, review-queue count.
- Light/dark theme (distinct from gold-bar-tracker), `DD-MM-YYYY` date format, Danish number formatting.

### Out of scope (MVP)

- Automatic / heuristic / ML-based categorization. All categorization is substring-rule-based and user-confirmed.
- Cron jobs (no QStash). Imports are user-initiated.
- Foreign-currency support.
- Automated bank API connection — CSV upload only.
- Alerts / email notifications beyond the magic-link sign-in.
- Cross-coupling between Budget ticks and Spending CSV rows (kept independent; share categories only).
- Multi-user / sharing.
- Data export (deferred).
- "Sinking-fund health" home card (deferred — placeholder noted in code).

## 3. Architecture

```
net-tracker/
  backend/         FastAPI on Render (Python 3.12)
    app/
      main.py            FastAPI + CORS + view-thin endpoints
      db.py              asyncpg pool + idempotent SCHEMA_SQL bootstrap
      auth_session.py    magic-link issue/verify, bearer sessions, rate limit
      email.py           Resend wrapper (magic-link only at MVP)
      categories.py      taxonomy CRUD; seed defaults on first sign-in
      accounts.py        accounts CRUD; balance entries for net-worth snapshots
      envelopes.py       envelope CRUD scoped to sinking_fund accounts
      transactions.py    transaction CRUD; per-month / per-category aggregations
      csv_import.py      Danske parser; dedup hash; rule application; review-queue endpoints
      rules.py           merchant rules CRUD; pattern matching engine
      budget.py          template CRUD + monthly-plan CRUD + stamp + ticks
      networth.py        balance-entry CRUD; net-worth-over-time series + composition
      home.py            assembles the four home cards into one composite response
    scripts/
      seed.py            local-only: synthetic categories, template, 3 months of transactions, net worth history
    tests/
      unit/              parser, dedup, rule matching, balance math, envelope math
      api/               FastAPI routes against real Postgres
  frontend/        Static PWA on Cloudflare Pages (vanilla JS, ES modules, no build)
    index.html         side drawer (Home / Budget / Spending / Net Worth / Settings) + dialogs
    app.js             shell + drawer + auth + tab routing (module entry)
    home.js            four home cards
    budget.js          template editor + monthly plan + tick UI + stamp dialogs
    spending.js        account filter + transaction table + review queue + envelope panel
    networth.js        accounts list + per-account history + composition + net-worth chart
    settings.js        theme toggle, sign in/out, manage rules, manage categories, manage envelopes
    shared/
      api.js           fetch wrapper with bearer-token injection + 401 handling
      auth.js          localStorage session, login/logout flows
      fmt.js           DKK / date / percent formatters (Danish locale; DD-MM-YYYY)
      ui.js            dialog helpers, toast, confirm
    styles.css         green accent + distinct cool-slate dark theme
    service-worker.js  minimal (iOS install only, no caching)
    manifest.webmanifest
    _headers           CSP + cache directives
  docker-compose.yml   local Postgres on port 5434 (avoid 5433 clash with gold-bar-tracker)
  docs/
    superpowers/
      specs/2026-05-18-net-tracker-design.md   (this file)
```

### Stack

| Concern | Choice |
|---|---|
| Backend | FastAPI on Render free tier (Python 3.12), asyncpg |
| Database | Neon Postgres (separate DB from gold-bar-tracker) |
| Frontend | Vanilla JS PWA on Cloudflare Pages, ES modules, no build step |
| Auth | Magic-link → opaque UUID session tokens in `localStorage` (`Authorization: Bearer`) |
| Email | Resend (magic-link only at MVP) |
| Cron | None at MVP |
| Local Postgres | Docker on port `5434` |

### Theme

- Accent: muted green family (`#4f7d5b` / `#6ba47a` range) replaces gold's warm yellow.
- Dark base: cooler near-black slate (`#0f1419` range), distinct from gold-bar-tracker's warm grey-black.
- Light theme: its own design, not a mirror of dark.
- Affirmative buttons: green gradient. Neutral buttons: subtle grey. `value="save"` inside dialogs paints affirmative.
- Date format site-wide: `DD-MM-YYYY` for dates; `DD-MM-YYYY HH:MM` for timestamps.
- Numbers: dot thousands, comma decimal in display (Danish locale).

## 4. Data model

12 tables. All include `created_at TIMESTAMPTZ DEFAULT NOW()`. All FK to `users` cascade-delete.

### Auth

- **`users`** — `id UUID PK`, `email TEXT UNIQUE NOT NULL`, `created_at`.
- **`magic_links`** — `token_hash TEXT PK` (sha256), `email`, `expires_at`, `used_at`, `created_ip`.
- **`sessions`** — `id UUID PK` (bearer token), `user_id FK`, `created_at`, `last_seen_at` (sliding 90-day TTL, 1h debounce).

### Categories

- **`categories`** — `id`, `user_id FK`, `name`, `color TEXT?`, `exclude_from_spend BOOL DEFAULT FALSE`, `sort_order INT`. `UNIQUE(user_id, name)`.

### Accounts + net-worth history

- **`accounts`** — `id`, `user_id FK`, `name`, `kind TEXT CHECK IN ('spending','savings','sinking_fund')`, `asset_class TEXT CHECK IN ('Savings','Stocks','Crypto','Gold','Pension','Other')`, `sort_order INT`. `UNIQUE(user_id, name)`.
- **`balance_entries`** — `id`, `account_id FK`, `entry_date DATE`, `value_dkk NUMERIC(14,2)`, `source TEXT CHECK IN ('manual','csv_import')`. `UNIQUE(account_id, entry_date)`.

Value source per account kind:
- `savings` → user adds entries manually.
- `spending` / `sinking_fund` → CSV import auto-upserts a row dated to the latest CSV date with `source='csv_import'` using the latest `Saldo`.

Net worth at date `D` = `Σ (latest balance_entries.value_dkk per account where entry_date ≤ D)`.

### Envelopes (sinking-fund only)

- **`envelopes`** — `id`, `user_id FK`, `account_id FK`, `name`, `target_monthly_dkk NUMERIC(12,2)?`, `cadence_months INT?`, `expected_amount_dkk NUMERIC(12,2)?`, `color TEXT?`, `sort_order INT`. `UNIQUE(account_id, name)`.

App-layer rule: envelopes only on `kind='sinking_fund'` accounts. Postgres CHECK can't easily enforce cross-table; enforced via service-layer guard + a CI test.

### Transactions

- **`transactions`** — `id`, `user_id FK`, `account_id FK`, `posted_date DATE`, `amount_dkk NUMERIC(14,2)` (signed; negative = expense), `balance_dkk NUMERIC(14,2)?` (Saldo column), `text TEXT` (Tekst column), `bank_category TEXT?`, `bank_subcategory TEXT?`, `category_id UUID FK?`, `envelope_id UUID FK?`, `hidden BOOL DEFAULT FALSE`, `hidden_source TEXT?` with `CHECK (hidden_source IN ('manual','rule') OR hidden_source IS NULL)`, `content_hash TEXT`. `UNIQUE(account_id, content_hash)`.
- Indexes: `(user_id, account_id, posted_date DESC)`, `(user_id, category_id)`, `(account_id, envelope_id)`, partial `(user_id, posted_date) WHERE hidden = FALSE`.
- `content_hash = sha256(posted_date || '|' || amount_cents || '|' || text || '|' || bank_category)`.

- **`transaction_splits`** — `id`, `transaction_id FK`, `envelope_id FK`, `amount_dkk NUMERIC(14,2)`. Used only when a single deposit allocates across multiple envelopes. If `transactions.envelope_id` is set, no splits exist for that row. If `envelope_id` is NULL and splits exist, splits define partial allocation; remainder is "unallocated."

Envelope balance:

```
envelope_balance(X) = sum(t.amount_dkk where t.envelope_id = X)
                   + sum(s.amount_dkk where s.envelope_id = X)
```

Account unallocated = `(latest balance_dkk) − Σ envelope_balance`.

### Rules engine

- **`rules`** — `id`, `user_id FK`, `pattern TEXT` (substring, case-insensitive), `action TEXT CHECK IN ('categorize','hide')`, `category_id UUID FK?`, `envelope_id UUID FK?`, `account_id UUID FK?` (NULL = all accounts).
- CHECK: `action='categorize'` requires `category_id IS NOT NULL`; `action='hide'` requires `category_id IS NULL AND envelope_id IS NULL`.
- Matching at import time: scan rules for this user where `account_id IS NULL OR account_id = txn.account_id`; among `pattern ILIKE` matches, longest pattern wins; ties → most recent `created_at`.

### Budget

- **`budget_template`** — `id`, `user_id FK`, `category_id FK`, `planned_dkk NUMERIC(12,2)`, `sort_order INT`. `UNIQUE(user_id, category_id)`.
- **`budget_month_lines`** — `id`, `user_id FK`, `year INT`, `month INT CHECK BETWEEN 1 AND 12`, `category_id FK`, `planned_dkk NUMERIC(12,2)`, `sort_order INT`. `UNIQUE(user_id, year, month, category_id)`. A month "exists" iff any row exists for it. Re-stamping = `DELETE WHERE user_id AND year AND month` then bulk INSERT inside one transaction.
- **`budget_ticks`** — `id`, `user_id FK`, `year INT`, `month INT`, `category_id FK`, `amount_dkk NUMERIC(14,2)`, `note TEXT?`, `ticked_at TIMESTAMPTZ DEFAULT NOW()`.

Remaining per category = `planned_dkk − Σ ticks.amount_dkk for (user, year, month, category)`.

### Notes on the schema

- `hidden_source` is set when the column is flipped; a `rule`-set hidden value is **not** overwritten by future user-manual-flip-back operations except when the user explicitly does so. Manual flips become sticky.
- Deleting a rule does **not** revert past categorizations. A "re-apply to uncategorized" button in the rules manager does that on demand.
- Schema bootstrap runs idempotently in `db.py` on each backend boot (same pattern as gold-bar-tracker). Migrations are inline `ALTER TABLE IF EXISTS` blocks.

## 5. Views

### View 1 — Home

Cards (column on mobile, two columns wide-screen):

| Card | Renders | Tap → |
|---|---|---|
| **This month** | `Remaining: N DKK`, progress bar (spent/planned from ticks), days-left badge | Budget |
| **What's eating my money** | Top 3 categories last 30 days; each row a mini bar of category-spend vs. monthly average | Spending |
| **Net worth** | Total + sparkline (6m) + Δ vs last month | Net Worth |
| **Review queue** | Count of uncategorized transactions; only renders when > 0 | Spending → review |

`GET /home` returns one composite payload.

### View 2 — Budget

- Top: month picker (←/→, click for date jumper). Right-side buttons: **"Stamp from template"** (always visible) and **"Edit template"**.
- If month stamped: rows of `category | planned | spent | remaining`; per-row tick button → "Log expense" dialog (amount, optional note). Per-row "+" for ad-hoc category for this month only. Footer total. Clicking "Stamp from template" while stamped → overwrite confirm dialog ("This will replace the current month's plan with the template. Ticks will be preserved. Continue?") then re-stamps. (Ticks are keyed to `(user, year, month, category_id)` so they survive a re-stamp as long as the category remains in the template.)
- If month unstamped: empty state with the same "Stamp from template" button highlighted; clicking it stamps without a confirm dialog.
- "Edit template" → template editor: add/remove categories, set planned, drag-to-reorder, single save.

### View 3 — Spending

Top: account selector + date-range pills (1m / 3m / 6m / 12m / custom).

Tabs:

1. **Overview** — monthly spend stacked bar (one bar per month, segments by category), category breakdown table for range, top merchants. Excludes hidden + `exclude_from_spend` categories (footer note shows excluded totals).
2. **Transactions** — paginated table: date, merchant text, amount, category dropdown (inline edit + inline create), envelope dropdown (sinking-fund only), hide toggle. Search hits `text`.
3. **Review queue** — uncategorized rows grouped by extracted pattern. Each group card shows count + sample rows; one category dropdown + "Hide forever" button + adjustable pattern field. Confirm → create rule (or one-off), retro-apply, group disappears.
4. **Envelopes** — visible only when selected account is `sinking_fund`. Envelope cards (name, balance, target/month, next-due indicator), Unallocated card, "Manage envelopes" → CRUD dialog.

Dialogs:
- **Import CSV** — file picker (single or multi-select), account selector, "Import." Result toast: `"Imported N, deduped M, K need review →"` with deep-link to review tab.
- **Split deposit** — opens during review of a positive transaction on a sinking-fund account. Per-envelope amount inputs; preset "auto-split by target_monthly"; remainder shown as "Unallocated"; save (allows partial sum, since unallocated is implicit).
- **New category (inline)** — name, color, exclude-from-spend toggle. Triggered from any category dropdown's `+ New category…` entry.

### View 4 — Net Worth

- Top: total + Δ pills (1M / 3M / 6M / 1Y / all).
- Chart: total over time, area gradient (matches gold-bar-tracker's worth-over-time visual treatment).
- Composition donut: by asset class.
- Accounts list grouped by asset class. Per row: name, current value, last-updated, mini sparkline. Tap → per-account history dialog.

Dialogs:
- **Add / edit account** — name, kind, asset class. For `spending` / `sinking_fund`, info note: "balance auto-tracked from CSV imports."
- **Add balance entry** — date (default today), value DKK. Surfaced only for `savings` accounts.
- **Per-account history** — full chart, list of entries, delete affordance.

### View 5 — Settings

Sections:
1. **Account** — email, sign out.
2. **Theme** — light / dark / system.
3. **Categories** — CRUD list. Rename, color, exclude-from-spend toggle, sort, delete (with usage-count warning).
4. **Merchant rules** — CRUD list. Pattern, action, target, scope (account/all). "Show hidden" toggle reveals rows hidden by a `hide` rule. "Re-apply to uncategorized" button.
5. **Envelopes** — shortcut to the manager (lives in Spending → Envelopes).
6. **Data** — `Export all my data as JSON` (deferred).

## 6. CSV import flow

State machine:

```
[idle] → upload → [parsing] → [deduping] → [applying rules] → write txns + balance entry → [review queue] → resolve groups → [done]
                     ↓
                  [error: row]   (parse failure: no DB writes)
```

### Danske CSV format

- Encoding: ISO-8859-1.
- Columns (semicolon-separated quotes, comma decimals): `Dato, Kategori, Underkategori, Tekst, Beløb, Saldo, Status, Afstemt`.
- Date: `DD.MM.YYYY`.
- Numbers: Danish (`-5.000,00` = -5000.00).
- `Kategori` / `Underkategori` are right-padded with spaces to ~80 chars — strip both ends.

### Rule application at import time

1. Compute `content_hash`; skip insert if exists for `(account_id, content_hash)`.
2. For each new transaction, scan `rules` where `user_id = $1 AND (account_id IS NULL OR account_id = $2) AND $3 ILIKE '%' || pattern || '%'`. Order by `length(pattern) DESC, created_at DESC`. Pick first.
3. Apply:
   - `categorize` → set `category_id` (+ `envelope_id` if specified).
   - `hide` → `hidden = TRUE`, `hidden_source = 'rule'`.
4. No match → leave `category_id = NULL`; row falls into review.
5. After all rows are inserted, upsert exactly one `balance_entries` row for the account using `(entry_date = latest posted_date in this import, value_dkk = that row's balance_dkk, source = 'csv_import')`. `UNIQUE(account_id, entry_date)` makes this an ON CONFLICT DO UPDATE. This step is only performed when the account's `kind` is `spending` or `sinking_fund`; never for `savings` (which don't accept CSV imports).

All in one transaction per import. On any error (including the balance-entry upsert), full rollback — both `transactions` inserts and the `balance_entries` upsert revert together.

The import endpoint accepts either a single file or multiple files in one multipart request. Multiple files = each file goes through the same flow, each in its own subtransaction inside the outer per-request transaction; the response sums the results.

### Pattern auto-extraction

Heuristic on `text`:

1. Strip whitespace.
2. Take substring up to first occurrence of: digit-run of length ≥ 3, ` KBH`, ` KOEBE`, ` DK`, `/`, `*`, or end.
3. Trim trailing punctuation.
4. Lowercase for matching; display original case in the UI suggestion.

Always editable in the review UI — this is a suggestion, not a constraint.

### Review-resolve endpoint

`POST /spending/review/resolve`:

```json
{
  "account_id": "uuid?",
  "pattern": "APPLE.COM",
  "action": "categorize" | "hide",
  "category_id": "uuid?",
  "envelope_id": "uuid?",
  "create_rule": true
}
```

The body's `account_id` field is the **scope** of the operation — it bounds both the transactions affected by this resolve call AND the `account_id` of the rule that gets created (if `create_rule=true`), so future imports behave consistently with the past application. `account_id = null` in the body means "apply across all accounts" and creates a rule with `account_id = NULL`.

Logic, all in one DB transaction:

1. If `create_rule` → insert into `rules` with the same `account_id` scope as the request (dedupe: if an identical `pattern + action + category_id + envelope_id + account_id` row exists, no-op and reuse it).
2. `UPDATE transactions SET ...` matching:
   - `user_id = $caller`
   - `category_id IS NULL`
   - `text ILIKE '%' || pattern || '%'`
   - `account_id = $body.account_id` (if scope is set) — otherwise no account filter
   - For `categorize`: set `category_id`, `envelope_id` if provided. Leave `hidden` alone.
   - For `hide`: set `hidden = TRUE`, `hidden_source = 'rule'`. Leave `category_id` alone (it stays NULL).
3. Return `{ affected: N, rule_id?: uuid }`.

### Errors

| Class | Surface |
|---|---|
| Wrong encoding | `400 { code: 'bad_encoding' }` → "Expected ISO-8859-1 (Danske default). Re-export?" |
| Missing columns | `400 { code: 'bad_columns', detail: [...] }` |
| Empty file | `400 { code: 'empty' }` |
| Row parse error | `400 { code: 'bad_row', detail: { row_number, raw } }` (whole import rolled back) |

## 7. Auth

Mirrors gold-bar-tracker, minus the public `X-API-Key` layer:

- `POST /auth/request-link` — issue a magic-link email. Rate limit: 3/10min per email, 30/hour per IP. Always 204 (no leak of email-exists). Token is SHA-256-hashed at rest; 15-minute TTL; single-use.
- `POST /auth/verify` — exchange a magic-link token for a session bearer token (opaque UUID). Returns `{user_id, email, token}`.
- `GET /auth/me` — current user or 401.
- `POST /auth/logout` — delete the session row.

Session token in `localStorage` as `net-tracker.session-token`. 90-day sliding TTL via `last_seen_at` with a 1h debounce on UPDATE.

Magic-link URL: `${FRONTEND_ORIGIN}/#auth=<token>`. Token lives in the URL fragment so it never hits server logs / proxies. Frontend extracts on page load and `POST /auth/verify`s.

`MAGIC_LINK_DEV_PRINT=1` logs the email to stdout in local dev instead of sending via Resend.

## 8. Error handling principles

- No silent fallbacks for data that gets frozen (lesson from gold-bar-tracker's historical-FX incident). CSV import either commits cleanly or raises with row context.
- 401 anywhere → frontend clears the token + re-prompts login; never silently retry.
- 502 on transient upstream (Resend) → retry only for idempotent calls (`/auth/request-link`); never for mutations.
- 5xx in CSV import → roll back the whole import transaction; user sees the error and the DB is unchanged.
- All errors return JSON `{ code, message, detail }`. Frontend renders a toast.

## 9. Testing

| Layer | Coverage |
|---|---|
| Unit | Danske CSV parser (Danish dates, Danish numbers, padded fields, ISO-8859-1 round-trip), content-hash dedup, rule-matching (longest wins, account scope, ties), pattern auto-extraction, envelope balance math (single-envelope + splits), net-worth aggregation across mixed `manual` + `csv_import` entries, budget remaining math |
| API | Each endpoint against real Postgres (sidecar in CI). Critical paths: import → review → resolve → categorize-all; stamp → tick → remaining; account CRUD + balance entry → net-worth aggregation |
| Manual smoke | Theme switch, magic-link end-to-end, side-drawer gestures (touch), import a synthetic CSV in dev |

CI: `ruff` + `mypy` + `pytest unit` + `pytest api` on every push (same workflow shape as gold-bar-tracker).

## 10. Environment variables

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Neon Postgres DSN |
| `RESEND_API_KEY` | yes (for sign-in) | Resend API key (`re_…`) |
| `MAGIC_LINK_BASE_URL` | yes (for sign-in) | Frontend origin used to build the `#auth=` URL |
| `FRONTEND_ORIGIN` | no | CORS origin; defaults to `*` (auth is bearer-token-based, no credential-leak path) |
| `RESEND_FROM` | no | Override From address; defaults to `onboarding@resend.dev` |
| `MAGIC_LINK_DEV_PRINT` | no (dev only) | Set to `1` to log sign-in emails to stdout |

## 11. Endpoint inventory

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/` | none | health |
| POST | `/auth/request-link` | none | magic-link email; rate-limited |
| POST | `/auth/verify` | none | exchange token for session |
| GET | `/auth/me` | Bearer | current user |
| POST | `/auth/logout` | Bearer | revoke session |
| GET | `/home` | Bearer | composite home payload |
| GET | `/categories` | Bearer | list |
| POST | `/categories` | Bearer | create (used by inline create too) |
| PATCH | `/categories/{id}` | Bearer | rename/color/exclude flag/sort |
| DELETE | `/categories/{id}` | Bearer | with usage-count check |
| GET | `/accounts` | Bearer | list |
| POST | `/accounts` | Bearer | create |
| PATCH | `/accounts/{id}` | Bearer | rename/asset class/sort |
| DELETE | `/accounts/{id}` | Bearer | cascade |
| POST | `/accounts/{id}/balance` | Bearer | add/replace balance entry (savings only at API layer) |
| GET | `/accounts/{id}/history` | Bearer | balance entries series |
| GET | `/envelopes?account=` | Bearer | list |
| POST | `/envelopes` | Bearer | create (rejects if account is not sinking_fund) |
| PATCH | `/envelopes/{id}` | Bearer | edit |
| DELETE | `/envelopes/{id}` | Bearer | cascade |
| POST | `/spending/import` | Bearer | multipart CSV upload |
| GET | `/spending/transactions` | Bearer | paginated, filters |
| PATCH | `/spending/transactions/{id}` | Bearer | category/envelope/hidden/splits |
| GET | `/spending/review?account=` | Bearer | grouped uncategorized |
| POST | `/spending/review/resolve` | Bearer | categorize/hide group, optionally create rule |
| GET | `/spending/aggregations?account=&from=&to=` | Bearer | monthly stacks + top categories + top merchants |
| GET | `/rules` | Bearer | list |
| POST | `/rules` | Bearer | create |
| PATCH | `/rules/{id}` | Bearer | edit |
| DELETE | `/rules/{id}` | Bearer | cascade |
| POST | `/rules/{id}/reapply` | Bearer | re-apply rule to uncategorized rows |
| GET | `/budget/template` | Bearer | template rows |
| PUT | `/budget/template` | Bearer | replace whole template |
| GET | `/budget/month?year=&month=` | Bearer | month lines + ticks rollup |
| POST | `/budget/month/stamp` | Bearer | stamp template into month (overwrite confirm) |
| POST | `/budget/ticks` | Bearer | log a tick |
| DELETE | `/budget/ticks/{id}` | Bearer | undo |
| GET | `/networth?from=&to=` | Bearer | series + composition + per-account latest |

## 12. Conventions

- **Currency**: DKK only at MVP.
- **Numbers**: Danish parsing (dot thousands, comma decimal); display uses dots only.
- **Encoding**: Danske CSV is ISO-8859-1, explicit in parser.
- **Padded fields**: Danske's `Kategori` / `Underkategori` right-padded to ~80 chars — strip everywhere.
- **Date format**: `DD-MM-YYYY` in UI; `DD.MM.YYYY` in Danske CSV input.
- **Buttons**: same affirmative/neutral discipline as gold-bar-tracker. Inside dialogs, `value="save"` paints affirmative.

## 13. What's deferred

- "Sinking-fund health" home card (envelopes with insufficient runway).
- Optional "of which deposited this month" on net-worth entries → enables Modified-Dietz-style change attribution.
- Data export (JSON).
- Cron jobs (e.g., monthly "you haven't imported yet" reminder).
- Alerts / notifications beyond auth email.
- Bank-API integration (likely never; CSV is fine).
- Migration to a bundler if/when the JS gets unwieldy.
- A "Plan / Track / Review" workflow-driven layout (would be a re-skin of the existing data).
