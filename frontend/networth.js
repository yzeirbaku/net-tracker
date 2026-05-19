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

function activeDelta() {
  return state.deltas.find((d) => d.period === state.activePeriod) || null;
}

function renderHtml() {
  const d = activeDelta();
  let deltaLabel = "";
  if (state.deltas.length && d) {
    const sign = Number(d.delta_dkk) >= 0 ? "+" : "−";
    const value = fmtDKK(Math.abs(Number(d.delta_dkk)));
    const prefix = d.is_since_start ? "since start: " : "";
    deltaLabel = `${prefix}${sign}${value}`;
  }
  return `
    <div class="card networth-total-card">
      <div class="networth-total-value">${fmtDKK(state.total_dkk)}</div>
      <div class="seg-group networth-period-pills" role="tablist">
        <span class="seg-indicator" aria-hidden="true"></span>
        ${PERIODS.map(
          (p) => `<button type="button" data-period="${p}" class="${
            p === state.activePeriod ? "active" : ""
          }">${p}</button>`,
        ).join("")}
      </div>
      <div class="networth-delta ${
        d && Number(d.delta_dkk) < 0 ? "networth-delta-neg" : "networth-delta-pos"
      }">${escapeHtml(deltaLabel)}</div>
    </div>
    <div class="card networth-empty"><p class="muted">Chart + composition + accounts in later tasks.</p></div>
  `;
}

function bindPeriodPills(root) {
  root.querySelectorAll(".networth-period-pills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activePeriod = btn.dataset.period;
      root.innerHTML = renderHtml();
      afterRender(root);
    });
  });
}

function positionSegIndicator(group) {
  if (!group) return;
  const ind = group.querySelector(".seg-indicator");
  const active = group.querySelector("button.active");
  if (!ind || !active) return;
  const w = active.offsetWidth;
  if (w === 0) return;
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

function afterRender(root) {
  bindPeriodPills(root);
  const pills = root.querySelector(".networth-period-pills");
  if (pills) positionSegIndicator(pills);
}
