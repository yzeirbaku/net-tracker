import { api } from "./shared/api.js";
import { createDatePicker } from "./shared/datepicker.js";
import {
  blurAutoFocusedInDialog,
  confirmPrompt,
  escapeHtml,
  friendlyError,
  toast,
  withBusyButton,
} from "./shared/ui.js";
import { paintViewError, paintViewLoading } from "./shared/view-loading.js";

export const ASSET_CLASS_ORDER = ["Cash", "Stocks", "Crypto", "Precious Metals", "Pension", "Other"];

export const ASSET_CLASS_COLORS = {
  "Cash":             "#64748b",
  "Stocks":           "#22c55e",
  "Crypto":           "#f59e0b",
  "Precious Metals":  "#eab308",
  "Pension":          "#8b5cf6",
  "Other":            "#94a3b8",
};

const PERIODS = ["1M", "3M", "6M", "1Y", "ALL"];

/**
 * DKK is pegged to EUR via ERM II at a central rate of 7.46038 ±2.25%.
 * Daily fluctuation is tiny, so a hardcoded rate is fine for the
 * supplementary EUR readout under the headline DKK total. If the user
 * ever wants a configurable rate, this constant moves to settings.
 */
const DKK_TO_EUR_RATE = 7.46038;

const VIEW_MODE_STORAGE_KEY = "net-tracker.networth.view-mode";
const VALID_VIEW_MODES = new Set(["total", "liquid", "no_pension"]);

export function getNetWorthViewMode() {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return VALID_VIEW_MODES.has(stored) ? stored : "total";
  } catch {
    return "total";
  }
}

function setNetWorthViewMode(mode) {
  if (!VALID_VIEW_MODES.has(mode)) return;
  try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* ignore quota */ }
}

const state = {
  total_dkk: 0,
  liquid_dkk: 0,
  pension_total_dkk: 0,
  pension_haircut_rate: 0.60,
  as_of: null,
  series: [],
  deltas: [],
  composition: [],
  accounts: [],
  activePeriod: "1M",
  // 'total' = raw numbers; 'liquid' = pension haircut applied everywhere on
  // the page (top number, delta, chart, donut, composition legend). Toggle
  // is visible at the top of the view, only when the portfolio actually
  // contains pension holdings.
  activeView: getNetWorthViewMode(),
  mainChart: null,
  donutChart: null,
};

const dialogState = {
  accountId: null,
  accountName: null,
  initialDate: null,
  initialValue: null,
  datepicker: null,
};

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function openBalanceDialog({ accountId, accountName, date = null, value = null }) {
  dialogState.accountId = accountId;
  dialogState.accountName = accountName;
  dialogState.initialDate = date || todayIso();
  dialogState.initialValue = value;
  const dlg = document.getElementById("balance-dialog");
  document.getElementById("balance-dialog-title").textContent = `Update balance — ${accountName}`;
  const valueInput = document.getElementById("balance-value");
  const hint = document.getElementById("balance-replace-hint");
  dialogState.datepicker.setMax(todayIso());
  // Resolve min/replace state from history up front so the picker is fully
  // configured before the dialog paints — avoids a flicker where the user
  // could briefly pick a forbidden date.
  let history = { entries: [] };
  try {
    history = await api.get(`/accounts/${dialogState.accountId}/history`);
  } catch {
    // Fall through; picker will just have no min lock.
  }
  const earliest =
    history.entries.length > 0
      ? history.entries.reduce((min, e) => (e.entry_date < min ? e.entry_date : min), history.entries[0].entry_date)
      : null;
  dialogState.datepicker.setMin(earliest);
  dialogState.datepicker.setValue(dialogState.initialDate);
  valueInput.value = value != null ? String(value) : "";
  const exists = history.entries.some((e) => e.entry_date === dialogState.datepicker.getValue());
  hint.hidden = !exists;
  if (!dlg.open) {
    dlg.showModal();
    blurAutoFocusedInDialog(dlg);
  }
}

async function refreshReplaceHint() {
  const hint = document.getElementById("balance-replace-hint");
  if (!dialogState.accountId || !dialogState.datepicker) { hint.hidden = true; return; }
  try {
    const hist = await api.get(`/accounts/${dialogState.accountId}/history`);
    const exists = hist.entries.some((e) => e.entry_date === dialogState.datepicker.getValue());
    hint.hidden = !exists;
  } catch {
    hint.hidden = true;
  }
}

function bindBalanceDialogOnce() {
  const dlg = document.getElementById("balance-dialog");
  if (!dlg || dlg.dataset.wired === "1") return;
  dlg.dataset.wired = "1";
  // Mount the custom date picker once; it's reused across opens via setValue/setMax.
  const mount = document.getElementById("balance-date-mount");
  if (!mount) {
    toast("Balance dialog markup missing", "error");
    return;
  }
  dialogState.datepicker = createDatePicker({
    value: todayIso(),
    max: todayIso(),
    onChange: () => refreshReplaceHint(),
    ariaLabel: "Entry date",
  });
  mount.appendChild(dialogState.datepicker.element);
  document.getElementById("balance-cancel").addEventListener("click", () => dlg.close());
  document.getElementById("balance-save").addEventListener("click", async (e) => {
    const valueInput = document.getElementById("balance-value");
    const date = dialogState.datepicker.getValue();
    const raw = valueInput.value.trim().replace(",", ".");
    if (!date) { toast("Date required", "error"); return; }
    if (!raw) { toast("Value required", "error"); return; }
    const num = Number(raw);
    if (!Number.isFinite(num)) { toast("Value isn't a number", "error"); return; }
    try {
      await withBusyButton(e.currentTarget, "Saving…", () =>
        api.post(`/accounts/${dialogState.accountId}/balance`, {
          entry_date: date,
          value_dkk: raw,
        }),
      );
      dlg.close();
      toast("Balance saved");
      await renderNetWorth();
    } catch (err) {
      toast(friendlyError(err, "Couldn't save balance"), "error");
    }
  });
}

function fmtDKK(n) {
  const num = Number(n);
  return num.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " dkk";
}

function fmtEUR(dkk) {
  const num = Number(dkk) / DKK_TO_EUR_RATE;
  return num.toLocaleString("de-DE", { maximumFractionDigits: 0 }) + " eur";
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

export async function renderNetWorth() {
  bindBalanceDialogOnce();
  bindHistoryDialogOnce();
  const root = document.getElementById("networth-root");
  if (!root) return;
  const isInitial = !root.firstElementChild;
  if (isInitial) paintViewLoading(root, "Loading net worth…");
  let data;
  try {
    data = await api.get("/networth");
  } catch (err) {
    if (isInitial) paintViewError(root, friendlyError(err, "Couldn't load Net Worth"));
    else toast(friendlyError(err, "Couldn't refresh Net Worth"), "error");
    return;
  }
  state.total_dkk = data.total_dkk;
  state.liquid_dkk = data.liquid_dkk;
  state.pension_total_dkk = data.pension_total_dkk;
  state.pension_haircut_rate = data.pension_haircut_rate;
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

/**
 * Pension value at a single series point, derived from the (total, liquid)
 * pair the backend ships. Since liquid = total - pension * haircut, we can
 * recover pension = (total - liquid) / haircut without a separate field.
 * Returns 0 when the haircut rate is 0 to avoid a divide-by-zero.
 */
function pensionAt(point) {
  const haircut = Number(state.pension_haircut_rate);
  if (haircut === 0) return 0;
  return (Number(point.total_dkk) - Number(point.liquid_dkk)) / haircut;
}

/**
 * Composition slices for the currently-selected view.
 *  - 'total'      → backend composition as-is.
 *  - 'liquid'     → Pension slice scaled by (1 - haircut); pcts renormalized.
 *  - 'no_pension' → Pension slice dropped entirely; pcts renormalized over
 *                   the remaining asset classes.
 */
function compositionForView() {
  if (state.activeView === "total" || state.composition.length === 0) {
    return state.composition;
  }
  if (state.activeView === "no_pension") {
    const filtered = state.composition.filter((c) => c.asset_class !== "Pension");
    const subtotal = filtered.reduce((sum, c) => sum + Number(c.value_dkk), 0);
    if (subtotal === 0) return filtered.map((c) => ({ ...c, pct: 0 }));
    return filtered
      .map((c) => ({ ...c, pct: Number(c.value_dkk) / subtotal }))
      .sort((a, b) => Number(b.value_dkk) - Number(a.value_dkk));
  }
  const haircut = Number(state.pension_haircut_rate);
  const adjusted = state.composition.map((c) => {
    const raw = Number(c.value_dkk);
    const value = c.asset_class === "Pension" ? raw * (1 - haircut) : raw;
    return { asset_class: c.asset_class, value_dkk: value };
  });
  const subtotal = adjusted.reduce((sum, c) => sum + c.value_dkk, 0);
  if (subtotal === 0) return adjusted.map((c) => ({ ...c, pct: 0 }));
  return adjusted
    .map((c) => ({ ...c, pct: c.value_dkk / subtotal }))
    .sort((a, b) => b.value_dkk - a.value_dkk);
}

function topTotalForView() {
  if (state.activeView === "liquid") return state.liquid_dkk;
  if (state.activeView === "no_pension") {
    return Number(state.total_dkk) - Number(state.pension_total_dkk);
  }
  return state.total_dkk;
}

function activeDeltaValue(d) {
  if (state.activeView === "liquid") return d.delta_liquid_dkk;
  if (state.activeView === "no_pension") {
    // delta_no_pension = delta_total - delta_pension, where
    // delta_pension is recoverable from the total/liquid delta pair using
    // the same identity as pensionAt(): pension = (total - liquid)/haircut.
    const haircut = Number(state.pension_haircut_rate);
    const deltaTotal = Number(d.delta_dkk);
    const deltaLiquid = Number(d.delta_liquid_dkk);
    if (haircut === 0) return deltaTotal;
    const deltaPension = (deltaTotal - deltaLiquid) / haircut;
    return deltaTotal - deltaPension;
  }
  return d.delta_dkk;
}

function seriesValueForView(point) {
  if (state.activeView === "liquid") return point.liquid_dkk;
  if (state.activeView === "no_pension") {
    return Number(point.total_dkk) - pensionAt(point);
  }
  return point.total_dkk;
}

function renderHtml() {
  const d = activeDelta();
  const hasHistory = state.series.length > 0;
  // Multi-day history = at least one change-date strictly before today with a
  // non-zero total. The backend always emits a 0-baseline prefix point at
  // range_from when there's any data; on its own that doesn't constitute
  // chartable history.
  const hasMultiDayHistory = state.series.some(
    (p) => p.date < state.as_of && Number(p.total_dkk) > 0,
  );
  const hasPension = Number(state.pension_total_dkk) > 0;
  const haircutPct = Math.round(Number(state.pension_haircut_rate) * 100);
  const activeDeltaNum = d ? Number(activeDeltaValue(d)) : 0;
  let deltaLabel = "";
  // Suppress the delta label when there's nothing meaningful to compare:
  //   - no entries at all, or
  //   - the comparison anchor is today (single-day history). "+0 since start"
  //     is just noise in those cases.
  if (state.deltas.length && d && d.anchor_date !== state.as_of) {
    const sign = activeDeltaNum >= 0 ? "+" : "−";
    const value = fmtDKK(Math.abs(activeDeltaNum));
    const prefix = d.is_since_start ? "since start: " : "";
    deltaLabel = `${prefix}${sign}${value}`;
  }
  const viewToggle = hasPension
    ? `<div class="seg-group seg-pill networth-view-pills" role="tablist"
            title="Total includes everything. Liquid applies a ${haircutPct}% haircut to pension holdings (Danish early-withdrawal tax). No pension excludes pension entirely.">
         <span class="seg-indicator" aria-hidden="true"></span>
         <button type="button" data-view="total" class="${
           state.activeView === "total" ? "active" : ""
         }">Total</button>
         <button type="button" data-view="liquid" class="${
           state.activeView === "liquid" ? "active" : ""
         }">Liquid</button>
         <button type="button" data-view="no_pension" class="${
           state.activeView === "no_pension" ? "active" : ""
         }">No pension</button>
       </div>`
    : "";
  return `
    <div class="card networth-total-card">
      ${viewToggle}
      <div class="networth-total-value">${fmtDKK(topTotalForView())}</div>
      <div class="networth-total-value-eur">≈ ${fmtEUR(topTotalForView())}</div>
      <div class="seg-group networth-period-pills" role="tablist">
        <span class="seg-indicator" aria-hidden="true"></span>
        ${PERIODS.map(
          (p) => `<button type="button" data-period="${p}" class="${
            p === state.activePeriod ? "active" : ""
          }">${p}</button>`,
        ).join("")}
      </div>
      <div class="networth-delta ${
        activeDeltaNum < 0 ? "networth-delta-neg" : "networth-delta-pos"
      }">${escapeHtml(deltaLabel)}</div>
    </div>
    ${(() => {
      if (!hasHistory) {
        return `<div class="card"><p class="muted">No balances tracked yet. Your wealth accounts are listed below — tap <strong>Add</strong> on each one to record its current balance and start tracking.</p></div>`;
      }
      if (!hasMultiDayHistory) {
        return `<div class="card"><p class="muted">Your net-worth chart will start forming once you record balance entries on different dates. Come back after your next update.</p></div>`;
      }
      return `<div class="card"><div class="chart-container"><canvas id="networth-main-chart"></canvas></div></div>`;
    })()}
    ${
      state.composition.length > 0
        ? `
      <div class="card">
        <h3 class="card-title">Composition</h3>
        <div class="chart-container chart-container-square">
          <canvas id="networth-donut-chart"></canvas>
        </div>
        <ul class="donut-legend">
          ${compositionForView()
            .map(
              (c) => `
                <li class="donut-legend-row">
                  <span class="donut-legend-dot" style="background:${
                    ASSET_CLASS_COLORS[c.asset_class] || "#999"
                  }"></span>
                  <span class="donut-legend-name">${escapeHtml(c.asset_class)}</span>
                  <span class="donut-legend-value">${fmtDKK(c.value_dkk)}</span>
                  <span class="donut-legend-pct">${(c.pct * 100).toFixed(1)}%</span>
                </li>`,
            )
            .join("")}
        </ul>
      </div>`
        : ""
    }
    ${
      state.accounts.length > 0
        ? Object.entries(accountsByClass())
            .filter(([, list]) => list.length > 0)
            .map(
              ([cls, list]) => `
        <section class="networth-class-section">
          <h3 class="networth-class-header">
            <span class="networth-class-dot" style="background:${ASSET_CLASS_COLORS[cls] || "#999"}"></span>
            ${escapeHtml(cls)}
          </h3>
          <div class="card networth-account-list">
            ${list
              .map(
                (a) => `
              <div class="networth-account-row${a.latest_entry_date ? "" : " networth-account-row-empty"}" data-account-id="${a.id}">
                <div class="networth-account-main">
                  <div class="networth-account-name">${escapeHtml(a.name)}</div>
                  <div class="networth-account-meta">${a.latest_entry_date ? `as of ${fmtDate(a.latest_entry_date)}` : "No balance yet"}</div>
                </div>
                <div class="networth-account-value">${a.latest_value_dkk != null ? fmtDKK(a.latest_value_dkk) : "—"}</div>
                <button class="btn-primary networth-update-btn" data-account-id="${a.id}" data-account-name="${escapeHtml(a.name)}" type="button">${a.latest_entry_date ? "Update" : "Add"}</button>
              </div>`,
              )
              .join("")}
          </div>
        </section>`,
            )
            .join("")
        : ""
    }
  `;
}

/**
 * Replace a chart canvas with a plain-text fallback when Chart.js failed to
 * load (e.g. CDN blocked, offline). Without this guard `new window.Chart(...)`
 * would throw and crash the render silently.
 */
function paintChartFallback(canvas) {
  const note = document.createElement("p");
  note.className = "muted";
  note.textContent = "Charts are unavailable right now — please refresh.";
  canvas.replaceWith(note);
}

function accountsByClass() {
  const grouped = {};
  for (const cls of ASSET_CLASS_ORDER) grouped[cls] = [];
  for (const a of state.accounts) {
    if (!grouped[a.asset_class]) grouped[a.asset_class] = [];
    grouped[a.asset_class].push(a);
  }
  return grouped;
}

function bindAccountRows(root) {
  root.querySelectorAll(".networth-update-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBalanceDialog({
        accountId: btn.dataset.accountId,
        accountName: btn.dataset.accountName,
      });
    });
  });
  root.querySelectorAll(".networth-account-row").forEach((row) => {
    row.addEventListener("click", () => {
      const acct = state.accounts.find((a) => a.id === row.dataset.accountId);
      if (!acct) return;
      openHistoryDialog(acct);
    });
  });
}

const historyState = {
  accountId: null,
  accountName: null,
  chart: null,
  entries: [],
};

async function openHistoryDialog(account) {
  historyState.accountId = account.id;
  historyState.accountName = account.name;
  const dlg = document.getElementById("account-history-dialog");
  document.getElementById("ah-title").textContent = `${account.name} — history`;
  if (!dlg.open) {
    dlg.showModal();
    blurAutoFocusedInDialog(dlg);
  }
  await refreshHistoryDialog();
}

async function refreshHistoryDialog() {
  let history;
  try {
    history = await api.get(`/accounts/${historyState.accountId}/history`);
  } catch (err) {
    toast(friendlyError(err, "Couldn't load history"), "error");
    return;
  }
  historyState.entries = history.entries;
  renderHistoryChart();
  renderHistoryList();
}

function renderHistoryChart() {
  const canvas = document.getElementById("ah-chart");
  if (!canvas) return;
  if (!window.Chart) {
    paintChartFallback(canvas);
    return;
  }
  if (historyState.chart) {
    historyState.chart.destroy();
    historyState.chart = null;
  }
  if (historyState.entries.length === 0) return;
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#22c55e";
  historyState.chart = new window.Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: historyState.entries.map((e) => e.entry_date),
      datasets: [
        {
          data: historyState.entries.map((e) => Number(e.value_dkk)),
          borderColor: accent,
          backgroundColor: accent + "33",
          fill: true,
          stepped: "before",
          pointRadius: 3,
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fmtDate(items[0].label),
            label: (item) => fmtDKK(item.parsed.y),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            callback: function (v) {
              return fmtDate(this.getLabelForValue(v)).slice(0, 5);
            },
            maxRotation: 0,
          },
        },
        y: {
          ticks: {
            callback: (v) => (Math.abs(v) >= 1e3 ? Math.round(v / 1e3) + "k" : v),
          },
        },
      },
    },
  });
}

function renderHistoryList() {
  const ul = document.getElementById("ah-entries");
  if (!ul) return;
  if (historyState.entries.length === 0) {
    ul.innerHTML = `<li class="muted ah-empty">No entries yet.</li>`;
    return;
  }
  const items = historyState.entries.slice().reverse();
  const visible = items.slice(0, 6);
  const hiddenCount = items.length - visible.length;
  ul.innerHTML = visible
    .map(
      (e) => `
      <li class="ah-entry-row">
        <span class="ah-entry-date">${fmtDate(e.entry_date)}</span>
        <span class="ah-entry-value">${fmtDKK(e.value_dkk)}</span>
        <button class="ah-action-btn" data-action="edit" data-date="${e.entry_date}" data-value="${e.value_dkk}" type="button" aria-label="Edit"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
        <button class="ah-action-btn ah-action-danger" data-action="delete" data-entry-id="${e.id}" type="button" aria-label="Delete"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </li>`,
    )
    .join("") + (hiddenCount > 0 ? `<li class="muted ah-more-note">+${hiddenCount} earlier ${hiddenCount === 1 ? "entry" : "entries"} shown in the chart above.</li>` : "");
  ul.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const dlg = document.getElementById("account-history-dialog");
      dlg.close();
      openBalanceDialog({
        accountId: historyState.accountId,
        accountName: historyState.accountName,
        date: btn.dataset.date,
        value: btn.dataset.value,
      });
    });
  });
  ul.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ok = await confirmPrompt({
        title: "Delete entry?",
        message: "This balance entry will be permanently removed.",
        okLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await withBusyButton(btn, "…", () =>
          api.delete(`/accounts/${historyState.accountId}/balance/${btn.dataset.entryId}`),
        );
        toast("Entry deleted");
        await refreshHistoryDialog();
        await renderNetWorth();
      } catch (err) {
        toast(friendlyError(err, "Couldn't delete entry"), "error");
      }
    });
  });
}

function bindHistoryDialogOnce() {
  const dlg = document.getElementById("account-history-dialog");
  if (!dlg || dlg.dataset.wired === "1") return;
  dlg.dataset.wired = "1";
  document.getElementById("ah-close").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => {
    if (historyState.chart) {
      historyState.chart.destroy();
      historyState.chart = null;
    }
  });
}

function renderDonut() {
  const canvas = document.getElementById("networth-donut-chart");
  if (!canvas || state.composition.length === 0) return;
  if (!window.Chart) {
    paintChartFallback(canvas);
    return;
  }
  if (state.donutChart) {
    state.donutChart.destroy();
    state.donutChart = null;
  }
  const slices = compositionForView();
  state.donutChart = new window.Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: slices.map((c) => c.asset_class),
      datasets: [
        {
          data: slices.map((c) => Number(c.value_dkk)),
          backgroundColor: slices.map(
            (c) => ASSET_CLASS_COLORS[c.asset_class] || "#999",
          ),
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "62%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (item) => `${item.label}: ${fmtDKK(item.parsed)}`,
          },
        },
      },
    },
  });
}

function rangeFromPeriod(period) {
  const today = new Date();
  const start = new Date(today);
  switch (period) {
    case "1M": start.setDate(today.getDate() - 30); break;
    case "3M": start.setDate(today.getDate() - 90); break;
    case "6M": start.setDate(today.getDate() - 180); break;
    case "1Y": start.setDate(today.getDate() - 365); break;
    case "ALL": return { from: null, to: today };
  }
  return { from: start, to: today };
}

function filterSeriesForPeriod(series, period) {
  const { from, to } = rangeFromPeriod(period);
  if (!from) return series.slice();
  const inRange = series.filter((p) => {
    const d = new Date(p.date);
    return d >= from && d <= to;
  });
  const prior = series.filter((p) => new Date(p.date) < from);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = to.toISOString().slice(0, 10);
  if (inRange.length === 0) {
    // No change-dates in this subrange. If there's prior history, render a
    // flat step at the carry-forward total across the period.
    if (prior.length === 0) return [];
    const last = prior[prior.length - 1];
    return [
      { date: fromIso, total_dkk: last.total_dkk, liquid_dkk: last.liquid_dkk },
      { date: toIso, total_dkk: last.total_dkk, liquid_dkk: last.liquid_dkk },
    ];
  }
  // At least one in-range point. If there's prior history, prepend a
  // synthesized prefix point at `from` carrying the pre-cutoff state — keeps
  // the line anchored to the left edge of the chart instead of leaving a
  // dead zone between `from` and the first change-date inside the subrange.
  if (prior.length > 0) {
    const last = prior[prior.length - 1];
    return [
      { date: fromIso, total_dkk: last.total_dkk, liquid_dkk: last.liquid_dkk },
      ...inRange,
    ];
  }
  return inRange;
}

function renderMainChart() {
  const canvas = document.getElementById("networth-main-chart");
  if (!canvas) return;
  if (!window.Chart) {
    paintChartFallback(canvas);
    return;
  }
  if (state.mainChart) {
    state.mainChart.destroy();
    state.mainChart = null;
  }
  const series = filterSeriesForPeriod(state.series, state.activePeriod);
  if (series.length === 0) return;
  const ctx = canvas.getContext("2d");
  const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#22c55e";
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height || 220);
  grad.addColorStop(0, accent + "66");
  grad.addColorStop(1, accent + "00");
  state.mainChart = new window.Chart(ctx, {
    type: "line",
    data: {
      labels: series.map((p) => p.date),
      datasets: [
        {
          data: series.map((p) => Number(seriesValueForView(p))),
          borderColor: accent,
          backgroundColor: grad,
          fill: true,
          stepped: "before",
          pointRadius: 0,
          borderWidth: 2,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fmtDate(items[0].label),
            label: (item) => fmtDKK(item.parsed.y),
          },
        },
      },
      scales: {
        x: {
          ticks: {
            callback: function (v) {
              const lbl = this.getLabelForValue(v);
              return fmtDate(lbl).slice(0, 5);
            },
            maxRotation: 0,
            autoSkipPadding: 12,
          },
          grid: { display: false },
        },
        y: {
          ticks: {
            callback: (v) => {
              const n = Math.abs(v);
              if (n >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
              if (n >= 1e3) return Math.round(v / 1e3) + "k";
              return v;
            },
          },
          grid: { color: "rgba(255,255,255,0.05)" },
        },
      },
    },
  });
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

function bindViewPills(root) {
  root.querySelectorAll(".networth-view-pills button").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeView = btn.dataset.view;
      setNetWorthViewMode(state.activeView);
      const group = btn.closest(".networth-view-pills");
      // Toggle .active in-place (no full re-render) so the .seg-indicator
      // element survives the click and its CSS transition can animate the
      // slide. A root.innerHTML rewrite would destroy the indicator and
      // the new one would snap into place — see positionSegIndicator's
      // .is-ready first-time guard.
      group.querySelectorAll("button").forEach((b) =>
        b.classList.toggle("active", b === btn),
      );
      positionSegIndicator(group);
      applyViewToDom(root);
    });
  });
}

/**
 * Update everything that depends on state.activeView without re-rendering
 * the whole root. Keeps the .seg-indicator alive across clicks so the
 * sliding transition fires — matches the in-place pattern used by the
 * theme toggle in settings.js.
 */
function applyViewToDom(root) {
  const top = topTotalForView();
  const totalEl = root.querySelector(".networth-total-value");
  if (totalEl) totalEl.textContent = fmtDKK(top);
  const eurEl = root.querySelector(".networth-total-value-eur");
  if (eurEl) eurEl.textContent = `≈ ${fmtEUR(top)}`;
  const deltaEl = root.querySelector(".networth-delta");
  if (deltaEl) {
    const d = activeDelta();
    const num = d ? Number(activeDeltaValue(d)) : 0;
    deltaEl.classList.toggle("networth-delta-neg", num < 0);
    deltaEl.classList.toggle("networth-delta-pos", num >= 0);
    if (state.deltas.length && d && d.anchor_date !== state.as_of) {
      const sign = num >= 0 ? "+" : "−";
      const value = fmtDKK(Math.abs(num));
      const prefix = d.is_since_start ? "since start: " : "";
      deltaEl.textContent = `${prefix}${sign}${value}`;
    } else {
      deltaEl.textContent = "";
    }
  }
  // Charts always destroy-and-recreate, so just call them again with the
  // new state — no extra cleanup needed.
  renderMainChart();
  renderDonut();
  updateDonutLegend(root);
}

function updateDonutLegend(root) {
  const ul = root.querySelector(".donut-legend");
  if (!ul) return;
  ul.innerHTML = compositionForView()
    .map(
      (c) => `
        <li class="donut-legend-row">
          <span class="donut-legend-dot" style="background:${
            ASSET_CLASS_COLORS[c.asset_class] || "#999"
          }"></span>
          <span class="donut-legend-name">${escapeHtml(c.asset_class)}</span>
          <span class="donut-legend-value">${fmtDKK(c.value_dkk)}</span>
          <span class="donut-legend-pct">${(c.pct * 100).toFixed(1)}%</span>
        </li>`,
    )
    .join("");
}

function positionSegIndicator(group) {
  if (!group || !document.contains(group)) return;
  const ind = group.querySelector(".seg-indicator");
  const active = group.querySelector("button.active");
  if (!ind || !active) return;
  const w = active.offsetWidth;
  if (w === 0) {
    // See settings.js positionSegIndicator for the rationale — retry
    // next frame so .is-ready always lands, otherwise the next user
    // click takes the firstTime branch and snaps without animation.
    requestAnimationFrame(() => positionSegIndicator(group));
    return;
  }
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
  bindViewPills(root);
  const periodPills = root.querySelector(".networth-period-pills");
  if (periodPills) positionSegIndicator(periodPills);
  const viewPills = root.querySelector(".networth-view-pills");
  if (viewPills) positionSegIndicator(viewPills);
  renderMainChart();
  renderDonut();
  bindAccountRows(root);
}
