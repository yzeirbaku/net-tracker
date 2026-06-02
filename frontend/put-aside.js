/**
 * Put-aside — a flat list of named amounts the user has earmarked for upcoming
 * spend (no dates, no buckets, no history). The list IS the current state.
 *
 * Reachable from the Home tile (`data-home-nav="put-aside"`) only; deliberately
 * not in the drawer to keep top-level navigation lean. Use the hamburger /
 * Home tile to navigate back.
 */

import { api } from "./shared/api.js";
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
  fmtDKK,
  formatAmountForInput,
  installAmountFormatter,
  parseAmount,
} from "./budget-common.js";

let booted = false;
let cached = { total_dkk: 0, items: [] };

function rowHtml(item) {
  return `
    <li class="put-aside-row" data-item-id="${item.id}">
      <span class="put-aside-name">${escapeHtml(item.name)}</span>
      <span class="put-aside-amount">${fmtDKK(item.amount_dkk)}</span>
      <span class="put-aside-actions">
        <button type="button" class="budget-icon-btn" data-pa-action="edit" aria-label="Edit ${escapeHtml(item.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
        <button type="button" class="budget-icon-btn budget-icon-btn-danger" data-pa-action="delete" aria-label="Delete ${escapeHtml(item.name)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </span>
    </li>
  `;
}

function paint(root) {
  const items = cached.items || [];
  const total = Number(cached.total_dkk || 0);

  const listBody = items.length
    ? `<ul class="put-aside-list">${items.map(rowHtml).join("")}</ul>`
    : `<div class="put-aside-empty">
         <p class="muted" style="margin:0 0 0.6rem">Nothing set aside yet.</p>
       </div>`;

  root.innerHTML = `
    <div class="card put-aside-card">
      <div class="put-aside-header">
        <div>
          <div class="put-aside-label">Total set aside</div>
          <div class="put-aside-total">${fmtDKK(total)}</div>
        </div>
        <button type="button" class="btn-primary" data-pa-action="add">+ Add item</button>
      </div>
      ${listBody}
    </div>
  `;
}

async function refresh(root) {
  try {
    cached = await api.get("/put-aside");
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load Put Aside"));
    return;
  }
  paint(root);
}

function ensureItemDialog() {
  let dlg = document.getElementById("put-aside-item-dialog");
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.id = "put-aside-item-dialog";
  dlg.innerHTML = `
    <h3 id="put-aside-item-title" style="margin-top:0">Add item</h3>
    <label for="put-aside-item-name">Name</label>
    <input id="put-aside-item-name" type="text" placeholder="e.g. Car insurance" />
    <label for="put-aside-item-amount">Amount (DKK)</label>
    <input id="put-aside-item-amount" type="text" inputmode="decimal" placeholder="e.g. 4200" />
    <menu>
      <button id="put-aside-item-cancel" value="cancel" type="button">Cancel</button>
      <button id="put-aside-item-save" class="btn-primary" value="save" type="button">Save</button>
    </menu>
  `;
  document.body.appendChild(dlg);
  return dlg;
}

async function openItemDialog({ mode, item }, root) {
  const isAdd = mode === "add";
  const dlg = ensureItemDialog();
  dlg.querySelector("#put-aside-item-title").textContent = isAdd ? "Add item" : "Edit item";
  const nameInput = dlg.querySelector("#put-aside-item-name");
  const amountInput = dlg.querySelector("#put-aside-item-amount");
  const cancelBtn = dlg.querySelector("#put-aside-item-cancel");
  const saveBtn = dlg.querySelector("#put-aside-item-save");

  nameInput.value = isAdd ? "" : item.name;
  amountInput.value = isAdd ? "" : formatAmountForInput(item.amount_dkk);
  installAmountFormatter(amountInput);

  cancelBtn.onclick = () => dlg.close();
  saveBtn.onclick = async () => {
    const name = nameInput.value.trim();
    const amount = parseAmount(amountInput.value);
    if (!name) { toast("Name required", "error"); return; }
    if (amount === null) { toast("Enter a valid amount", "error"); return; }

    try {
      if (isAdd) {
        await withBusyButton(saveBtn, "Adding…", () =>
          api.post("/put-aside/items", { name, amount_dkk: amount }),
        );
        toast("Added");
      } else {
        await withBusyButton(saveBtn, "Saving…", () =>
          api.put(`/put-aside/items/${item.id}`, { name, amount_dkk: amount }),
        );
        toast("Saved");
      }
      dlg.close();
      await refresh(root);
    } catch (err) {
      toast(friendlyError(err, isAdd ? "Couldn't add item" : "Couldn't save item"), "error");
    }
  };

  showDialog(dlg);
}

async function handleDelete(itemId, itemName, root) {
  const ok = await confirmPrompt({
    title: "Delete item",
    message: `Delete "${itemName}" from your put-aside list?`,
    okLabel: "Delete",
  });
  if (!ok) return;
  try {
    await api.delete(`/put-aside/items/${itemId}`);
    toast("Deleted");
    await refresh(root);
  } catch (err) {
    toast(friendlyError(err, "Couldn't delete item"), "error");
  }
}

function bindEvents(root) {
  if (root.__paBound) return;
  root.__paBound = true;
  root.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-pa-action]");
    if (!btn) return;
    const action = btn.dataset.paAction;
    if (action === "add") {
      await openItemDialog({ mode: "add" }, root);
      return;
    }
    const row = btn.closest(".put-aside-row");
    if (!row) return;
    const itemId = row.dataset.itemId;
    const item = (cached.items || []).find((it) => it.id === itemId);
    if (!item) return;
    if (action === "edit") {
      await openItemDialog({ mode: "edit", item }, root);
    } else if (action === "delete") {
      await handleDelete(item.id, item.name, root);
    }
  });
}

export async function renderPutAside() {
  const root = document.getElementById("put-aside-root");
  if (!root) return;
  if (!booted) paintViewLoading(root);
  bindEvents(root);
  await refresh(root);
  booted = true;
}

/** Lightweight summary fetched in parallel by the Home tile. */
export async function fetchPutAsideSummary() {
  return api.get("/put-aside");
}
