import { api } from "./shared/api.js";
import { createColorPicker, PALETTE } from "./shared/color-picker.js";
import { createDropdown } from "./shared/dropdown.js";
import {
  confirmPrompt,
  escapeHtml,
  friendlyError,
  showDialog,
  toast,
  withBusyButton,
} from "./shared/ui.js";
import { paintViewError, paintViewLoading } from "./shared/view-loading.js";
import {
  getEffectiveYearMonth,
  isAdvanceActive,
  setAdvanceMonthEnabled,
} from "./shared/effective-month.js";
import { buildMonthCsv, buildTemplateCsv } from "./budget-common.js";
import { buildPutAsideCsv } from "./put-aside.js";
import { buildNetWorthCsv } from "./networth.js";
import { downloadBlob, makeZip } from "./shared/zip.js";

const ASSET_CLASSES = ["Cash", "Stocks", "Crypto", "Precious Metals", "Pension", "Other"];
const ACCOUNT_KINDS = [
  { value: "spending", label: "Spending" },
  { value: "put_aside", label: "Put-aside" },
  { value: "wealth", label: "Wealth" },
];

// Default to the first palette color when creating; user can pick "no color"
// inside the picker to clear it.
const DEFAULT_COLOR = PALETTE[0];

function kindLabel(value) {
  return ACCOUNT_KINDS.find((k) => k.value === value)?.label ?? value;
}

const state = {
  email: null,
  categories: [],
  accounts: [],
  pendingAcctKind: "spending",
  pendingAcctAsset: "Cash",
  pendingCatColor: DEFAULT_COLOR,
};

function setTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem("net-tracker.theme", theme);
  document.querySelectorAll("[data-theme-value]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeValue === theme);
  });
  // iOS Safari coalesces the data-theme cascade (which repaints the
  // indicator's gradient via var(--accent)) with a same-tick transform
  // mutation, occasionally dropping the transition so the pill snaps
  // instead of sliding. Defer one frame so the theme commit and the
  // transform commit land in separate frames.
  const themeSeg = document.querySelector(".seg-group.seg-pill");
  if (themeSeg) requestAnimationFrame(() => positionSegIndicator(themeSeg));
}

function initTheme() {
  const saved = localStorage.getItem("net-tracker.theme");
  if (saved === "light" || saved === "dark") setTheme(saved);
  else setTheme("dark");
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function advanceDetailText() {
  if (!isAdvanceActive()) {
    return "Treat next calendar month as the current month on Home and Budget. Useful near payday. Auto-clears when next month begins.";
  }
  const { year, month } = getEffectiveYearMonth();
  return `Showing ${MONTH_NAMES[month - 1]} ${year} as the current month.`;
}

function setAdvanceMonth(value) {
  setAdvanceMonthEnabled(value === "on");
  const seg = document.querySelector('.seg-group[aria-label="Current month"]');
  if (seg) {
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b.dataset.advanceValue === value);
    });
    positionSegIndicator(seg);
  }
  const detail = document.getElementById("advance-month-detail");
  if (detail) detail.textContent = advanceDetailText();
}

export async function renderSettings() {
  initTheme();
  const root = document.getElementById("settings-root");
  if (!root) return;
  // Only paint the loading card on the FIRST render (root empty).
  // Re-renders triggered by Add/Delete keep the current UI in place
  // until the fresh fetch lands, so the page doesn't blink each time
  // the user adds or removes a row.
  const isInitial = !root.firstElementChild;
  if (isInitial) paintViewLoading(root, "Loading profile…");
  let me, cats, accts;
  try {
    [me, cats, accts] = await Promise.all([
      api.get("/auth/me"),
      api.get("/categories"),
      api.get("/accounts"),
    ]);
  } catch {
    if (isInitial) paintViewError(root, "Couldn't load profile. Try refreshing.");
    return;
  }
  state.email = me.email;
  state.categories = cats;
  state.accounts = accts;
  root.innerHTML = renderHtml();
  initTheme();
  mountDropdowns();
  bindHandlers();
  syncAssetVisibility();
  syncColorPickerVisibility();
  // Wait one frame so the freshly-inserted DOM has been laid out and
  // offsetLeft/offsetWidth read correctly.
  requestAnimationFrame(positionAllSegIndicators);
}

// Reposition all visible seg-indicators on viewport resize so the
// pill stays under the active button when the row reflows.
if (typeof window !== "undefined" && !window.__segResizeBound) {
  window.__segResizeBound = true;
  window.addEventListener("resize", () => positionAllSegIndicators());
}

function renderHtml() {
  return `
    <div class="card">
      <div class="profile-email">${escapeHtml(state.email)}</div>
    </div>

    <section class="settings-section" data-section="categories" data-open="false">
      <button type="button" class="settings-summary" aria-expanded="false">
        <span>Categories<span class="count">${state.categories.length}</span></span>
      </button>
      <div class="settings-body-wrap">
       <div class="settings-body">
        <div class="add-row-with-color">
          <input id="cat-name" type="text" placeholder="e.g. Groceries" />
          <div class="cat-color-prompt-row" id="cat-color-picker-wrap" hidden>
            <span class="color-prompt">Pick a color</span>
            <div id="cat-color-mount"></div>
          </div>
          <button class="btn-primary" id="cat-add" type="button">Add</button>
        </div>
        <ul class="list-rows">
          ${
            state.categories.length === 0
              ? '<li class="empty">No categories yet.</li>'
              : state.categories
                  .map(
                    (c) => `
            <li>
              <span style="display:flex; align-items:center; min-width:0">
                <span class="cat-dot" style="background: ${escapeHtml(c.color || "var(--muted)")}"></span>
                <span>${escapeHtml(c.name)}${
                  c.exclude_from_spend ? ' <span class="meta">(excluded)</span>' : ""
                }</span>
              </span>
              <span style="display:flex; gap:0.4rem">
                <button class="budget-icon-btn" data-edit-category="${c.id}" type="button" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
                <button class="budget-icon-btn budget-icon-btn-danger" data-delete-category="${c.id}" type="button" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
              </span>
            </li>`
                  )
                  .join("")
          }
        </ul>
       </div>
      </div>
    </section>

    <section class="settings-section" data-section="accounts" data-open="false">
      <button type="button" class="settings-summary" aria-expanded="false">
        <span>Accounts<span class="count">${state.accounts.length}</span></span>
      </button>
      <div class="settings-body-wrap">
       <div class="settings-body">
        <div class="add-form">
          <div class="field">
            <label for="acct-name">Name</label>
            <input id="acct-name" type="text" placeholder="e.g. Danske Salary" />
          </div>
          <div class="field">
            <label>Kind</label>
            <div class="seg-group" id="acct-kind-seg" role="radiogroup" aria-label="Account kind">
              <div class="seg-indicator"></div>
              ${ACCOUNT_KINDS.map(
                (k) => `<button type="button" data-kind="${k.value}"${
                  k.value === state.pendingAcctKind ? ' class="active"' : ""
                }>${escapeHtml(k.label)}</button>`
              ).join("")}
            </div>
          </div>
          <div class="field" id="acct-asset-field" hidden>
            <label>Asset type</label>
            <div id="acct-asset-mount"></div>
          </div>
          <div class="submit-row">
            <button class="btn-primary" id="acct-add" type="button">Add</button>
          </div>
        </div>
        <ul class="list-rows">
          ${
            state.accounts.length === 0
              ? '<li class="empty">No accounts yet.</li>'
              : state.accounts
                  .map(
                    (a) => `
            <li>
              <span>
                ${escapeHtml(a.name)}
                <span class="meta">— ${escapeHtml(kindLabel(a.kind))}${
                  a.asset_class ? " · " + escapeHtml(a.asset_class) : ""
                }</span>
              </span>
              <button class="budget-icon-btn budget-icon-btn-danger" data-delete-account="${a.id}" type="button" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
            </li>`
                  )
                  .join("")
          }
        </ul>
       </div>
      </div>
    </section>

    <div class="card">
      <h2>Settings</h2>
      <div class="settings-subrow">
        <div class="settings-subrow-label">Theme</div>
        <div class="seg-group seg-pill" role="radiogroup" aria-label="Theme">
          <div class="seg-indicator"></div>
          <button type="button" data-theme-value="light" role="radio">Light</button>
          <button type="button" data-theme-value="dark" role="radio">Dark</button>
        </div>
      </div>
      <div class="settings-subrow">
        <div class="settings-subrow-label">Current month</div>
        <div class="seg-group seg-pill" role="radiogroup" aria-label="Current month">
          <div class="seg-indicator"></div>
          <button type="button" data-advance-value="off" role="radio"${
            isAdvanceActive() ? "" : ' class="active"'
          }>Off</button>
          <button type="button" data-advance-value="on" role="radio"${
            isAdvanceActive() ? ' class="active"' : ""
          }>On</button>
        </div>
        <p class="muted-tiny" id="advance-month-detail" style="margin-top:0.6rem">${advanceDetailText()}</p>
      </div>
    </div>

    <div class="profile-export">
      <button type="button" class="home-export-btn" id="profile-download-bundle">
        Download Current Net
      </button>
    </div>
  `;
}

function mountDropdowns() {
  const assetMount = document.getElementById("acct-asset-mount");
  if (assetMount) {
    const dd = createDropdown({
      options: ASSET_CLASSES.map((a) => ({ value: a, label: a })),
      value: state.pendingAcctAsset,
      ariaLabel: "Asset type",
      onChange: (v) => { state.pendingAcctAsset = v; },
    });
    assetMount.replaceChildren(dd.element);
  }

  const colorMount = document.getElementById("cat-color-mount");
  if (colorMount) {
    const taken = state.categories.map((c) => c.color).filter(Boolean);
    const picker = createColorPicker({
      value: state.pendingCatColor,
      takenColors: taken,
      onChange: (hex) => { state.pendingCatColor = hex; },
    });
    colorMount.replaceChildren(picker.element);
  }
}

function syncAssetVisibility() {
  const field = document.getElementById("acct-asset-field");
  if (!field) return;
  field.hidden = state.pendingAcctKind !== "wealth";
}

/**
 * Hide the color picker row until the user starts typing a name —
 * matches the gold-price pattern: form clues appear progressively.
 */
function syncColorPickerVisibility() {
  const wrap = document.getElementById("cat-color-picker-wrap");
  const input = document.getElementById("cat-name");
  if (!wrap || !input) return;
  wrap.hidden = input.value.trim().length === 0;
}

/**
 * Disable an Add button while its name input is empty. Visual cue
 * that the form isn't ready, plus stops accidental no-op submits.
 */
function syncAddButtonState(inputId, buttonId) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(buttonId);
  if (!input || !btn) return;
  btn.disabled = input.value.trim().length === 0;
}

function keepOpen(section) {
  const el = document.querySelector(`[data-section="${section}"]`);
  if (!el) return;
  el.dataset.open = "true";
  const btn = el.querySelector(".settings-summary");
  if (btn) btn.setAttribute("aria-expanded", "true");
}

/**
 * Instant open/close — no animation. Just toggles [data-open] on
 * the section; CSS does the rest (height 0 ↔ auto). After opening,
 * we re-position any seg-indicators inside, since their button
 * offsets read as 0 while the wrap was collapsed.
 */
function bindAccordion(section) {
  if (!section || section.dataset.accordionWired === "1") return;
  section.dataset.accordionWired = "1";
  const btn = section.querySelector(".settings-summary");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const willOpen = section.dataset.open !== "true";
    section.dataset.open = String(willOpen);
    btn.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      section.querySelectorAll(".seg-group").forEach(positionSegIndicator);
    }
  });
}

/**
 * Slide the green pill (the .seg-indicator) to the active button's
 * position + width. Called on render, on every click, after the
 * accordion that holds a seg-group opens, and on resize.
 *
 * When the seg-group is inside a closed accordion, offsets read as 0;
 * skip the update and re-run after the accordion opens.
 */
function positionSegIndicator(group) {
  if (!group || !document.contains(group)) return;
  const ind = group.querySelector(".seg-indicator");
  const active = group.querySelector("button.active");
  if (!ind || !active) return;
  const w = active.offsetWidth;
  if (w === 0) {
    // Width can be 0 when the view's layout isn't settled yet — most
    // commonly on a quick nav back to Settings, where the rAFs queued
    // by renderSettings fire before iOS has laid out the new DOM. If
    // we just return here, the .is-ready class never gets added, and
    // the very next user click takes the firstTime branch (suppressing
    // the transition) so the pill snaps instead of sliding. Retry next
    // frame so .is-ready always lands. document.contains guard above
    // bails if the group has since been detached (re-render).
    requestAnimationFrame(() => positionSegIndicator(group));
    return;
  }
  // offsetLeft is measured from the parent's padding edge, and our
  // absolute-positioned indicator with `left: 0` aligns to that same
  // padding edge — so translateX matches button.offsetLeft directly.
  // First positioning: suppress the transition so the indicator snaps
  // into place under the active button instead of sliding in from
  // the group's left edge.
  const firstTime = !ind.classList.contains("is-ready");
  if (firstTime) ind.style.transition = "none";
  ind.style.transform = `translateX(${active.offsetLeft}px)`;
  ind.style.width = `${w}px`;
  if (firstTime) {
    void ind.offsetHeight;
    ind.style.transition = "";
    ind.classList.add("is-ready");
  }
}

function positionAllSegIndicators() {
  document.querySelectorAll(".seg-group").forEach(positionSegIndicator);
}

function bindSegGroup(id, key) {
  const seg = document.getElementById(id);
  if (!seg) return;
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest(`button[data-${key}]`);
    if (!btn) return;
    const value = btn.dataset[key];
    if (key === "kind") {
      state.pendingAcctKind = value;
      syncAssetVisibility();
    }
    seg.querySelectorAll("button").forEach((b) => {
      b.classList.toggle("active", b === btn);
    });
    positionSegIndicator(seg);
  });
}

function bindHandlers() {
  document.querySelectorAll(".settings-section[data-section]").forEach(bindAccordion);

  document.querySelectorAll("[data-theme-value]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.themeValue));
  });

  document.querySelectorAll("[data-advance-value]").forEach((btn) => {
    btn.addEventListener("click", () => setAdvanceMonth(btn.dataset.advanceValue));
  });

  // Category name input drives both the color picker visibility AND the
  // Add button's disabled state.
  const nameInput = document.getElementById("cat-name");
  if (nameInput) {
    nameInput.addEventListener("input", () => {
      syncColorPickerVisibility();
      syncAddButtonState("cat-name", "cat-add");
    });
  }
  syncAddButtonState("cat-name", "cat-add");

  // Account name input drives the Account Add button's disabled state.
  const acctNameInput = document.getElementById("acct-name");
  if (acctNameInput) {
    acctNameInput.addEventListener("input", () => {
      syncAddButtonState("acct-name", "acct-add");
    });
  }
  syncAddButtonState("acct-name", "acct-add");

  // Color picker trigger toggles the popup
  // Category add — color comes from state.pendingCatColor, kept in sync by
  // the createColorPicker mount in mountDropdowns().
  document.getElementById("cat-add").addEventListener("click", async (e) => {
    const input = document.getElementById("cat-name");
    const name = input.value.trim();
    if (!name) return;
    try {
      await withBusyButton(e.currentTarget, "Adding…", () =>
        api.post("/categories", { name, color: state.pendingCatColor }),
      );
      input.value = "";
      // Roll forward to the next unused palette color so the next category
      // gets a different default — the picker still lets the user override.
      const used = new Set(state.categories.map((c) => c.color));
      const next = PALETTE.find((c) => !used.has(c)) || PALETTE[0];
      state.pendingCatColor = next;
      await renderSettings();
      keepOpen("categories");
    } catch (err) {
      toast(friendlyError(err, "Couldn't add category"), "error");
    }
  });

  document.querySelectorAll("[data-edit-category]").forEach((btn) => {
    btn.addEventListener("click", () => openEditCategoryDialog(btn.dataset.editCategory));
  });

  document.querySelectorAll("[data-delete-category]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteCategory;
      const ok = await confirmPrompt({
        title: "Delete category?",
        message: "This removes the category from your budget template and from any stamped month that uses it (including their items). Transactions categorized with it become uncategorized. Cannot be undone.",
        okLabel: "Delete",
      });
      if (!ok) return;
      try {
        await withBusyButton(btn, "Deleting…", () => api.delete(`/categories/${id}`));
        await renderSettings();
        keepOpen("categories");
      } catch (err) {
        toast(friendlyError(err, "Couldn't delete category"), "error");
      }
    });
  });

  // Account kind seg
  bindSegGroup("acct-kind-seg", "kind");

  // Account add
  document.getElementById("acct-add").addEventListener("click", async (e) => {
    const name = document.getElementById("acct-name").value.trim();
    const kind = state.pendingAcctKind;
    const body = { name, kind };
    if (kind === "wealth") body.asset_class = state.pendingAcctAsset;
    if (!name) {
      toast("Account name required", "error");
      return;
    }
    try {
      await withBusyButton(e.currentTarget, "Adding…", () => api.post("/accounts", body));
      await renderSettings();
      keepOpen("accounts");
    } catch (err) {
      toast(friendlyError(err, "Couldn't add account"), "error");
    }
  });
  document.querySelectorAll("[data-delete-account]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteAccount;
      const ok = await confirmPrompt({
        title: "Delete account?",
        message: "This removes the account and all linked data (balances, transactions, envelopes). Cannot be undone.",
        okLabel: "Delete",
      });
      if (!ok) return;
      try {
        await withBusyButton(btn, "Deleting…", () => api.delete(`/accounts/${id}`));
        await renderSettings();
        keepOpen("accounts");
      } catch (err) {
        toast(friendlyError(err, "Couldn't delete account"), "error");
      }
    });
  });

  const downloadBtn = document.getElementById("profile-download-bundle");
  if (downloadBtn) {
    downloadBtn.addEventListener("click", async () => {
      try {
        await withBusyButton(downloadBtn, "Building…", () => downloadStateBundle());
        toast("Bundle downloaded");
      } catch (err) {
        toast(friendlyError(err, "Couldn't build export"), "error");
      }
    });
  }
}

function pad2(n) { return String(n).padStart(2, "0"); }

function todayIsoLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Build and download a single ZIP containing CSV snapshots of every live
 * subsystem: budget template (draft), every active (non-archived) stamped
 * month, put-aside list, net-worth accounts. Archived months are skipped
 * — once a month is archived it's frozen history, not part of "current
 * net." Fetches in parallel; each month is a separate GET so we get the
 * full item-level detail (the /budget/months list endpoint only returns
 * summary totals).
 */
async function downloadStateBundle() {
  const [templateRes, monthsRes, putAsideRes, networthRes, categoriesRes] = await Promise.all([
    api.get("/budget/template"),
    api.get("/budget/months"),
    api.get("/put-aside"),
    api.get("/networth"),
    api.get("/categories"),
  ]);

  const months = (monthsRes || []).filter((m) => !m.archived_at);
  const monthDetails = await Promise.all(
    months.map((m) => api.get(`/budget/months/${m.year}/${m.month}`)),
  );

  const files = [];
  files.push({
    name: "budget-template.csv",
    data: buildTemplateCsv(templateRes, categoriesRes),
  });
  for (const m of monthDetails) {
    files.push({
      name: `budget-${m.year}-${pad2(m.month)}.csv`,
      data: buildMonthCsv(m),
    });
  }
  files.push({ name: "put-aside.csv", data: buildPutAsideCsv(putAsideRes) });
  files.push({ name: "net-worth.csv", data: buildNetWorthCsv(networthRes) });

  const zipBytes = makeZip(files);
  downloadBlob(zipBytes, `net-tracker-export-${todayIsoLocal()}.zip`, "application/zip");
}

// ── Edit category dialog ───────────────────────────────────────────────

async function openEditCategoryDialog(categoryId) {
  // Re-fetch /categories so the taken-color set is fresh (covers the case
  // where another tab or a recent edit changed assignments since the
  // settings list was rendered).
  let cats = state.categories;
  try {
    cats = await api.get("/categories");
    state.categories = cats;
  } catch {
    // Fall back to the cached list — still usable.
  }
  const cat = cats.find((c) => c.id === categoryId);
  if (!cat) return;

  // Recreate the dialog content fresh each open — avoids stale handlers
  // on a reused DOM. Same pattern as the budget add-category dialog.
  let dlg = document.getElementById("edit-category-dialog");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "edit-category-dialog";
    document.body.appendChild(dlg);
  }

  const takenSet = new Set(
    cats.filter((c) => c.id !== cat.id && c.color).map((c) => c.color),
  );
  const visiblePalette = PALETTE.filter((hex) => {
    const isCurrent = cat.color && hex.toLowerCase() === cat.color.toLowerCase();
    return isCurrent || !takenSet.has(hex);
  });

  let pickedColor = cat.color || visiblePalette[0] || null;

  const swatchHtml = (hex, isActive) =>
    `<button type="button" class="inline-swatch${isActive ? " active" : ""}" data-color="${escapeHtml(hex)}" style="background: ${escapeHtml(hex)}" title="Color ${escapeHtml(hex)}" aria-label="Color ${escapeHtml(hex)}"></button>`;

  dlg.innerHTML = `
    <h3 style="margin-top:0">Edit category</h3>
    <label for="edit-cat-name">Name</label>
    <input id="edit-cat-name" type="text" />
    <div class="field" style="margin-top:0.5rem">
      <label>Color</label>
      <div id="edit-cat-swatches" class="inline-swatch-grid">
        ${visiblePalette
          .map((hex) => {
            const isActive =
              pickedColor && hex.toLowerCase() === pickedColor.toLowerCase();
            return swatchHtml(hex, isActive);
          })
          .join("")}
      </div>
    </div>
    <menu>
      <button id="edit-cat-cancel" value="cancel" type="button">Cancel</button>
      <button id="edit-cat-save" value="save" type="button">Save</button>
    </menu>
  `;

  const nameInput = dlg.querySelector("#edit-cat-name");
  nameInput.value = cat.name;

  const grid = dlg.querySelector("#edit-cat-swatches");
  grid.onclick = (e) => {
    const sw = e.target.closest(".inline-swatch");
    if (!sw) return;
    const hex = sw.dataset.color;
    pickedColor = hex;
    grid.querySelectorAll(".inline-swatch").forEach((s) => {
      s.classList.toggle(
        "active",
        s.dataset.color.toLowerCase() === hex.toLowerCase(),
      );
    });
  };

  dlg.querySelector("#edit-cat-cancel").onclick = () => dlg.close();

  const saveBtn = dlg.querySelector("#edit-cat-save");
  saveBtn.onclick = async () => {
    const newName = nameInput.value.trim();
    if (!newName) { toast("Name required", "error"); return; }
    try {
      await withBusyButton(saveBtn, "Saving…", () =>
        api.patch(`/categories/${cat.id}`, {
          name: newName,
          color: pickedColor,
        }),
      );
      dlg.close();
      toast("Category updated");
      await renderSettings();
      keepOpen("categories");
    } catch (err) {
      toast(friendlyError(err, "Couldn't update category"), "error");
    }
  };

  showDialog(dlg);
}
