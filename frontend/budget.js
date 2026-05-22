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
 *
 * This file is the **dispatcher**: it routes state.subView to the right
 * render function in the sub-view modules. Heavy lifting lives in:
 *   - budget-common.js  — state, formatters, derivations, dialogs, handlers
 *   - (month + template view code will move out in follow-up commits)
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
import {
  BUDGET_SORT_OPTIONS,
  applyDraftSort,
  bindSimpleDialog,
  catPlannedTotal,
  catSpentTotal,
  collapseKey,
  ensureDialog,
  fmtDKK,
  fmtDKKBare,
  fmtDateOnly,
  fmtMonthLabel,
  formatAmountForInput,
  headerHtml,
  installAmountFormatter,
  installBudgetClickHandler,
  installBudgetInputHandler,
  isPastMonth,
  itemDone,
  monthOpenCount,
  monthPlannedTotal,
  monthSpentTotal,
  openCategoryPickerDialog,
  parseAmount,
  saveBudgetSort,
  saveCollapsed,
  sortedMonth,
  state,
  templatePlannedTotal,
  ymKey,
  ymOfPicker,
  downloadMonthCsv,
} from "./budget-common.js";

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
        ${monthExists ? `<button type="button" class="budget-icon-btn budget-export-btn" data-budget-action="export-csv" aria-label="Download CSV"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>` : ""}
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
              <button type="button" class="budget-icon-btn" data-budget-action="edit-item" data-item-id="${item.id}" title="Edit / partial pay" aria-label="Edit item"${done ? " disabled" : ""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg></button>
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
    if (action === "export-csv")    return downloadMonthCsv(month);
    if (action === "open-template") return goToSubView("template");
    if (action === "open-archive")  return goToSubView("archive");
    if (action === "stamp")         return doStampMonth(btn);
    if (action === "edit-salary")   return openSalaryDialog(month);
    if (action === "add-category")  return openCategoryPickerDialog({
      mode: "month",
      excludeIds: month.categories.map((c) => c.category_id),
      onDone: () => renderBudget(),
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

  if (isAdd) {
    nameInput.value = "";
    plannedInput.value = "";
    remainingWrap.hidden = true;
  } else {
    nameInput.value = item.name;
    plannedInput.value = formatAmountForInput(item.planned_dkk);
    remainingWrap.hidden = false;
    remainingInput.value = formatAmountForInput(item.remaining_dkk);
  }
  installAmountFormatter(plannedInput);
  installAmountFormatter(remainingInput);

  bindSimpleDialog(dlg, async (saveBtn) => {
    const name = nameInput.value.trim();
    const planned = parseAmount(plannedInput.value);
    if (!name) { toast("Item name required", "error"); return false; }
    if (planned === null) { toast("Enter a valid planned amount", "error"); return false; }

    if (isAdd) {
      try {
        await withBusyButton(saveBtn, "Adding…", () =>
          api.post(
            `/budget/months/${state.currentMonth.year}/${state.currentMonth.month}/items`,
            {
              category_id: categoryId,
              name,
              planned_dkk: planned,
            },
          ),
        );
        toast("Item added");
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
  // Suppress: addableCategories is computed for future inline-picker work
  // but the current flow uses the multi-select dialog opened on demand.
  void addableCategories;
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
        onDone: () => {
          const root = document.getElementById("budget-root");
          if (root) renderTemplateEditorHtml(root);
        },
      });
    }
  });
}

async function saveTemplateDraft(btn, asVersion) {
  try {
    // Bake the current sort preference into the draft right before the
    // PATCH lands. Template editing keeps the user's manual order while
    // they type so the cursor doesn't jump; the destructive reorder
    // happens only at this save boundary so every future stamp starts
    // in the chosen order.
    applyDraftSort(state.templateDraft, state.budgetSort);
    await withBusyButton(btn, "Saving…", async () => {
      await api.patch("/budget/template", buildTemplatePatchPayload());
    });
    state.templateBaseline = JSON.stringify(serializeTemplate(state.templateDraft));
    // Re-render so the newly-sorted order is reflected immediately. Also
    // drops the Discard button now that we match the server baseline.
    // For the snapshot path the snapshot dialog is open over the editor
    // anyway, so the updated underlying view will be revealed when it
    // closes.
    const root = document.getElementById("budget-root");
    if (root) renderTemplateEditorHtml(root);
    if (!asVersion) {
      toast("Template saved");
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
      // Bake the current sort preference into the draft just like
      // saveTemplateDraft does — this path bypasses that helper and runs
      // its own PATCH + POST, so without this call the version snapshot
      // would inherit the unsorted order while plain Save would not.
      applyDraftSort(state.templateDraft, state.budgetSort);
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

  const planned = templatePlannedTotal(version);
  const salary = Number(version.salary_dkk || 0);
  const free = salary - planned;

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
      <div class="budget-footer">
        <div class="budget-footer-row"><span>Total planned</span><span>${escapeHtml(fmtDKK(planned))}</span></div>
        <div class="budget-footer-row big"><span>Salary</span><span>${escapeHtml(fmtDKK(salary))}</span></div>
        <div class="budget-footer-row ${free >= 0 ? "remain" : "negative"}"><span>Free money</span><span>${escapeHtml(fmtDKK(free))}</span></div>
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
