/**
 * Budget view — Plan 3.
 *
 * Four sub-views, each rendered into #budget-root:
 *   - "month"        the main month plan (default)
 *   - "template"     the template editor
 *   - "history"      template version list
 *   - "version"      single template version (read-only)
 *   - "archive"      archived months list
 *
 * Sub-view is tracked in module state, not URL — matches the rest of the
 * app, which doesn't use hash-based sub-routing. The cold-start loading
 * card is painted only on the very first render so re-renders triggered
 * by Add/Tick/etc. don't blink.
 */

import { api } from "./shared/api.js";
import { createMonthPicker } from "./shared/datepicker.js";
import { createDropdown } from "./shared/dropdown.js";
import {
  blurAutoFocusedInDialog,
  confirmPrompt,
  escapeHtml,
  friendlyError,
  toast,
  withBusyButton,
} from "./shared/ui.js";
import { paintViewError, paintViewLoading } from "./shared/view-loading.js";

// ── State ────────────────────────────────────────────────────────────────

const state = {
  subView: "month",                 // "month" | "template" | "history" | "version" | "archive"
  currentMonth: defaultMonth(),     // { year, month } — defaults to today
  versionId: null,                  // for "version" sub-view
  monthsCache: null,                // last GET /budget/months payload (for the picker label hints)
  categories: [],                   // all user categories (for the add-category picker)
  // Collapsed state per (year, month, month_category_id). Persisted to localStorage.
  collapsed: loadCollapsed(),
  // Sort mode for the month view. "amount" = categories by total planned
  // descending, items inside by planned_dkk descending. "alpha" = both
  // sorted A→Z by name. Persisted to localStorage so the user's pick
  // survives reloads. Template view ignores this — it uses the raw
  // sort_order from the draft so manual ordering is preserved while
  // editing.
  budgetSort: loadBudgetSort(),
  // Local edit buffer for the template editor — exists only while sub-view = "template".
  templateDraft: null,
  // Pristine snapshot of the draft as last loaded from the server — used to
  // tell whether the editor has unsaved changes.
  templateBaseline: null,
  booted: false,
};

function defaultMonth() {
  const t = new Date();
  return { year: t.getFullYear(), month: t.getMonth() + 1 };
}

// True when (year, month) is strictly before the current calendar month.
// The Stamp button is hidden for these; the backend also rejects with
// 400 cannot_stamp_past_month, but the UI shouldn't even offer it.
function isPastMonth(year, month) {
  const today = new Date();
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  if (year < ty) return true;
  if (year > ty) return false;
  return month < tm;
}

function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function ymOfPicker() {
  return ymKey(state.currentMonth.year, state.currentMonth.month);
}

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem("net-tracker.budget.collapsed") || "{}");
  } catch {
    return {};
  }
}

function saveCollapsed() {
  localStorage.setItem("net-tracker.budget.collapsed", JSON.stringify(state.collapsed));
}

const BUDGET_SORT_OPTIONS = [
  { value: "amount", label: "Amount (high → low)" },
  { value: "alpha",  label: "A → Z" },
];

// localStorage key is inlined inside the helpers below rather than held in
// a module-scope `const`, so loadBudgetSort() can be safely called during
// state initialization (TDZ would otherwise throw if it referenced a
// not-yet-defined const declared after the state object).
function loadBudgetSort() {
  const s = localStorage.getItem("net-tracker.budget.sort");
  return s === "alpha" ? "alpha" : "amount";
}

function saveBudgetSort(s) {
  localStorage.setItem("net-tracker.budget.sort", s);
}

/** Return a shallow-cloned month with categories and items reordered
 *  by state.budgetSort. The original `month` and its arrays are not
 *  mutated — keeps re-renders idempotent and lets the source-of-truth
 *  month payload retain its server-side sort_order. */
function sortedMonth(month) {
  if (!month || !Array.isArray(month.categories)) return month;
  const mode = state.budgetSort;
  const sortItems = (items) => {
    if (mode === "alpha") {
      return [...items].sort((a, b) => a.name.localeCompare(b.name));
    }
    return [...items].sort(
      (a, b) => Number(b.planned_dkk) - Number(a.planned_dkk),
    );
  };
  const cats = month.categories.map((c) => ({
    ...c,
    items: sortItems(c.items || []),
  }));
  cats.sort((a, b) => {
    if (mode === "alpha") {
      return a.category_name.localeCompare(b.category_name);
    }
    const at = (a.items || []).reduce(
      (sum, i) => sum + Number(i.planned_dkk || 0),
      0,
    );
    const bt = (b.items || []).reduce(
      (sum, i) => sum + Number(i.planned_dkk || 0),
      0,
    );
    return bt - at;
  });
  return { ...month, categories: cats };
}

function collapseKey(year, month, monthCategoryId) {
  return `${year}-${month}-${monthCategoryId}`;
}

// ── Formatters ───────────────────────────────────────────────────────────

const _MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtDKK(n) {
  const num = Number(n);
  return num.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " dkk";
}

function fmtDKKBare(n) {
  return Number(n).toLocaleString("de-DE", { maximumFractionDigits: 0 });
}

function fmtMonthLabel(year, month) {
  return `${_MONTH_NAMES[month - 1]} ${year}`;
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

function fmtDateOnly(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy}`;
}

// Parse a string the user typed into an amount input. Accepts "1.500", "1500",
// "1500,50", "1.500,50" — Danish-style. Returns Number, or null if invalid.
function parseAmount(s) {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/\s/g, "").replaceAll(".", "").replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

/** Format a numeric value as a Danish-style amount string for an input
 *  field's initial value: dots every three digits, no currency suffix. */
function formatAmountForInput(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return Math.round(num).toLocaleString("de-DE");
}

/** Live-format an amount input as the user types: dots every three digits
 *  on the integer part, single comma decimal preserved if present, leading
 *  zeros stripped. Caret position is preserved relative to the digits the
 *  user has typed so far. Safe to call on every `input` event. */
function liveFormatAmountInput(input) {
  const raw = input.value;
  const caret = input.selectionStart ?? raw.length;
  // Count digits before the caret so we can re-anchor it after rewriting.
  const digitsBeforeCaret = raw.slice(0, caret).replace(/[^\d]/g, "").length;
  // Strip everything but digits and the first comma; drop any extra commas.
  const stripped = raw.replace(/[^\d,]/g, "");
  const firstComma = stripped.indexOf(",");
  let intPart = firstComma === -1 ? stripped : stripped.slice(0, firstComma);
  const decPart = firstComma === -1
    ? ""
    : stripped.slice(firstComma + 1).replace(/,/g, "").slice(0, 2);
  // Strip leading zeros but keep a lone "0" so the user can type "0,5" etc.
  intPart = intPart.replace(/^0+(?=\d)/, "");
  const formattedInt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const formatted = firstComma === -1 ? formattedInt : `${formattedInt},${decPart}`;
  if (formatted === raw) return; // nothing to do, don't disturb the caret
  input.value = formatted;
  // Re-anchor caret: walk the formatted string and stop once we've passed
  // the same number of digits the user had typed before.
  let digitsSeen = 0;
  let newCaret = 0;
  for (let i = 0; i < formatted.length; i++) {
    if (digitsSeen >= digitsBeforeCaret) break;
    newCaret = i + 1;
    if (/\d/.test(formatted[i])) digitsSeen++;
  }
  input.setSelectionRange(newCaret, newCaret);
}

/** Attach the live-formatter to one input. Idempotent: the input is
 *  tagged with data-amount-fmt so repeated calls don't double-bind. */
function installAmountFormatter(input) {
  if (!input || input.dataset.amountFmt === "1") return;
  input.dataset.amountFmt = "1";
  input.addEventListener("input", () => liveFormatAmountInput(input));
}

// ── Derivations ──────────────────────────────────────────────────────────

function itemDone(item) {
  return item.ticked_at !== null || Number(item.remaining_dkk) <= 0;
}

function monthPlannedTotal(month) {
  let total = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) total += Number(it.planned_dkk);
  }
  return total;
}

function monthSpentTotal(month) {
  let total = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) total += Number(it.planned_dkk) - Number(it.remaining_dkk);
  }
  return total;
}

function monthOpenCount(month) {
  let n = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) if (!itemDone(it)) n++;
  }
  return n;
}

function catPlannedTotal(cat) {
  return cat.items.reduce((acc, it) => acc + Number(it.planned_dkk), 0);
}

function catSpentTotal(cat) {
  return cat.items.reduce(
    (acc, it) => acc + (Number(it.planned_dkk) - Number(it.remaining_dkk)),
    0,
  );
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function renderBudget() {
  const root = document.getElementById("budget-root");
  if (!root) return;
  if (!state.booted) paintViewLoading(root, "Loading budget…");
  try {
    if (state.subView === "month")        await renderMonthView(root);
    else if (state.subView === "template") await renderTemplateEditor(root);
    else if (state.subView === "history")  await renderVersionHistory(root);
    else if (state.subView === "version")  await renderVersionView(root);
    else if (state.subView === "archive")  await renderArchiveView(root);
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load Budget"));
    return;
  }
  state.booted = true;
}

// Reset to the month view (e.g., when the user clicks Budget in the menu
// after having drilled into the template). Called by app.js whenever the
// view becomes active so deep navigation doesn't survive a tab switch.
export function resetBudgetSubView() {
  state.subView = "month";
}

// ── Header (shared across sub-views) ─────────────────────────────────────

function headerHtml({ title, actions = [] }) {
  // All header buttons render in the same green-primary style as the Add
  // buttons in Settings — per user preference (no more secondary-button
  // contrast in the header).
  const actionsHtml = actions
    .map(
      (a) =>
        `<button type="button" class="btn-primary" data-budget-action="${a.id}">${escapeHtml(a.label)}</button>`,
    )
    .join("");
  return `
    <div class="budget-header">
      <div class="budget-header-title">${escapeHtml(title)}</div>
      <div class="budget-header-actions">${actionsHtml}</div>
    </div>
  `;
}

// ── Month view ──────────────────────────────────────────────────────────

async function renderMonthView(root) {
  let month;
  let monthExists = true;
  let months = [];
  try {
    months = await api.get("/budget/months");
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load Budget"));
    return;
  }
  state.monthsCache = months;
  try {
    month = await api.get(
      `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}`,
    );
  } catch (err) {
    if (err?.message === "month_not_stamped") {
      monthExists = false;
    } else {
      paintViewError(root, friendlyError(err, "Couldn't load Budget"));
      return;
    }
  }

  // Header chrome — Unarchive is intentionally NOT here; restoring an
  // archived month happens from the Archive view so the budget header
  // stays a consistent two-action affair across all month states.
  const headerActions = [
    { id: "open-template", label: "Template" },
    { id: "open-archive", label: "Archive" },
  ];

  root.innerHTML = `
    <div class="card budget-month-card">
      ${headerHtml({
        title: "Budget",
        actions: headerActions,
      })}
      <div class="budget-month-picker-row">
        <button type="button" class="budget-nav" data-budget-action="prev-month" aria-label="Previous month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <div id="budget-month-picker-mount" class="budget-month-picker-mount"></div>
        <button type="button" class="budget-nav" data-budget-action="next-month" aria-label="Next month"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
      </div>
      ${
        monthExists
          ? renderMonthBodyHtml(month)
          : renderEmptyMonthHtml()
      }
    </div>
  `;

  mountMonthPicker();
  bindMonthHandlers(month, monthExists, months);
}

function renderEmptyMonthHtml() {
  const past = isPastMonth(state.currentMonth.year, state.currentMonth.month);
  return `
    <div class="budget-empty">
      <p class="muted">No budget for ${escapeHtml(fmtMonthLabel(state.currentMonth.year, state.currentMonth.month))} yet.</p>
      ${
        past
          ? '<p class="muted-tiny">Past months can\'t be stamped — only the current month and future months.</p>'
          : '<button type="button" class="btn-primary" data-budget-action="stamp">Stamp from template</button>'
      }
    </div>
  `;
}

function renderMonthBodyHtml(rawMonth) {
  // Apply the user's chosen sort to a shallow clone — the raw payload
  // keeps its server-side sort_order so other parts of the code that
  // care about ordering (or future "reset to default" affordances)
  // can still see it.
  const month = sortedMonth(rawMonth);
  const archived = month.archived_at !== null;
  const planned = monthPlannedTotal(month);
  const spent = monthSpentTotal(month);
  const salary = Number(month.salary_dkk);
  const free = salary - planned;
  const openCount = monthOpenCount(month);
  const hasCategories = month.categories.length > 0;

  // Archive button only appears when every item is done (and the month
  // isn't already archived). No "disabled archive" state — the affordance
  // is simply absent until it's actionable.
  const showArchiveBtn = !archived && openCount === 0;

  return `
    ${archived ? '<div class="budget-archived-banner">This month is archived. Restore it from the Archive view to make changes.</div>' : ""}
    <div class="budget-salary ${archived ? "is-disabled" : ""}">
      <div>
        <div class="budget-salary-label">Salary</div>
        <div class="budget-salary-amount">${escapeHtml(fmtDKK(salary))}</div>
      </div>
      ${archived ? "" : '<button type="button" data-budget-action="edit-salary" class="budget-icon-btn" title="Edit salary" aria-label="Edit salary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>'}
    </div>
    ${
      hasCategories
        ? `<div class="budget-sort-row">
             <span class="budget-sort-label">Sort</span>
             <div id="budget-sort-mount" class="budget-sort-mount"></div>
           </div>`
        : ""
    }
    <div class="budget-categories">
      ${month.categories.map((c) => renderCategoryHtml(c, archived)).join("") || '<p class="muted">No categories in this month.</p>'}
    </div>
    ${archived ? "" : '<button type="button" class="budget-add-category" data-budget-action="add-category">+ Add category to this month</button>'}
    <div class="budget-footer">
      <div class="budget-footer-row"><span>Total planned</span><span>${escapeHtml(fmtDKK(planned))}</span></div>
      <div class="budget-footer-row"><span>Spent so far</span><span>${escapeHtml(fmtDKK(spent))}</span></div>
      <div class="budget-footer-row big"><span>Salary</span><span>${escapeHtml(fmtDKK(salary))}</span></div>
      <div class="budget-footer-row ${free >= 0 ? "remain" : "negative"}"><span>Free money</span><span>${escapeHtml(fmtDKK(free))}</span></div>
      ${
        showArchiveBtn
          ? '<button type="button" class="btn-primary budget-archive-btn" data-budget-action="archive">Archive month</button>'
          : ""
      }
    </div>
  `;
}

function renderCategoryHtml(cat, archived) {
  const ck = collapseKey(state.currentMonth.year, state.currentMonth.month, cat.id);
  const isCollapsed = state.collapsed[ck] === true;
  const color = cat.category_color || "var(--muted)";
  const planned = catPlannedTotal(cat);
  const spent = catSpentTotal(cat);
  return `
    <div class="budget-cat ${isCollapsed ? "is-collapsed" : ""}" data-month-cat-id="${cat.id}" style="--cat-color: ${escapeHtml(color)};">
      <div class="budget-cat-head" data-budget-action="toggle-cat" data-month-cat-id="${cat.id}" role="button" tabindex="0">
        <span class="budget-cat-name">
          <span class="budget-cat-caret">${isCollapsed ? "▸" : "▾"}</span>
          <span>${escapeHtml(cat.category_name)}</span>
        </span>
        <span class="budget-cat-totals">
          <span class="muted">spent ${escapeHtml(fmtDKKBare(spent))}</span>
          <span>of ${escapeHtml(fmtDKK(planned))}</span>
          ${
            archived
              ? ""
              : `<button type="button" data-budget-action="remove-cat" data-month-cat-id="${cat.id}" class="budget-icon-btn budget-icon-btn-danger" title="Remove this category from this month" aria-label="Remove category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`
          }
        </span>
      </div>
      ${
        isCollapsed
          ? ""
          : `<div class="budget-cat-body">
              ${cat.items.map((it) => renderItemHtml(it, archived)).join("")}
              ${
                archived
                  ? ""
                  : `<button type="button" class="budget-add-item" data-budget-action="add-item" data-month-cat-id="${cat.id}" data-category-id="${cat.category_id}">+ Add item to ${escapeHtml(cat.category_name)}</button>`
              }
            </div>`
      }
    </div>
  `;
}

function renderItemHtml(item, archived) {
  const done = itemDone(item);
  const planned = Number(item.planned_dkk);
  const remaining = Number(item.remaining_dkk);
  const remainingLabel = remaining <= 0 ? "0" : `${fmtDKKBare(remaining)} left`;
  return `
    <div class="budget-item ${done ? "is-done" : ""}" data-item-id="${item.id}">
      <span class="budget-item-name">${escapeHtml(item.name)}</span>
      <span class="budget-item-nums">
        <span class="budget-item-planned">${escapeHtml(fmtDKKBare(planned))}</span>
        <span class="budget-item-remaining ${remaining <= 0 ? "is-zero" : ""}">${escapeHtml(remainingLabel)}</span>
      </span>
      ${
        archived
          ? ""
          : `<span class="budget-item-actions">
              <button type="button" class="budget-icon-btn" data-budget-action="edit-item" data-item-id="${item.id}" title="Edit / partial pay" aria-label="Edit item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
              <button type="button" class="budget-icon-btn" data-budget-action="${done ? "untick" : "tick"}" data-item-id="${item.id}" title="${done ? "Untick" : "Tick complete"}" aria-label="${done ? "Untick" : "Tick complete"}">${done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'}</button>
              <button type="button" class="budget-icon-btn budget-icon-btn-danger" data-budget-action="delete-item" data-item-id="${item.id}" title="Delete item" aria-label="Delete item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </span>`
      }
    </div>
  `;
}

function mountMonthPicker() {
  const mount = document.getElementById("budget-month-picker-mount");
  if (!mount) return;
  const stamped = (state.monthsCache || []).map((m) => ymKey(m.year, m.month));
  const picker = createMonthPicker({
    value: ymOfPicker(),
    ariaLabel: "Pick a month",
    onChange: (ym) => {
      if (!ym) return;
      const [y, m] = ym.split("-").map(Number);
      state.currentMonth = { year: y, month: m };
      renderBudget();
    },
  });
  // Decorate the trigger with a small "(stamped)" hint when the picked
  // month is actually in the user's stamped list. Cheap visual signal that
  // they're not looking at an unstamped placeholder.
  if (stamped.includes(ymOfPicker())) {
    picker.element.classList.add("mp-current-stamped");
  }
  mount.replaceChildren(picker.element);
}

function bindMonthHandlers(month, _monthExists, _allMonths) {
  // Sort dropdown — present only when the month has at least one category.
  // Mounted fresh on every render, so the createDropdown instance doesn't
  // outlive the DOM node it lives in.
  const sortMount = document.getElementById("budget-sort-mount");
  if (sortMount) {
    const dd = createDropdown({
      options: BUDGET_SORT_OPTIONS,
      value: state.budgetSort,
      ariaLabel: "Sort categories",
      onChange: (v) => {
        if (v === state.budgetSort) return;
        state.budgetSort = v;
        saveBudgetSort(v);
        renderBudget();
      },
    });
    sortMount.replaceChildren(dd.element);
  }

  // Re-renders blow away child listeners but listeners on `#budget-root`
  // itself persist — so we MUST detach the previous handler before adding
  // a fresh one, or every render accumulates another set.
  installBudgetClickHandler(async (e) => {
    const btn = e.target.closest("[data-budget-action]");
    if (!btn) return;
    const action = btn.dataset.budgetAction;
    if (action === "prev-month")    return shiftMonth(-1);
    if (action === "next-month")    return shiftMonth(1);
    if (action === "open-template") return goToSubView("template");
    if (action === "open-archive")  return goToSubView("archive");
    if (action === "stamp")         return doStampMonth(btn);
    if (action === "edit-salary")   return openSalaryDialog(month);
    if (action === "add-category")  return openCategoryPickerDialog({
      mode: "month",
      excludeIds: month.categories.map((c) => c.category_id),
    });
    if (action === "toggle-cat")    return toggleCategory(btn.dataset.monthCatId);
    if (action === "add-item")      return openItemDialog({ mode: "add", monthCategoryId: btn.dataset.monthCatId, categoryId: btn.dataset.categoryId });
    if (action === "edit-item")     return openItemDialog({ mode: "edit", item: findItem(month, btn.dataset.itemId) });
    if (action === "tick")          return tickItem(btn, btn.dataset.itemId, true);
    if (action === "untick")        return tickItem(btn, btn.dataset.itemId, false);
    if (action === "delete-item")   return deleteItemFromRow(btn, btn.dataset.itemId);
    if (action === "remove-cat")    return removeMonthCategory(btn, btn.dataset.monthCatId);
    if (action === "archive")       return doArchive(btn);
    if (action === "unarchive")     return doUnarchive(btn);
  });
  installBudgetInputHandler(null);  // no input listener for the month view
}

/**
 * Attach a click handler to #budget-root, replacing any previously attached
 * handler. Used by every sub-view so re-renders don't leak listeners.
 *
 * The same handler is also wired up as a keydown handler that fires on
 * Enter / Space when an element with role="button" or role="link" is
 * focused — so non-<button> clickables (collapse toggle, archive month
 * link) are keyboard-accessible.
 */
function installBudgetClickHandler(handler) {
  const root = document.getElementById("budget-root");
  if (!root) return;
  if (root.__budgetClickHandler) {
    root.removeEventListener("click", root.__budgetClickHandler);
  }
  if (root.__budgetKeyHandler) {
    root.removeEventListener("keydown", root.__budgetKeyHandler);
  }
  root.__budgetClickHandler = handler;
  if (handler) {
    root.addEventListener("click", handler);
    const keyHandler = (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const role = t.getAttribute("role");
      if (role !== "button" && role !== "link") return;
      if (!t.dataset.budgetAction) return;
      e.preventDefault();
      handler(e);
    };
    root.__budgetKeyHandler = keyHandler;
    root.addEventListener("keydown", keyHandler);
  } else {
    root.__budgetKeyHandler = null;
  }
}

function installBudgetInputHandler(handler) {
  const root = document.getElementById("budget-root");
  if (!root) return;
  if (root.__budgetInputHandler) {
    root.removeEventListener("input", root.__budgetInputHandler);
  }
  root.__budgetInputHandler = handler;
  if (handler) root.addEventListener("input", handler);
}

function shiftMonth(dir) {
  let { year, month } = state.currentMonth;
  month += dir;
  if (month < 1) { month = 12; year--; }
  if (month > 12) { month = 1; year++; }
  state.currentMonth = { year, month };
  renderBudget();
}

function goToSubView(name) {
  state.subView = name;
  renderBudget();
}

function findItem(month, itemId) {
  for (const cat of month.categories) {
    for (const it of cat.items) if (it.id === itemId) return { ...it, _monthCategoryId: cat.id };
  }
  return null;
}

function toggleCategory(monthCatId) {
  const key = collapseKey(state.currentMonth.year, state.currentMonth.month, monthCatId);
  state.collapsed[key] = !state.collapsed[key];
  saveCollapsed();
  renderBudget();
}

async function doStampMonth(btn) {
  try {
    await withBusyButton(btn, "Stamping…", () =>
      api.post(`/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/stamp`, {}),
    );
    toast("Month stamped from template");
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't stamp month"), "error");
  }
}

async function deleteItemFromRow(btn, itemId) {
  const ok = await confirmPrompt({
    title: "Delete item?",
    message: "This removes the item from this month's budget.",
    okLabel: "Delete",
  });
  if (!ok) return;
  try {
    await withBusyButton(btn, "…", () =>
      api.delete(
        `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/items/${itemId}`,
      ),
    );
    toast("Item deleted");
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't delete item"), "error");
  }
}

async function tickItem(btn, itemId, toTicked) {
  try {
    await withBusyButton(btn, "…", () =>
      api.patch(
        `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/items/${itemId}`,
        { ticked: toTicked },
      ),
    );
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't update item"), "error");
  }
}

async function removeMonthCategory(btn, monthCategoryId) {
  const ok = await confirmPrompt({
    title: "Remove category?",
    message: "This removes the category and all its items from this month. The template is not affected.",
    okLabel: "Remove",
  });
  if (!ok) return;
  try {
    await withBusyButton(btn, "Removing…", () =>
      api.delete(
        `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/categories/${monthCategoryId}`,
      ),
    );
    toast("Category removed");
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't remove category"), "error");
  }
}

async function doArchive(btn) {
  const ok = await confirmPrompt({
    title: "Archive this month?",
    message: "Archived months become read-only. You can unarchive later if you need to make changes.",
    okLabel: "Archive",
  });
  if (!ok) return;
  try {
    await withBusyButton(btn, "Archiving…", () =>
      api.post(`/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/archive`, {}),
    );
    toast("Month archived");
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't archive"), "error");
  }
}

async function doUnarchive(btn) {
  try {
    await withBusyButton(btn, "Restoring…", () =>
      api.post(`/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/unarchive`, {}),
    );
    toast("Month restored");
    await renderBudget();
  } catch (err) {
    toast(friendlyError(err, "Couldn't unarchive"), "error");
  }
}

// ── Salary dialog ────────────────────────────────────────────────────────

function openSalaryDialog(month) {
  const dlg = ensureDialog("budget-salary-dialog", `
    <h3 style="margin-top:0">Edit salary</h3>
    <p class="muted" style="margin-top:0">Just this month's salary — the template stays unchanged.</p>
    <label for="budget-salary-input">Salary (DKK)</label>
    <input id="budget-salary-input" type="text" inputmode="decimal" />
    <menu>
      <button value="cancel" data-budget-dialog-close type="button">Cancel</button>
      <button value="save" data-budget-dialog-save type="button">Save</button>
    </menu>
  `);
  const input = dlg.querySelector("#budget-salary-input");
  input.value = formatAmountForInput(month.salary_dkk);
  installAmountFormatter(input);
  bindSimpleDialog(dlg, async (saveBtn) => {
    const v = parseAmount(input.value);
    if (v === null) { toast("Enter a valid amount", "error"); return false; }
    try {
      await withBusyButton(saveBtn, "Saving…", () =>
        api.patch(
          `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}`,
          { salary_dkk: v },
        ),
      );
      toast("Salary updated");
      await renderBudget();
      return true;
    } catch (err) {
      toast(friendlyError(err, "Couldn't save salary"), "error");
      return false;
    }
  });
  dlg.showModal();
  blurAutoFocusedInDialog(dlg);
}

// ── Item dialog (add / edit) ─────────────────────────────────────────────

async function openItemDialog({ mode, item, monthCategoryId, categoryId }) {
  const isAdd = mode === "add";
  const dlg = ensureDialog("budget-item-dialog", `
    <h3 id="budget-item-dialog-title" style="margin-top:0"></h3>
    <label for="budget-item-name">Name</label>
    <input id="budget-item-name" type="text" placeholder="e.g. Rent" />
    <label for="budget-item-planned">Planned amount (DKK)</label>
    <input id="budget-item-planned" type="text" inputmode="decimal" />
    <div id="budget-item-remaining-wrap" hidden>
      <label for="budget-item-remaining">Remaining (DKK)</label>
      <input id="budget-item-remaining" type="text" inputmode="decimal" />
      <p class="muted-tiny">Lower this as you pay. At 0, the item is auto-ticked.</p>
    </div>
    <div id="budget-item-paid-wrap" hidden style="margin-top: 0.5rem">
      <label style="display:flex; gap:0.5rem; align-items:center; font-weight:normal">
        <input id="budget-item-already-paid" type="checkbox" />
        <span>Already paid (record as done)</span>
      </label>
    </div>
    <menu>
      <button value="cancel" data-budget-dialog-close type="button">Cancel</button>
      <button value="save" data-budget-dialog-save type="button">Save</button>
    </menu>
  `);
  dlg.querySelector("#budget-item-dialog-title").textContent = isAdd ? "Add item" : "Edit item";
  const nameInput = dlg.querySelector("#budget-item-name");
  const plannedInput = dlg.querySelector("#budget-item-planned");
  const remainingWrap = dlg.querySelector("#budget-item-remaining-wrap");
  const remainingInput = dlg.querySelector("#budget-item-remaining");
  const paidWrap = dlg.querySelector("#budget-item-paid-wrap");
  const paidCheckbox = dlg.querySelector("#budget-item-already-paid");

  if (isAdd) {
    nameInput.value = "";
    plannedInput.value = "";
    remainingWrap.hidden = true;
    paidWrap.hidden = false;
    paidCheckbox.checked = false;
  } else {
    nameInput.value = item.name;
    plannedInput.value = formatAmountForInput(item.planned_dkk);
    remainingWrap.hidden = false;
    remainingInput.value = formatAmountForInput(item.remaining_dkk);
    paidWrap.hidden = true;
  }
  installAmountFormatter(plannedInput);
  installAmountFormatter(remainingInput);

  bindSimpleDialog(dlg, async (saveBtn) => {
    const name = nameInput.value.trim();
    const planned = parseAmount(plannedInput.value);
    if (!name) { toast("Item name required", "error"); return false; }
    if (planned === null) { toast("Enter a valid planned amount", "error"); return false; }

    if (isAdd) {
      const already = paidCheckbox.checked;
      try {
        await withBusyButton(saveBtn, "Adding…", () =>
          api.post(
            `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/items`,
            {
              category_id: categoryId,
              name,
              planned_dkk: planned,
              already_paid: already,
            },
          ),
        );
        toast(already ? "Expense logged" : "Item added");
        await renderBudget();
        return true;
      } catch (err) {
        toast(friendlyError(err, "Couldn't add item"), "error");
        return false;
      }
    } else {
      const remaining = parseAmount(remainingInput.value);
      if (remaining === null) { toast("Enter a valid remaining amount", "error"); return false; }
      try {
        await withBusyButton(saveBtn, "Saving…", () =>
          api.patch(
            `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/items/${item.id}`,
            {
              name,
              planned_dkk: planned,
              remaining_dkk: remaining,
            },
          ),
        );
        toast("Item updated");
        await renderBudget();
        return true;
      } catch (err) {
        toast(friendlyError(err, "Couldn't update item"), "error");
        return false;
      }
    }
  });
  dlg.showModal();
  blurAutoFocusedInDialog(dlg);
  // Suppress the parameter monthCategoryId — auto-creates the category on the
  // backend, so the frontend doesn't need it for the create path.
  void monthCategoryId;
}

// ── Category picker dialog ───────────────────────────────────────────────

/**
 * Multi-select category picker. Used by both the month view ("add category
 * to this month") and the template editor ("add category to template").
 *
 * Mode determines what happens when the user clicks Add:
 *   - mode="month"    → POST each selection into the current month
 *   - mode="template" → push each selection into state.templateDraft
 *
 * The dialog is recreated from scratch each open (handlers attached via
 * `onclick`, not addEventListener) so re-opens never accumulate stale
 * listeners — which was the cause of the "one click fires N adds" bug.
 */
async function openCategoryPickerDialog({ mode, excludeIds = [] }) {
  let allCats = [];
  try {
    allCats = await api.get("/categories");
  } catch (err) {
    toast(friendlyError(err, "Couldn't load categories"), "error");
    return;
  }
  state.categories = allCats;
  const excluded = new Set(excludeIds);
  const candidates = allCats.filter((c) => !excluded.has(c.id));
  if (candidates.length === 0) {
    toast("No more categories to add. Create some in Settings first.");
    return;
  }

  const dlgId = "budget-add-categories-dialog";
  let dlg = document.getElementById(dlgId);
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = dlgId;
    document.body.appendChild(dlg);
  }
  const title =
    mode === "template" ? "Add categories to template" : "Add categories to this month";
  dlg.innerHTML = `
    <h3 style="margin-top:0">${escapeHtml(title)}</h3>
    <p class="muted" style="margin-top:0">Tick one or more, then Add.</p>
    <ul id="budget-cat-pick-list" class="list-rows budget-cat-pick-list">
      ${candidates
        .map(
          (c) => `
        <li class="budget-cat-pick-row">
          <div class="budget-cat-pick-label">
            <input type="checkbox" class="tk-checkbox" data-cat-id="${c.id}" />
            <span class="cat-dot" style="background: ${escapeHtml(c.color || "var(--muted)")}"></span>
            <span>${escapeHtml(c.name)}</span>
          </div>
        </li>`,
        )
        .join("")}
    </ul>
    <menu>
      <button id="budget-cat-pick-cancel" value="cancel" type="button">Cancel</button>
      <button id="budget-cat-pick-add" class="btn-primary" value="save" type="button" disabled>Add</button>
    </menu>
  `;

  const list = dlg.querySelector("#budget-cat-pick-list");
  const addBtn = dlg.querySelector("#budget-cat-pick-add");
  const cancelBtn = dlg.querySelector("#budget-cat-pick-cancel");

  const refreshAddState = () => {
    const n = list.querySelectorAll("input[type='checkbox']:checked").length;
    addBtn.disabled = n === 0;
    addBtn.textContent = n > 1 ? `Add ${n} categories` : "Add";
  };
  list.onclick = (e) => {
    if (e.target.matches("input[type='checkbox']")) refreshAddState();
  };

  cancelBtn.onclick = () => dlg.close();

  addBtn.onclick = async () => {
    const picked = [...list.querySelectorAll("input[type='checkbox']:checked")].map(
      (cb) => cb.dataset.catId,
    );
    if (picked.length === 0) return;
    if (mode === "template") {
      // Push into the local draft; persistence happens via the editor's
      // Save / Save-as-new-version buttons.
      for (const id of picked) {
        state.templateDraft.categories.push({
          category_id: id,
          sort_order: state.templateDraft.categories.length,
          items: [],
        });
      }
      dlg.close();
      toast(picked.length === 1 ? "Category added" : `${picked.length} categories added`);
      const root = document.getElementById("budget-root");
      if (root) renderTemplateEditorHtml(root);
      return;
    }
    // mode === "month" → fire each POST and let some succeed even if others
    // fail (the categories are independent). Close + refresh always, then
    // summarize the outcome so the user isn't stuck staring at a dialog with
    // stale checkboxes for categories that are now added.
    addBtn.disabled = true;
    const originalLabel = addBtn.textContent;
    addBtn.textContent = "Adding…";
    let added = 0;
    let dupes = 0;
    let otherErrs = [];
    const results = await Promise.allSettled(
      picked.map((id) =>
        api.post(
          `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/categories`,
          { category_id: id },
        ),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") added++;
      else if (r.reason?.message === "category_already_in_month") dupes++;
      else otherErrs.push(r.reason);
    }
    addBtn.disabled = false;
    addBtn.textContent = originalLabel;
    dlg.close();
    await renderBudget();
    // Compose a single summary toast covering all three outcomes. Tone is
    // "error" iff at least one unknown failure landed; otherwise neutral.
    // The all-success / all-already-in-month / single-success short forms
    // are kept for the common cases.
    if (otherErrs.length === 0 && dupes === 0 && added > 0) {
      toast(added === 1 ? "Category added" : `${added} categories added`);
    } else if (otherErrs.length === 0 && added === 0 && dupes > 0) {
      toast("Those categories are already in this month");
    } else {
      const parts = [];
      if (added > 0) parts.push(`${added} added`);
      if (dupes > 0) parts.push(`${dupes} already in this month`);
      if (otherErrs.length > 0) parts.push(`${otherErrs.length} failed`);
      if (parts.length > 0) {
        toast(parts.join(" · "), otherErrs.length > 0 ? "error" : "info");
      }
    }
  };

  dlg.showModal();
  blurAutoFocusedInDialog(dlg);
}

// ── Template editor sub-view ────────────────────────────────────────────

async function renderTemplateEditor(root) {
  let categoriesAvailable = [];
  let template;
  try {
    [template, categoriesAvailable] = await Promise.all([
      api.get("/budget/template"),
      api.get("/categories"),
    ]);
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load template"));
    return;
  }
  state.categories = categoriesAvailable;
  if (state.templateBaseline === null) {
    state.templateBaseline = JSON.stringify(serializeTemplate(template));
    state.templateDraft = JSON.parse(JSON.stringify(template));
  }
  renderTemplateEditorHtml(root);
}

function serializeTemplate(t) {
  return {
    salary_dkk: String(t.salary_dkk),
    categories: t.categories.map((c) => ({
      category_id: c.category_id,
      sort_order: c.sort_order,
      items: c.items.map((i) => ({ name: i.name, planned_dkk: String(i.planned_dkk), sort_order: i.sort_order })),
    })),
  };
}

function templateIsDirty() {
  return JSON.stringify(serializeTemplate(state.templateDraft)) !== state.templateBaseline;
}


function renderTemplateEditorHtml(root) {
  const tpl = state.templateDraft;
  const usedCategoryIds = new Set(tpl.categories.map((c) => c.category_id));
  const addableCategories = state.categories.filter((c) => !usedCategoryIds.has(c.id));
  const planned = templatePlannedTotal(tpl);
  const salary = Number(tpl.salary_dkk || 0);
  const free = salary - planned;

  // Note: no separate "Discard changes" button. Pressing Back already
  // confirms-and-discards when the editor is dirty, which serves the same
  // purpose without a wrap-prone header button on mobile.
  root.innerHTML = `
    <div class="card budget-month-card">
      ${headerHtml({
        title: "Template",
        actions: [
          { id: "tpl-history", label: "History" },
          { id: "tpl-back", label: "Back to budget" },
        ],
      })}
      <div class="budget-salary">
        <div>
          <div class="budget-salary-label">Salary</div>
        </div>
        <input id="tpl-salary-input" type="text" inputmode="decimal" class="budget-salary-input" value="${escapeHtml(formatAmountForInput(tpl.salary_dkk))}" />
      </div>
      <div class="budget-categories">
        ${tpl.categories.map((c, ci) => renderTemplateCategoryHtml(c, ci)).join("") || '<p class="muted">No categories in this template. Add one below.</p>'}
      </div>
      <button type="button" class="budget-add-category" data-budget-action="tpl-open-add-categories">+ Add categories</button>
      <div class="budget-footer">
        <div class="budget-footer-row" data-tpl-totals="planned"><span>Total planned</span><span>${escapeHtml(fmtDKK(planned))}</span></div>
        <div class="budget-footer-row big" data-tpl-totals="salary"><span>Salary</span><span>${escapeHtml(fmtDKK(salary))}</span></div>
        <div class="budget-footer-row ${free >= 0 ? "remain" : "negative"}" data-tpl-totals="free"><span>Free money</span><span>${escapeHtml(fmtDKK(free))}</span></div>
      </div>
      <div class="budget-footer budget-template-savebar">
        <button type="button" data-budget-action="tpl-save" class="btn">Save</button>
        <button type="button" data-budget-action="tpl-snapshot" class="btn-primary">Save new version</button>
      </div>
    </div>
  `;

  bindTemplateEditorHandlers(root);
}

/** Sum of every item's planned_dkk across every category in the template
 *  draft. Used by both the initial render and the live footer updates. */
function templatePlannedTotal(tpl) {
  if (!tpl || !Array.isArray(tpl.categories)) return 0;
  return tpl.categories.reduce(
    (sum, c) => sum + (c.items || []).reduce(
      (s, i) => s + Number(i.planned_dkk || 0),
      0,
    ),
    0,
  );
}

/** Refresh the template editor's totals footer in place — same pattern
 *  the per-category total uses, so typing into an amount input doesn't
 *  blow away the cursor. */
function updateTemplateFooter(root) {
  const tpl = state.templateDraft;
  if (!tpl || !root) return;
  const planned = templatePlannedTotal(tpl);
  const salary = Number(tpl.salary_dkk || 0);
  const free = salary - planned;
  const setRow = (key, value) => {
    const span = root.querySelector(`[data-tpl-totals="${key}"] > span:last-child`);
    if (span) span.textContent = fmtDKK(value);
  };
  setRow("planned", planned);
  setRow("salary", salary);
  setRow("free", free);
  const freeRow = root.querySelector('[data-tpl-totals="free"]');
  if (freeRow) {
    freeRow.classList.toggle("remain", free >= 0);
    freeRow.classList.toggle("negative", free < 0);
  }
}

function renderTemplateCategoryHtml(cat, catIdx) {
  // The category name / color isn't on the draft directly — we look it up
  // by category_id in the loaded `state.categories`.
  const meta = state.categories.find((c) => c.id === cat.category_id);
  const name = meta?.name || "Unknown category";
  const color = meta?.color || "var(--muted)";
  const total = cat.items.reduce((acc, i) => acc + Number(i.planned_dkk || 0), 0);
  const ck = tplCollapseKey(cat.category_id);
  const isCollapsed = state.collapsed[ck] === true;
  return `
    <div class="budget-cat ${isCollapsed ? "is-collapsed" : ""}" data-cat-idx="${catIdx}" style="--cat-color: ${escapeHtml(color)};">
      <div class="budget-cat-head" data-budget-action="tpl-toggle-cat" data-cat-idx="${catIdx}" role="button" tabindex="0">
        <span class="budget-cat-name">
          <span class="budget-cat-caret">${isCollapsed ? "▸" : "▾"}</span>
          <span>${escapeHtml(name)}</span>
        </span>
        <span class="budget-cat-totals">
          <span>${escapeHtml(fmtDKK(total))}</span>
          <button type="button" data-budget-action="tpl-remove-cat" data-cat-idx="${catIdx}" class="budget-icon-btn budget-icon-btn-danger" title="Remove this category" aria-label="Remove category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </span>
      </div>
      ${
        isCollapsed
          ? ""
          : `<div class="budget-cat-body">
              ${cat.items.map((it, ii) => renderTemplateItemRow(catIdx, ii, it)).join("")}
              <button type="button" data-budget-action="tpl-add-item" data-cat-idx="${catIdx}" class="budget-add-item">+ Add item</button>
            </div>`
      }
    </div>
  `;
}

function tplCollapseKey(categoryId) {
  return `tpl-${categoryId}`;
}

function toggleTemplateCategory(catIdx) {
  const cat = state.templateDraft?.categories?.[catIdx];
  if (!cat) return;
  const key = tplCollapseKey(cat.category_id);
  state.collapsed[key] = !state.collapsed[key];
  saveCollapsed();
  const root = document.getElementById("budget-root");
  if (root) renderTemplateEditorHtml(root);
}

function renderTemplateItemRow(catIdx, itemIdx, item) {
  return `
    <div class="budget-template-item-row" data-cat-idx="${catIdx}" data-item-idx="${itemIdx}">
      <input type="text" class="budget-template-item-name" placeholder="Item name" value="${escapeHtml(item.name || "")}" />
      <input type="text" class="budget-template-item-amount" inputmode="decimal" placeholder="0" value="${escapeHtml(formatAmountForInput(item.planned_dkk))}" />
      <button type="button" data-budget-action="tpl-remove-item" data-cat-idx="${catIdx}" data-item-idx="${itemIdx}" class="budget-icon-btn budget-icon-btn-danger" title="Delete item" aria-label="Delete item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>
  `;
}

function bindTemplateEditorHandlers(root) {
  // Salary input — live update to the draft. The salary input is recreated
  // on every render, so attach to it directly (no listener-leak risk).
  const salaryInput = document.getElementById("tpl-salary-input");
  if (salaryInput) {
    installAmountFormatter(salaryInput);
    salaryInput.addEventListener("input", () => {
      const v = parseAmount(salaryInput.value);
      // Skip the update on null (empty / mid-typing). The draft keeps its
      // previous value until the user produces a parseable number — avoids
      // silently zeroing salary when the user clears the field intending to
      // retype.
      if (v === null) return;
      state.templateDraft.salary_dkk = String(v);
      updateTemplateFooter(root);
    });
  }

  // Item amount inputs need the live formatter attached too. They're
  // recreated on every render, so query and bind here — installAmount-
  // Formatter is idempotent (data-amount-fmt sentinel) so repeated calls
  // on the same node are safe.
  root.querySelectorAll(".budget-template-item-amount").forEach(installAmountFormatter);

  // Item name / amount inputs — delegate from root. Single handler swapped
  // per render so re-renders don't accumulate listeners.
  installBudgetInputHandler((e) => {
    const row = e.target.closest(".budget-template-item-row");
    if (!row) return;
    const ci = Number(row.dataset.catIdx);
    const ii = Number(row.dataset.itemIdx);
    const cat = state.templateDraft.categories[ci];
    if (!cat) return;
    const item = cat.items[ii];
    if (!item) return;
    if (e.target.classList.contains("budget-template-item-name")) {
      item.name = e.target.value;
    } else if (e.target.classList.contains("budget-template-item-amount")) {
      const v = parseAmount(e.target.value);
      // Skip if mid-typing / unparseable — keep the prior value rather than
      // silently zeroing the item's planned amount.
      if (v === null) return;
      item.planned_dkk = String(v);
      // Update the running total in the header without a full re-render —
      // typing into an amount field shouldn't blow away the user's cursor.
      const catEl = row.closest(".budget-cat");
      const totalEl = catEl?.querySelector(".budget-cat-totals > span");
      if (totalEl) {
        const total = cat.items.reduce((acc, i) => acc + Number(i.planned_dkk || 0), 0);
        totalEl.textContent = fmtDKK(total);
      }
      // Footer Total planned / Free money depend on every item, so refresh
      // those too — also in place, no full re-render.
      updateTemplateFooter(root);
    }
  });

  // (The "+ Add categories" button is wired through the standard click
  // delegate below — opens the multi-select dialog.)

  // Button-style actions: single click handler swapped per render.
  installBudgetClickHandler(async (e) => {
    const btn = e.target.closest("[data-budget-action]");
    if (!btn) return;
    const action = btn.dataset.budgetAction;
    if (action === "tpl-back") {
      if (templateIsDirty()) {
        const ok = await confirmPrompt({
          title: "Discard changes?",
          message: "Unsaved template edits will be lost.",
          okLabel: "Discard",
        });
        if (!ok) return;
      }
      state.templateDraft = null;
      state.templateBaseline = null;
      state.subView = "month";
      renderBudget();
    } else if (action === "tpl-history") {
      state.subView = "history";
      renderBudget();
    } else if (action === "tpl-toggle-cat") {
      // Clicks on the icon-button × inside the head bubble up too — skip
      // toggle when the click actually hit (or originated from) the
      // remove-category button.
      if (e.target.closest('[data-budget-action="tpl-remove-cat"]')) return;
      toggleTemplateCategory(Number(btn.dataset.catIdx));
    } else if (action === "tpl-add-item") {
      const ci = Number(btn.dataset.catIdx);
      const cat = state.templateDraft.categories[ci];
      if (!cat) return;
      cat.items.push({ name: "", planned_dkk: "0", sort_order: cat.items.length });
      renderTemplateEditorHtml(root);
    } else if (action === "tpl-remove-item") {
      const ci = Number(btn.dataset.catIdx);
      const ii = Number(btn.dataset.itemIdx);
      const cat = state.templateDraft.categories[ci];
      if (!cat) return;
      cat.items.splice(ii, 1);
      renderTemplateEditorHtml(root);
    } else if (action === "tpl-remove-cat") {
      const ci = Number(btn.dataset.catIdx);
      const cat = state.templateDraft.categories[ci];
      if (!cat) return;
      const ok = await confirmPrompt({
        title: "Remove category from template?",
        message: "Future stamps won't include it. Already-stamped months are unaffected.",
        okLabel: "Remove",
      });
      if (!ok) return;
      state.templateDraft.categories.splice(ci, 1);
      renderTemplateEditorHtml(root);
    } else if (action === "tpl-save") {
      await saveTemplateDraft(btn, /* asVersion */ false);
    } else if (action === "tpl-snapshot") {
      await openSnapshotDialog();
    } else if (action === "tpl-open-add-categories") {
      openCategoryPickerDialog({
        mode: "template",
        excludeIds: state.templateDraft.categories.map((c) => c.category_id),
      });
    }
  });
}

async function saveTemplateDraft(btn, asVersion) {
  try {
    await withBusyButton(btn, "Saving…", async () => {
      await api.patch("/budget/template", buildTemplatePatchPayload());
    });
    state.templateBaseline = JSON.stringify(serializeTemplate(state.templateDraft));
    if (!asVersion) {
      toast("Template saved");
      // Re-render so the Discard button (which was visible because the
      // editor was dirty) drops out of the header now that we match the
      // server's baseline.
      const root = document.getElementById("budget-root");
      if (root) renderTemplateEditorHtml(root);
    }
    return true;
  } catch (err) {
    toast(friendlyError(err, "Couldn't save template"), "error");
    return false;
  }
}

function buildTemplatePatchPayload() {
  const tpl = state.templateDraft;
  // Items with no name or 0 planned probably aren't intentional — strip
  // empty rows but keep zero-planned items if they have a name (user might
  // have meant to fill the amount later).
  const categories = tpl.categories.map((c) => ({
    category_id: c.category_id,
    sort_order: c.sort_order,
    items: c.items
      .filter((i) => (i.name || "").trim() !== "")
      .map((i) => ({
        name: i.name.trim(),
        planned_dkk: Number(i.planned_dkk) || 0,
        sort_order: i.sort_order,
      })),
  }));
  return {
    salary_dkk: Number(tpl.salary_dkk) || 0,
    categories,
  };
}

async function openSnapshotDialog() {
  const dlg = ensureDialog("budget-snapshot-dialog", `
    <h3 style="margin-top:0">Save as new version</h3>
    <p class="muted" style="margin-top:0">A snapshot of the current template is frozen as a labelled milestone you can compare against later. Optional label.</p>
    <label for="budget-snapshot-label">Label (optional)</label>
    <input id="budget-snapshot-label" type="text" placeholder="e.g. Post-raise May 2026" maxlength="120" />
    <menu>
      <button value="cancel" data-budget-dialog-close type="button">Cancel</button>
      <button value="save" data-budget-dialog-save type="button">Save snapshot</button>
    </menu>
  `);
  const input = dlg.querySelector("#budget-snapshot-label");
  input.value = "";
  bindSimpleDialog(dlg, async (saveBtn) => {
    // Snapshot is a save-then-snapshot pair. Wrap both calls in a single
    // busy state so the button label doesn't flicker, and track which step
    // failed so a half-success (draft saved, snapshot failed) doesn't pass
    // as "Couldn't save snapshot — try again" (which would actually
    // duplicate the saved-but-not-snapshotted state on retry-via-cancel).
    let phase = "save";
    try {
      await withBusyButton(saveBtn, "Saving…", async () => {
        await api.patch("/budget/template", buildTemplatePatchPayload());
        state.templateBaseline = JSON.stringify(serializeTemplate(state.templateDraft));
        phase = "snapshot";
        await api.post("/budget/template/versions", { label: input.value.trim() || null });
      });
      toast("Snapshot saved");
      // Reflect the cleared dirty state in the editor.
      const root = document.getElementById("budget-root");
      if (root) renderTemplateEditorHtml(root);
      return true;
    } catch (err) {
      if (phase === "snapshot") {
        toast("Template saved, but couldn't snapshot. Try History again.", "error");
        // Even though snapshot failed, the template did save — let the
        // editor's dirty state reflect that, so the user doesn't think
        // their edits were lost too.
        const root = document.getElementById("budget-root");
        if (root) renderTemplateEditorHtml(root);
      } else {
        toast(friendlyError(err, "Couldn't save snapshot"), "error");
      }
      return false;
    }
  });
  dlg.showModal();
  blurAutoFocusedInDialog(dlg);
}

// ── Version history sub-view ─────────────────────────────────────────────

async function renderVersionHistory(root) {
  let versions;
  try {
    versions = await api.get("/budget/template/versions");
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load history"));
    return;
  }
  root.innerHTML = `
    <div class="card budget-month-card">
      ${headerHtml({
        title: "Template history",
        actions: [{ id: "hist-back", label: "Back to template" }],
      })}
      ${
        versions.length === 0
          ? '<p class="muted">No versions yet. Save a snapshot from the template editor.</p>'
          : `<ul class="budget-version-list">
              ${versions.map((v) => renderVersionRow(v)).join("")}
            </ul>`
      }
    </div>
  `;
  installBudgetInputHandler(null);
  installBudgetClickHandler(async (e) => {
    const btn = e.target.closest("[data-budget-action]");
    if (!btn) return;
    const action = btn.dataset.budgetAction;
    if (action === "hist-back") {
      state.subView = "template";
      renderBudget();
    } else if (action === "view-version") {
      state.versionId = btn.dataset.versionId;
      state.subView = "version";
      renderBudget();
    }
  });
}

function renderVersionRow(v) {
  return `
    <li class="budget-version-row" data-budget-action="view-version" data-version-id="${v.id}">
      <div class="budget-version-row-head">
        <span class="budget-version-label">${escapeHtml(v.label || "Untitled snapshot")}</span>
        <span class="budget-version-date">${escapeHtml(fmtDateOnly(v.created_at))}</span>
      </div>
      <div class="budget-version-row-meta">
        <span>Salary ${escapeHtml(fmtDKK(v.salary_dkk))}</span>
        <span>${v.category_count} categor${v.category_count === 1 ? "y" : "ies"} · ${v.item_count} item${v.item_count === 1 ? "" : "s"}</span>
      </div>
    </li>
  `;
}

// ── Version detail (read-only) sub-view ─────────────────────────────────

async function renderVersionView(root) {
  if (!state.versionId) {
    state.subView = "history";
    return renderBudget();
  }
  let version;
  let allCats;
  try {
    [version, allCats] = await Promise.all([
      api.get(`/budget/template/versions/${state.versionId}`),
      api.get("/categories"),
    ]);
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load version"));
    return;
  }
  state.categories = allCats;

  root.innerHTML = `
    <div class="card budget-month-card">
      ${headerHtml({
        title: version.label || "Untitled snapshot",
        actions: [{ id: "ver-back", label: "Back to history" }],
      })}
      <p class="muted">Snapshotted ${escapeHtml(fmtDateOnly(version.created_at))}</p>
      <div class="budget-salary is-disabled">
        <div>
          <div class="budget-salary-label">Salary</div>
          <div class="budget-salary-amount">${escapeHtml(fmtDKK(version.salary_dkk))}</div>
        </div>
      </div>
      <div class="budget-categories">
        ${version.categories.map((c) => renderReadonlyCategoryHtml(c)).join("") || '<p class="muted">No categories in this version.</p>'}
      </div>
    </div>
  `;
  installBudgetInputHandler(null);
  installBudgetClickHandler((e) => {
    const btn = e.target.closest("[data-budget-action]");
    if (!btn) return;
    if (btn.dataset.budgetAction === "ver-back") {
      state.subView = "history";
      renderBudget();
    }
  });
}

function renderReadonlyCategoryHtml(cat) {
  const color = cat.category_color || "var(--muted)";
  const total = cat.items.reduce((acc, i) => acc + Number(i.planned_dkk), 0);
  return `
    <div class="budget-cat" style="--cat-color: ${escapeHtml(color)};">
      <div class="budget-cat-head budget-cat-head-static">
        <span class="budget-cat-name">
          <span>${escapeHtml(cat.category_name)}</span>
        </span>
        <span class="budget-cat-totals">${escapeHtml(fmtDKK(total))}</span>
      </div>
      <div class="budget-cat-body">
        ${cat.items.map((i) => `
          <div class="budget-item">
            <span class="budget-item-name">${escapeHtml(i.name)}</span>
            <span class="budget-item-nums">
              <span class="budget-item-remaining">${escapeHtml(fmtDKK(i.planned_dkk))}</span>
            </span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

// ── Archive sub-view ─────────────────────────────────────────────────────

async function renderArchiveView(root) {
  let months;
  try {
    months = await api.get("/budget/months");
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load archive"));
    return;
  }
  const archived = months.filter((m) => m.archived_at !== null);
  root.innerHTML = `
    <div class="card budget-month-card">
      ${headerHtml({
        title: "Archive",
        actions: [{ id: "arch-back", label: "Back to budget" }],
      })}
      ${
        archived.length === 0
          ? '<p class="muted">No archived months yet.</p>'
          : `<table class="budget-archive-table">
              <thead><tr><th>Month</th><th>Salary</th><th>Spent</th><th>Saved</th><th></th></tr></thead>
              <tbody>
                ${archived.map((m) => renderArchiveRow(m)).join("")}
              </tbody>
            </table>`
      }
    </div>
  `;
  installBudgetInputHandler(null);
  installBudgetClickHandler(async (e) => {
    const btn = e.target.closest("[data-budget-action]");
    if (!btn) return;
    const action = btn.dataset.budgetAction;
    if (action === "arch-back") {
      state.subView = "month";
      renderBudget();
    } else if (action === "arch-open") {
      state.currentMonth = { year: Number(btn.dataset.y), month: Number(btn.dataset.m) };
      state.subView = "month";
      renderBudget();
    } else if (action === "arch-unarchive") {
      const y = Number(btn.dataset.y);
      const m = Number(btn.dataset.m);
      try {
        await withBusyButton(btn, "Restoring…", () =>
          api.post(`/budget/months/${y}/${m}/unarchive`, {}),
        );
        toast("Month restored");
        await renderBudget();
      } catch (err) {
        toast(friendlyError(err, "Couldn't unarchive"), "error");
      }
    }
  });
}

function renderArchiveRow(m) {
  const saved = Number(m.planned_total_dkk) - Number(m.spent_total_dkk);
  return `
    <tr>
      <td>
        <span class="budget-archive-month-link" data-budget-action="arch-open" data-y="${m.year}" data-m="${m.month}" role="link" tabindex="0">
          ${escapeHtml(fmtMonthLabel(m.year, m.month))}
        </span>
      </td>
      <td>${escapeHtml(fmtDKK(m.salary_dkk))}</td>
      <td>${escapeHtml(fmtDKK(m.spent_total_dkk))}</td>
      <td>${escapeHtml(fmtDKK(saved))}</td>
      <td class="budget-archive-action-cell">
        <button type="button" class="budget-icon-btn" data-budget-action="arch-unarchive" data-y="${m.year}" data-m="${m.month}" title="Unarchive" aria-label="Unarchive ${escapeHtml(fmtMonthLabel(m.year, m.month))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M5 8v12h14V8"/><path d="m9 13 3-3 3 3"/><path d="M12 10v7"/></svg></button>
      </td>
    </tr>
  `;
}

// ── Dialog helpers ───────────────────────────────────────────────────────

/**
 * Make sure a <dialog> with the given id exists in document.body. If not,
 * create it with the supplied innerHTML. Returns the dialog element. Used
 * for all budget-owned dialogs — keeps them out of index.html.
 */
function ensureDialog(id, html) {
  let dlg = document.getElementById(id);
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = id;
  dlg.innerHTML = html;
  document.body.appendChild(dlg);
  return dlg;
}

/**
 * Wire the standard "Save / Cancel" footer of a dialog. The save callback
 * returns true → dialog closes; false → stays open (so the user can fix the
 * input). Without a callback, just wires the close buttons.
 */
function bindSimpleDialog(dlg, onSave = null) {
  // Cancel / close buttons.
  dlg.querySelectorAll("[data-budget-dialog-close]").forEach((btn) => {
    btn.onclick = () => dlg.close();
  });
  const saveBtn = dlg.querySelector("[data-budget-dialog-save]");
  if (saveBtn && onSave) {
    saveBtn.onclick = async () => {
      const ok = await onSave(saveBtn);
      if (ok) dlg.close();
    };
  }
}
