/**
 * Budget — template editor + read-only version sub-views.
 *
 * Three sub-views live here:
 *   - "template"  the editable template draft + snapshot dialog
 *   - "history"   list of saved template snapshots
 *   - "version"   single read-only snapshot (drilled into from history)
 *
 * Hands re-renders back to budget.js's renderBudget when the user navigates
 * between sub-views; intra-editor refreshes call renderTemplateEditorHtml
 * directly so typing into an amount field doesn't blow away the cursor.
 *
 * The circular import on `renderBudget` from "./budget.js" is fine — ES
 * modules tolerate the cycle because both ends are call-time references,
 * never evaluated at module-load.
 */

import { api } from "./shared/api.js";
import {
  blurAutoFocusedInDialog,
  confirmPrompt,
  escapeHtml,
  friendlyError,
  toast,
  withBusyButton,
} from "./shared/ui.js";
import { paintViewError } from "./shared/view-loading.js";
import {
  applyDraftSort,
  bindSimpleDialog,
  ensureDialog,
  fmtDKK,
  fmtDateOnly,
  formatAmountForInput,
  headerHtml,
  installAmountFormatter,
  installBudgetClickHandler,
  installBudgetInputHandler,
  openCategoryPickerDialog,
  parseAmount,
  saveCollapsed,
  state,
  templatePlannedTotal,
} from "./budget-common.js";
import { renderBudget } from "./budget.js";

// ── Template editor sub-view ────────────────────────────────────────────

export async function renderTemplateEditor(root) {
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

export async function renderVersionHistory(root) {
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

export async function renderVersionView(root) {
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
