import { api } from "./shared/api.js";
import { confirmPrompt, escapeHtml, toast } from "./shared/ui.js";

const ASSET_CLASS_ORDER = ["Cash", "Stocks", "Crypto", "Gold", "Pension", "Other"];

const ASSET_CLASS_COLORS = {
  Cash:    "#64748b",
  Stocks:  "#22c55e",
  Crypto:  "#f59e0b",
  Gold:    "#eab308",
  Pension: "#8b5cf6",
  Other:   "#94a3b8",
};

const PERIODS = ["1M", "3M", "6M", "1Y", "ALL"];

const state = {
  total_dkk: 0,
  as_of: null,
  series: [],
  deltas: [],
  composition: [],
  accounts: [],
  activePeriod: "1M",
  mainChart: null,
  donutChart: null,
};

function fmtDKK(n) {
  const num = Number(n);
  return num.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " dkk";
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export async function renderNetWorth() {
  const root = document.getElementById("networth-root");
  if (!root) return;
  const isInitial = !root.firstElementChild;
  if (isInitial) {
    root.innerHTML = `
      <div class="card loading-card">
        <div class="loading-row">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading net worth…</span>
        </div>
      </div>
    `;
  }
  let data;
  try {
    data = await api.get("/networth");
  } catch (err) {
    if (isInitial) {
      root.innerHTML = `<div class="card"><p class="muted">Couldn't load net worth: ${escapeHtml(err.message)}</p></div>`;
    } else {
      toast(`Couldn't refresh: ${err.message}`, "error");
    }
    return;
  }
  state.total_dkk = data.total_dkk;
  state.as_of = data.as_of;
  state.series = data.series;
  state.deltas = data.deltas;
  state.composition = data.composition;
  state.accounts = data.accounts;
  root.innerHTML = renderHtml();
  afterRender(root);
}

function renderHtml() {
  return `
    <div class="card networth-empty"><p class="muted">View renders in next tasks.</p></div>
  `;
}

function afterRender(root) {
  // Will be expanded in next tasks.
}
