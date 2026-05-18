# net-tracker — Claude guide

Personal-finance PWA. Single-user, magic-link auth. Three subsystems (Budget / Spending Analysis / Net Worth) plus a Home dashboard, all sharing a single category taxonomy. Stack and shell are modeled on `gold-bar-tracker` (sibling repo in the same projects folder) — FastAPI on Render, vanilla-JS PWA on Cloudflare Pages, Neon Postgres, Resend for magic-link email. No cron, no public API-key layer, no foreign-currency handling at MVP.

## Git

**All commits in this repo must be authored as `yzeirbaku@hotmail.com` (name: `Yzeir Baku`).** Set in the local repo config — do not change it, and verify with `git config user.email` before committing if anything looks off.

Co-author trailers from Claude Code's default workflow are fine; the *author* must remain the hotmail address.

## Five views

The PWA has five top-level views in a side drawer (same shell pattern as gold-bar-tracker):

- **Home** — four at-a-glance cards: this month's budget remaining (with progress bar + days left), top 3 spending categories last 30 days, net-worth sparkline + delta vs last month, and a "review queue" card that only renders when uncategorized transactions are waiting. Each card taps through to its full view.
- **Budget** — edit the persistent **ideal monthly budget template** (categories + planned amounts). For any month, **stamp template → month** to materialize that month's plan. Once stamped, the month is editable independently; re-stamping overwrites with confirmation. Manual checkoff of expenses; running "remaining" per category + per month.
- **Spending** — retrospective analysis of imported bank CSVs. Per-account filter, transaction table, review queue for uncategorized rows, monthly averages over 1m/3m/6m/12m, per-category breakdown, reports. Sinking-fund accounts also show an envelope panel above the transaction table.
- **Net Worth** — list of accounts grouped by asset class (Savings / Stocks / Crypto / Gold / Pension / Other). Each account has a history of `(date, balance)` entries; net-worth-over-time chart + period change (1M/3M/6M/1Y/all) + composition breakdown.
- **Settings** — sign in/out, light/dark toggle, manage categories, manage merchant rules, manage envelopes.

The three subsystems share a global **category taxonomy** but otherwise own their data. Budget is manual planning + checkoff; Spending is the retrospective from imported CSVs; Net Worth is the savings/investments overview. They intentionally do *not* cross-couple at the transaction level — categorization in one does not flow to the other. Only categories are shared.

## Account kinds

Three flavors on the `accounts` table (`kind` column):

- **`spending`** — daily account, CSV-imported, no envelopes. Example: Danske Salary account.
- **`savings`** — no CSV import; only manual net-worth balance entries. Example: a Danske savings account that just grows.
- **`sinking_fund`** — CSV-imported *and* has envelopes (virtual sub-allocations for irregular expenses like quarterly TV subscription, semi-annual insurance, etc.).

Same table for all three; `kind` drives the UI and what fields apply. The Net Worth view reads `accounts` for asset-class composition; the CSV importer only attaches to `spending` and `sinking_fund` accounts.

## Categorization workflow

A small **rules engine** drives both auto-categorization and "hide forever." No fuzzy / ML / LLM-based guessing — every rule is a deterministic substring match on the Danske `Tekst` (merchant) field, created by user confirmation.

**Rule shape:**

- `pattern` (case-insensitive substring against `Tekst`)
- `action` ∈ `{categorize, hide}`
- `category_id` (NULL when `action='hide'`)
- `envelope_id` (NULL unless the rule scopes to a sinking-fund account)
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

- **Accounts table** holds the source of truth for asset class + name. Same table as the CSV-importer's account list.
- **Balance entries** — `(account_id, date, value_dkk)`. Each manual update is a new row; system never overwrites. Net worth at any date = sum of latest `value_dkk` per account on or before that date.
- **Asset classes:** fixed set — Savings / Stocks / Crypto / Gold / Pension / Other. DKK only at MVP.
- **Charts:** total over time (sparkline + full chart with range pills 1M/3M/6M/1Y/all), composition pie/donut, per-account history.

## Sinking funds (envelopes)

Only relevant for `kind = 'sinking_fund'` accounts.

- `envelopes(id, account_id, name, target_monthly_dkk, cadence_months?, expected_amount_dkk?, color?)`
- Transactions in sinking-fund accounts gain an optional `envelope_id`.
- **Balance per envelope** = `sum(signed amount where envelope_id = X)`. Account `Saldo` (from latest CSV row) remains the source of truth for the account total.
- **Unallocated** = `account_total − sum(envelope_balances)`. Money sitting in the account not yet earmarked.
- **Splitting deposits:** when a positive transaction (the monthly lump from salary) is reviewed, a split dialog distributes it across envelopes (must sum to the deposit amount; default split is proportional to `target_monthly`). User can leave it unallocated and split later.
- **Cadence + expected** are planning hints only — drive the "next due" indicator (covered ✓ / short by N ✗) but never enter the balance calculation.

## Auth

Single scheme: magic-link → opaque session bearer tokens in `localStorage` (`net-tracker.session-token`). Sliding 90-day TTL with the same `last_seen_at` debounce gold-bar-tracker uses. No public `X-API-Key` layer — nothing in this app is intended to be shared.

Magic-link rate limits and one-time SHA-256-hashed tokens follow the gold-bar-tracker pattern. Email transport: Resend; `MAGIC_LINK_DEV_PRINT=1` logs to stdout in local dev instead of sending.

## Theme

- Accent: muted green family (`#4f7d5b` / `#6ba47a` range) replaces gold's warm yellow.
- Dark base: cooler near-black slate (`#0f1419` range), distinct from gold-bar-tracker's warm grey-black.
- Light theme: its own design, not a copy.
- Affirmative buttons: green gradient (same color as the active-state accent across pills/tabs). Neutral buttons: subtle grey. Same affirmative/neutral discipline as gold-bar-tracker — `value="save"` inside dialogs paints affirmative; standalone uses `site-btn` / `site-btn-primary`.
- Date format site-wide: `DD-MM-YYYY` for dates, `DD-MM-YYYY HH:MM` for timestamps. Same canonical formatter pattern as gold-bar-tracker.

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

## Local dev (planned)

```bash
# Mirrors gold-bar-tracker; will be filled in once the backend and frontend are scaffolded.
```

## Verification (planned)

```bash
# From backend/:
ruff check app tests
mypy app
pytest tests/unit -v
pytest tests/api -v   # FastAPI routes against real Postgres
```
