import { api } from "./shared/api.js";
import { clearToken } from "./shared/auth.js";
import { escapeHtml, toast } from "./shared/ui.js";

const ASSET_CLASSES = ["Savings", "Stocks", "Crypto", "Gold", "Pension", "Other"];
const ACCOUNT_KINDS = [
  { value: "spending", label: "Spending (CSV-imported)" },
  { value: "savings", label: "Savings (manual net worth only)" },
  { value: "sinking_fund", label: "Sinking fund (CSV + envelopes)" },
];

const state = {
  email: null,
  categories: [],
  accounts: [],
};

function setTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem("net-tracker.theme", theme);
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
  try {
    const [me, cats, accts] = await Promise.all([
      api.get("/auth/me"),
      api.get("/categories"),
      api.get("/accounts"),
    ]);
    state.email = me.email;
    state.categories = cats;
    state.accounts = accts;
  } catch {
    return;
  }
  root.innerHTML = renderHtml();
  bindHandlers();
}

function renderHtml() {
  return `
    <h2>Account</h2>
    <div class="card spread">
      <div>Signed in as <strong>${escapeHtml(state.email)}</strong></div>
      <button class="danger-btn" id="signout-btn">Sign out</button>
    </div>

    <h2>Theme</h2>
    <div class="card row" style="gap: 12px">
      <button class="site-btn" data-theme="light">Light</button>
      <button class="site-btn" data-theme="dark">Dark</button>
    </div>

    <h2>Categories</h2>
    <div class="card">
      <div class="row" style="margin-bottom: 10px">
        <input id="cat-name" type="text" placeholder="New category name" />
        <button class="site-btn-primary" id="cat-add">Add</button>
      </div>
      <ul style="list-style: none; padding: 0; margin: 0">
        ${
          state.categories.length === 0
            ? '<li class="muted">No categories yet.</li>'
            : state.categories
                .map(
                  (c) => `
            <li class="spread" style="padding: 8px 0; border-top: 1px solid var(--border)">
              <span>${escapeHtml(c.name)}${
                c.exclude_from_spend ? ' <span class="muted">(excluded)</span>' : ""
              }</span>
              <button class="danger-btn" data-delete-category="${c.id}">Delete</button>
            </li>`
                )
                .join("")
        }
      </ul>
    </div>

    <h2>Accounts</h2>
    <div class="card">
      <div class="row" style="margin-bottom: 10px; flex-wrap: wrap; gap: 8px">
        <input id="acct-name" type="text" placeholder="Account name" style="flex: 1 1 180px" />
        <select id="acct-kind">${ACCOUNT_KINDS.map(
          (k) => `<option value="${k.value}">${k.label}</option>`
        ).join("")}</select>
        <select id="acct-asset">${ASSET_CLASSES.map(
          (a) => `<option value="${a}">${a}</option>`
        ).join("")}</select>
        <button class="site-btn-primary" id="acct-add">Add</button>
      </div>
      <ul style="list-style: none; padding: 0; margin: 0">
        ${
          state.accounts.length === 0
            ? '<li class="muted">No accounts yet.</li>'
            : state.accounts
                .map(
                  (a) => `
            <li class="spread" style="padding: 8px 0; border-top: 1px solid var(--border)">
              <span>${escapeHtml(a.name)} <span class="muted">— ${escapeHtml(
                    a.kind
                  )} · ${escapeHtml(a.asset_class)}</span></span>
              <button class="danger-btn" data-delete-account="${a.id}">Delete</button>
            </li>`
                )
                .join("")
        }
      </ul>
    </div>
  `;
}

function bindHandlers() {
  document.getElementById("signout-btn").addEventListener("click", async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    clearToken();
    location.reload();
  });

  document.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => setTheme(btn.dataset.theme));
  });

  document.getElementById("cat-add").addEventListener("click", async () => {
    const name = document.getElementById("cat-name").value.trim();
    if (!name) return;
    try {
      await api.post("/categories", { name });
      await renderSettings();
    } catch (e) {
      toast(`Could not add category: ${e.message}`, "error");
    }
  });

  document.querySelectorAll("[data-delete-category]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteCategory;
      if (!confirm("Delete this category?")) return;
      try {
        await api.delete(`/categories/${id}`);
        await renderSettings();
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });

  document.getElementById("acct-add").addEventListener("click", async () => {
    const name = document.getElementById("acct-name").value.trim();
    const kind = document.getElementById("acct-kind").value;
    const asset = document.getElementById("acct-asset").value;
    if (!name) return;
    try {
      await api.post("/accounts", { name, kind, asset_class: asset });
      await renderSettings();
    } catch (e) {
      toast(`Could not add account: ${e.message}`, "error");
    }
  });

  document.querySelectorAll("[data-delete-account]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.deleteAccount;
      if (!confirm("Delete this account? All linked data is removed.")) return;
      try {
        await api.delete(`/accounts/${id}`);
        await renderSettings();
      } catch (e) {
        toast(`Could not delete: ${e.message}`, "error");
      }
    });
  });
}
