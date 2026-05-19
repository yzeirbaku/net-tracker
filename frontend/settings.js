import { api } from "./shared/api.js";
import { createDropdown } from "./shared/dropdown.js";
import { confirmPrompt, escapeHtml, toast } from "./shared/ui.js";

const ASSET_CLASSES = ["Cash", "Stocks", "Crypto", "Gold", "Pension", "Other"];
const ACCOUNT_KINDS = [
  { value: "spending", label: "Spending" },
  { value: "put_aside", label: "Put-aside" },
  { value: "wealth", label: "Wealth" },
];

const COLOR_PALETTE = [
  "#94a3b8", "#64748b", "#ef4444",
  "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981",
  "#14b8a6", "#06b6d4", "#0ea5e9",
  "#3b82f6", "#6366f1", "#8b5cf6",
  "#a855f7", "#d946ef", "#ec4899",
];
const DEFAULT_COLOR = "#94a3b8";

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
  const themeSeg = document.querySelector(".seg-group.seg-pill");
  if (themeSeg) positionSegIndicator(themeSeg);
}

function initTheme() {
  const saved = localStorage.getItem("net-tracker.theme");
  if (saved === "light" || saved === "dark") setTheme(saved);
  else setTheme("dark");
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
  if (isInitial) {
    root.innerHTML = `
      <div class="card loading-card">
        <div class="loading-row">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading settings…</span>
        </div>
      </div>
    `;
  }
  let me, cats, accts;
  try {
    [me, cats, accts] = await Promise.all([
      api.get("/auth/me"),
      api.get("/categories"),
      api.get("/accounts"),
    ]);
  } catch {
    if (isInitial) {
      root.innerHTML = `
        <div class="card">
          <p class="muted">Couldn't load settings. Try refreshing.</p>
        </div>
      `;
    }
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
      <h2>Account</h2>
      <div class="spread" style="margin-top: 0.25rem">
        <div>${escapeHtml(state.email)}</div>
      </div>
    </div>

    <div class="card">
      <h2>Theme</h2>
      <div class="seg-group seg-pill" role="radiogroup" aria-label="Theme">
        <div class="seg-indicator"></div>
        <button type="button" data-theme-value="light" role="radio">Light</button>
        <button type="button" data-theme-value="dark" role="radio">Dark</button>
      </div>
    </div>

    <section class="settings-section" data-section="categories" data-open="false">
      <button type="button" class="settings-summary" aria-expanded="false">
        <span>Categories<span class="count">${state.categories.length}</span></span>
      </button>
      <div class="settings-body-wrap">
       <div class="settings-body">
        <div class="add-row-with-color">
          <input id="cat-name" type="text" placeholder="e.g. Groceries" />
          <div class="color-picker" id="cat-color-picker" hidden>
            <span class="color-prompt">Pick a color</span>
            <button
              type="button"
              class="color-picker-trigger"
              id="cat-color-trigger"
              aria-haspopup="dialog"
              aria-expanded="false"
              aria-label="Choose color"
              style="background: ${state.pendingCatColor}"
            ></button>
            <div class="color-picker-popup" id="cat-color-popup" hidden role="dialog" aria-label="Pick a color">
              <div class="color-grid">
                ${COLOR_PALETTE.map(
                  (c) => `<button type="button" class="swatch${
                    c === state.pendingCatColor ? " active" : ""
                  }" data-color="${c}" style="background: ${c}" aria-label="Color ${c}"></button>`
                ).join("")}
              </div>
            </div>
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
              <button class="row-action" data-delete-category="${c.id}" title="Delete">×</button>
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
              <button class="row-action" data-delete-account="${a.id}" title="Delete">×</button>
            </li>`
                  )
                  .join("")
          }
        </ul>
       </div>
      </div>
    </section>
  `;
}

function mountDropdowns() {
  const mount = document.getElementById("acct-asset-mount");
  if (!mount) return;
  const dd = createDropdown({
    options: ASSET_CLASSES.map((a) => ({ value: a, label: a })),
    value: state.pendingAcctAsset,
    ariaLabel: "Asset type",
    onChange: (v) => { state.pendingAcctAsset = v; },
  });
  mount.replaceChildren(dd.element);
}

function syncAssetVisibility() {
  const field = document.getElementById("acct-asset-field");
  if (!field) return;
  field.hidden = state.pendingAcctKind !== "wealth";
}

function syncColorPickerVisibility() {
  const picker = document.getElementById("cat-color-picker");
  const input = document.getElementById("cat-name");
  if (!picker || !input) return;
  const hasName = input.value.trim().length > 0;
  picker.hidden = !hasName;
  if (!hasName) closeColorPopup();
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

function openColorPopup() {
  const popup = document.getElementById("cat-color-popup");
  const trigger = document.getElementById("cat-color-trigger");
  if (!popup || !trigger) return;
  popup.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
}

function closeColorPopup() {
  const popup = document.getElementById("cat-color-popup");
  const trigger = document.getElementById("cat-color-trigger");
  if (!popup || !trigger) return;
  popup.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
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
  if (!group) return;
  const ind = group.querySelector(".seg-indicator");
  const active = group.querySelector("button.active");
  if (!ind || !active) return;
  const w = active.offsetWidth;
  if (w === 0) return;
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

  // Category name input controls color picker visibility AND the
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
  const trigger = document.getElementById("cat-color-trigger");
  const popup = document.getElementById("cat-color-popup");
  if (trigger && popup) {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popup.hidden) openColorPopup();
      else closeColorPopup();
    });
    popup.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest(".swatch");
      if (!btn) return;
      state.pendingCatColor = btn.dataset.color;
      trigger.style.background = state.pendingCatColor;
      popup.querySelectorAll(".swatch").forEach((s) => {
        s.classList.toggle("active", s === btn);
      });
      closeColorPopup();
    });
    document.addEventListener("click", (e) => {
      if (popup.hidden) return;
      if (popup.contains(e.target)) return;
      if (trigger.contains(e.target)) return;
      closeColorPopup();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !popup.hidden) closeColorPopup();
    });
  }

  // Category add
  document.getElementById("cat-add").addEventListener("click", async () => {
    const input = document.getElementById("cat-name");
    const name = input.value.trim();
    if (!name) return;
    try {
      await api.post("/categories", { name, color: state.pendingCatColor });
      input.value = "";
      await renderSettings();
      keepOpen("categories");
    } catch (e) {
      toast(`Could not add category: ${e.message}`, "error");
    }
  });
  document.querySelectorAll("[data-delete-category]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteCategory;
      const ok = await confirmPrompt({
        title: "Delete category?",
        message: "This removes the category. Transactions categorized with it will become uncategorized.",
        okLabel: "Delete",
      });
      if (!ok) return;
      try {
        await api.delete(`/categories/${id}`);
        await renderSettings();
        keepOpen("categories");
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });

  // Account kind seg
  bindSegGroup("acct-kind-seg", "kind");

  // Account add
  document.getElementById("acct-add").addEventListener("click", async () => {
    const name = document.getElementById("acct-name").value.trim();
    const kind = state.pendingAcctKind;
    const body = { name, kind };
    if (kind === "wealth") body.asset_class = state.pendingAcctAsset;
    if (!name) {
      toast("Account name required", "error");
      return;
    }
    try {
      await api.post("/accounts", body);
      await renderSettings();
      keepOpen("accounts");
    } catch (e) {
      toast(`Could not add account: ${e.message}`, "error");
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
        await api.delete(`/accounts/${id}`);
        await renderSettings();
        keepOpen("accounts");
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });
}
