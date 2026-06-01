/**
 * Budget — shared infrastructure used by every sub-view (month / template /
 * version history / version detail / archive).
 *
 * This module owns:
 *   - module state + localStorage persistence (collapsed map, sort preference)
 *   - sort algorithms (sortedMonth, applyDraftSort)
 *   - number/date/CSV formatters + the amount-input live formatter
 *   - per-category and per-month derivations (totals, open count, item done)
 *   - the shared headerHtml chrome
 *   - dialog helpers (ensureDialog, bindSimpleDialog)
 *   - the #budget-root click/keydown/input handler installers
 *   - the multi-select category picker dialog (used by month + template)
 *
 * The category-picker takes an `onDone` callback so it doesn't need to know
 * which sub-view called it — caller wires the appropriate re-render.
 */

import {
  blurAutoFocusedInDialog,
  escapeHtml,
  friendlyError,
  toast,
} from "./shared/ui.js";
import { api } from "./shared/api.js";
import {
  ADVANCE_MONTH_EVENT,
  getEffectiveYearMonth,
} from "./shared/effective-month.js";

// ── State ────────────────────────────────────────────────────────────────

export const state = {
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

export function defaultMonth() {
  return getEffectiveYearMonth();
}

// When the Settings "current month" toggle flips, snap the budget view
// back to its default landing so the next visit lands on the effective
// month. Picking a month via the picker still wins for the rest of the
// session, but the toggle is an explicit "change my default" action.
if (typeof window !== "undefined") {
  window.addEventListener(ADVANCE_MONTH_EVENT, () => {
    state.currentMonth = defaultMonth();
  });
}

// True when (year, month) is strictly before the current calendar month.
// The Stamp button is hidden for these; the backend also rejects with
// 400 cannot_stamp_past_month, but the UI shouldn't even offer it.
export function isPastMonth(year, month) {
  const today = new Date();
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  if (year < ty) return true;
  if (year > ty) return false;
  return month < tm;
}

export function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function ymOfPicker() {
  return ymKey(state.currentMonth.year, state.currentMonth.month);
}

function loadCollapsed() {
  try {
    return JSON.parse(localStorage.getItem("net-tracker.budget.collapsed") || "{}");
  } catch {
    return {};
  }
}

export function saveCollapsed() {
  localStorage.setItem("net-tracker.budget.collapsed", JSON.stringify(state.collapsed));
}

export const BUDGET_SORT_OPTIONS = [
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

export function saveBudgetSort(s) {
  localStorage.setItem("net-tracker.budget.sort", s);
}

/** Reorder the template draft's categories + items per the given mode and
 *  reassign sort_order on both so the new order survives the save. Unlike
 *  sortedMonth, this is a destructive in-place rewrite — meant to run at
 *  Save / Save new version time, baking the chosen order into the template
 *  so every future stamp starts in that order. */
export function applyDraftSort(draft, mode) {
  if (!draft || !Array.isArray(draft.categories)) return;
  const sortItems = (items) => {
    const sorted = [...items];
    if (mode === "alpha") {
      sorted.sort((a, b) =>
        (a.name || "").localeCompare(b.name || ""),
      );
    } else {
      sorted.sort(
        (a, b) => Number(b.planned_dkk || 0) - Number(a.planned_dkk || 0),
      );
    }
    return sorted.map((it, i) => ({ ...it, sort_order: i }));
  };
  const cats = draft.categories.map((c) => ({
    ...c,
    items: sortItems(c.items || []),
  }));
  cats.sort((a, b) => {
    if (mode === "alpha") {
      const aname = state.categories.find((c) => c.id === a.category_id)?.name || "";
      const bname = state.categories.find((c) => c.id === b.category_id)?.name || "";
      return aname.localeCompare(bname);
    }
    const at = (a.items || []).reduce((s, i) => s + Number(i.planned_dkk || 0), 0);
    const bt = (b.items || []).reduce((s, i) => s + Number(i.planned_dkk || 0), 0);
    return bt - at;
  });
  draft.categories = cats.map((c, i) => ({ ...c, sort_order: i }));
}

/** Return a shallow-cloned month with categories and items reordered
 *  by state.budgetSort. The original `month` and its arrays are not
 *  mutated — keeps re-renders idempotent and lets the source-of-truth
 *  month payload retain its server-side sort_order. */
export function sortedMonth(month) {
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

export function collapseKey(year, month, monthCategoryId) {
  return `${year}-${month}-${monthCategoryId}`;
}

// ── Formatters ───────────────────────────────────────────────────────────

const _MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtDKK(n) {
  const num = Number(n);
  return num.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " dkk";
}

export function fmtDKKBare(n) {
  return Number(n).toLocaleString("de-DE", { maximumFractionDigits: 0 });
}

export function fmtMonthLabel(year, month) {
  return `${_MONTH_NAMES[month - 1]} ${year}`;
}

export function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy} ${hh}:${min}`;
}

export function fmtDateOnly(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${dd}-${mm}-${yyyy}`;
}

// Parse a string the user typed into an amount input. Accepts "1.500", "1500",
// "1500,50", "1.500,50" — Danish-style. Returns Number, or null if invalid.
export function parseAmount(s) {
  if (typeof s !== "string") return null;
  const cleaned = s.replace(/\s/g, "").replaceAll(".", "").replace(",", ".");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

/**
 * Build a UTF-8-with-BOM CSV string from a stamped month payload.
 * Columns: Category, Item, Planned (dkk), Remaining (dkk), Ticked, Ticked at.
 * Quotes Category/Item per RFC 4180; embedded quotes doubled.
 */
export function buildMonthCsv(month) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = ['Category,Item,Planned (dkk),Remaining (dkk),Ticked,Ticked at'];
  // Extra income — optional one-off income line. Sits at the top so the
  // section header below is still recognizable as the item table.
  if (month.extra_income_name) {
    lines.push([
      esc("Income"),
      esc(month.extra_income_name),
      Number(month.extra_income_dkk),
      "",
      "",
      "",
    ].join(","));
  }
  for (const cat of (month.categories || [])) {
    for (const item of (cat.items || [])) {
      const ticked = (item.ticked_at !== null && item.ticked_at !== undefined) || Number(item.remaining_dkk) <= 0;
      lines.push([
        esc(cat.category_name),
        esc(item.name),
        Number(item.planned_dkk),
        Number(item.remaining_dkk),
        ticked ? "yes" : "no",
        esc(item.ticked_at || ""),
      ].join(","));
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function downloadMonthCsv(month) {
  const csv = buildMonthCsv(month);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const ym = `${month.year}-${String(month.month).padStart(2, "0")}`;
  const a = document.createElement("a");
  a.href = url;
  a.download = `budget-${ym}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Build a UTF-8-with-BOM CSV string from a template-shaped object. Three
 * columns: Category, Item, Planned (dkk). A single meta row "Salary,,N"
 * carries the salary so the file round-trips a complete template. Items
 * are emitted in (category.sort_order, item.sort_order) order; the salary
 * row is always emitted (even if salary = 0) so the format is regular.
 */
export function buildTemplateCsv(template, categories) {
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const lines = ['Category,Item,Planned (dkk)'];
  const salary = Number(template?.salary_dkk || 0);
  lines.push([esc("Salary"), esc(""), salary].join(","));
  const nameById = new Map((categories || []).map((c) => [c.id, c.name]));
  const cats = [...(template?.categories || [])].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  for (const cat of cats) {
    const name = nameById.get(cat.category_id) || "Unknown category";
    const items = [...(cat.items || [])].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    for (const item of items) {
      lines.push([esc(name), esc(item.name), Number(item.planned_dkk)].join(","));
    }
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

export function downloadTemplateCsv(template, categories) {
  const csv = buildTemplateCsv(template, categories);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "budget-template.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Parse a CSV string into an array of rows (each row = array of cell strings).
 * Handles CRLF/LF line endings, double-quoted fields, and embedded quotes
 * via the "" escape. Trailing empty lines are dropped. A leading BOM is
 * stripped. Returns [] on empty input.
 */
export function parseCsv(text) {
  if (typeof text !== "string" || text === "") return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
    }
    if (ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
    }
    cell += ch; i++;
  }
  row.push(cell);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return rows;
}

/** Format a numeric value as a Danish-style amount string for an input
 *  field's initial value: dots every three digits, no currency suffix. */
export function formatAmountForInput(n) {
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
export function installAmountFormatter(input) {
  if (!input || input.dataset.amountFmt === "1") return;
  input.dataset.amountFmt = "1";
  input.addEventListener("input", () => liveFormatAmountInput(input));
}

// ── Derivations ──────────────────────────────────────────────────────────

export function itemDone(item) {
  return item.ticked_at !== null || Number(item.remaining_dkk) <= 0;
}

export function monthPlannedTotal(month) {
  let total = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) total += Number(it.planned_dkk);
  }
  return total;
}

export function monthSpentTotal(month) {
  let total = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) total += Number(it.planned_dkk) - Number(it.remaining_dkk);
  }
  return total;
}

export function monthOpenCount(month) {
  let n = 0;
  for (const cat of month.categories) {
    for (const it of cat.items) if (!itemDone(it)) n++;
  }
  return n;
}

export function catPlannedTotal(cat) {
  return cat.items.reduce((acc, it) => acc + Number(it.planned_dkk), 0);
}

export function catSpentTotal(cat) {
  return cat.items.reduce(
    (acc, it) => acc + (Number(it.planned_dkk) - Number(it.remaining_dkk)),
    0,
  );
}

/** Sum of every item's planned_dkk across every category in a template
 *  draft (or a version). Used by the template editor and the version
 *  detail view. */
export function templatePlannedTotal(tpl) {
  if (!tpl || !Array.isArray(tpl.categories)) return 0;
  return tpl.categories.reduce(
    (sum, c) => sum + (c.items || []).reduce(
      (s, i) => s + Number(i.planned_dkk || 0),
      0,
    ),
    0,
  );
}

// ── Header (shared across sub-views) ─────────────────────────────────────

export function headerHtml({ title, actions = [] }) {
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

// ── Root-level event handler installers ──────────────────────────────────

/**
 * Attach a click handler to #budget-root, replacing any previously attached
 * handler. Used by every sub-view so re-renders don't leak listeners.
 *
 * The same handler is also wired up as a keydown handler that fires on
 * Enter / Space when an element with role="button" or role="link" is
 * focused — so non-<button> clickables (collapse toggle, archive month
 * link) are keyboard-accessible.
 */
export function installBudgetClickHandler(handler) {
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

export function installBudgetInputHandler(handler) {
  const root = document.getElementById("budget-root");
  if (!root) return;
  if (root.__budgetInputHandler) {
    root.removeEventListener("input", root.__budgetInputHandler);
  }
  root.__budgetInputHandler = handler;
  if (handler) root.addEventListener("input", handler);
}

// ── Dialog helpers ───────────────────────────────────────────────────────

/**
 * Make sure a <dialog> with the given id exists in document.body. If not,
 * create it with the supplied innerHTML. Returns the dialog element. Used
 * for all budget-owned dialogs — keeps them out of index.html.
 */
export function ensureDialog(id, html) {
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
export function bindSimpleDialog(dlg, onSave = null) {
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

// ── Category picker dialog ───────────────────────────────────────────────

/**
 * Multi-select category picker. Used by both the month view ("add category
 * to this month") and the template editor ("add category to template").
 *
 * Mode determines what happens when the user clicks Add:
 *   - mode="month"    → POST each selection into the current month
 *   - mode="template" → push each selection into state.templateDraft
 *
 * `onDone` is called after the dialog closes (after either branch), with no
 * arguments — caller decides whether to trigger a full renderBudget() or
 * just re-render the template editor in place.
 *
 * The dialog is recreated from scratch each open (handlers attached via
 * `onclick`, not addEventListener) so re-opens never accumulate stale
 * listeners — which was the cause of the "one click fires N adds" bug.
 */
export async function openCategoryPickerDialog({ mode, excludeIds = [], onDone }) {
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
      await onDone?.();
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
    const otherErrs = [];
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
    await onDone?.();
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
