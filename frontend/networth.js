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

const dialogState = {
  accountId: null,
  accountName: null,
  entryId: null,
  initialDate: null,
  initialValue: null,
};

function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function openBalanceDialog({ accountId, accountName, entryId = null, date = null, value = null }) {
  dialogState.accountId = accountId;
  dialogState.accountName = accountName;
  dialogState.entryId = entryId;
  dialogState.initialDate = date || todayIso();
  dialogState.initialValue = value;
  const dlg = document.getElementById("balance-dialog");
  document.getElementById("balance-dialog-title").textContent = `Update balance — ${accountName}`;
  const dateInput = document.getElementById("balance-date");
  const valueInput = document.getElementById("balance-value");
  const hint = document.getElementById("balance-replace-hint");
  dateInput.value = dialogState.initialDate;
  dateInput.max = todayIso();
  valueInput.value = value != null ? String(value) : "";
  hint.hidden = true;
  if (!dlg.open) dlg.showModal();
  await refreshReplaceHint();
}

async function refreshReplaceHint() {
  const dateInput = document.getElementById("balance-date");
  const hint = document.getElementById("balance-replace-hint");
  if (!dialogState.accountId) { hint.hidden = true; return; }
  try {
    const hist = await api.get(`/accounts/${dialogState.accountId}/history`);
    const exists = hist.entries.some((e) => e.entry_date === dateInput.value);
    hint.hidden = !exists;
  } catch {
    hint.hidden = true;
  }
}

function bindBalanceDialogOnce() {
  const dlg = document.getElementById("balance-dialog");
  if (!dlg || dlg.dataset.wired === "1") return;
  dlg.dataset.wired = "1";
  document.getElementById("balance-cancel").addEventListener("click", () => dlg.close());
  document.getElementById("balance-date").addEventListener("change", refreshReplaceHint);
  document.getElementById("balance-save").addEventListener("click", async () => {
    const dateInput = document.getElementById("balance-date");
    const valueInput = document.getElementById("balance-value");
    const date = dateInput.value;
    const raw = valueInput.value.trim().replace(",", ".");
    if (!date) { toast("Date required", "error"); return; }
    if (!raw) { toast("Value required", "error"); return; }
    const num = Number(raw);
    if (!Number.isFinite(num)) { toast("Value isn't a number", "error"); return; }
    const btn = document.getElementById("balance-save");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Saving…";
    try {
      await api.post(`/accounts/${dialogState.accountId}/balance`, {
        entry_date: date,
        value_dkk: raw,
      });
      dlg.close();
      toast("Balance saved");
      await renderNetWorth();
    } catch (err) {
      toast(`Couldn't save: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  });
}

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
  bindBalanceDialogOnce();
  bindHistoryDialogOnce();
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
  const hasHistory = state.series.length > 0;
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
    ${
      hasHistory
        ? `<div class="card"><div class="chart-container"><canvas id="networth-main-chart"></canvas></div></div>`
        : `<div class="card"><p class="muted">No balance entries yet. Add one from Settings → Accounts (or use the Update button below) to start tracking.</p></div>`
    }
    ${
      state.composition.length > 0
        ? `
      <div class="card">
        <h3 class="card-title">Composition</h3>
        <div class="chart-container chart-container-square">
          <canvas id="networth-donut-chart"></canvas>
        </div>
        <ul class="donut-legend">
          ${state.composition
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
              <div class="networth-account-row" data-account-id="${a.id}">
                <div class="networth-account-main">
                  <div class="networth-account-name">${escapeHtml(a.name)}</div>
                  <div class="networth-account-meta">as of ${fmtDate(a.latest_entry_date)}</div>
                </div>
                <div class="networth-account-spark">${sparklineSvg(a.sparkline)}</div>
                <div class="networth-account-value">${fmtDKK(a.latest_value_dkk)}</div>
                <button class="btn-primary networth-update-btn" data-account-id="${a.id}" data-account-name="${escapeHtml(a.name)}" type="button">Update</button>
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

function accountsByClass() {
  const grouped = {};
  for (const cls of ASSET_CLASS_ORDER) grouped[cls] = [];
  for (const a of state.accounts) {
    if (!grouped[a.asset_class]) grouped[a.asset_class] = [];
    grouped[a.asset_class].push(a);
  }
  return grouped;
}

function sparklineSvg(points) {
  if (!points || points.length < 2) {
    return `<svg class="account-sparkline" viewBox="0 0 60 20" aria-hidden="true"></svg>`;
  }
  const values = points.map((p) => Number(p.value_dkk));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 60;
  const H = 20;
  const step = W / (points.length - 1);
  const coords = points
    .map((p, i) => {
      const x = (i * step).toFixed(2);
      const y = (H - ((Number(p.value_dkk) - min) / range) * H).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  return `
    <svg class="account-sparkline" viewBox="0 0 ${W} ${H}" aria-hidden="true">
      <polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
    </svg>
  `;
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
  if (!dlg.open) dlg.showModal();
  await refreshHistoryDialog();
}

async function refreshHistoryDialog() {
  let history;
  try {
    history = await api.get(`/accounts/${historyState.accountId}/history`);
  } catch (err) {
    toast(`Couldn't load history: ${err.message}`, "error");
    return;
  }
  historyState.entries = history.entries;
  renderHistoryChart();
  renderHistoryList();
}

function renderHistoryChart() {
  const canvas = document.getElementById("ah-chart");
  if (!canvas || !window.Chart) return;
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
  ul.innerHTML = items
    .map(
      (e) => `
      <li class="ah-entry-row">
        <span class="ah-entry-date">${fmtDate(e.entry_date)}</span>
        <span class="ah-entry-value">${fmtDKK(e.value_dkk)}</span>
        <button class="ah-action-btn" data-action="edit" data-entry-id="${e.id}" data-date="${e.entry_date}" data-value="${e.value_dkk}" type="button" aria-label="Edit">✎</button>
        <button class="ah-action-btn ah-action-danger" data-action="delete" data-entry-id="${e.id}" type="button" aria-label="Delete">✕</button>
      </li>`,
    )
    .join("");
  ul.querySelectorAll('button[data-action="edit"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const dlg = document.getElementById("account-history-dialog");
      dlg.close();
      openBalanceDialog({
        accountId: historyState.accountId,
        accountName: historyState.accountName,
        entryId: btn.dataset.entryId,
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
        await api.delete(`/accounts/${historyState.accountId}/balance/${btn.dataset.entryId}`);
        toast("Entry deleted");
        await refreshHistoryDialog();
        await renderNetWorth();
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, "error");
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
  if (!canvas || !window.Chart || state.composition.length === 0) return;
  if (state.donutChart) {
    state.donutChart.destroy();
    state.donutChart = null;
  }
  state.donutChart = new window.Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: state.composition.map((c) => c.asset_class),
      datasets: [
        {
          data: state.composition.map((c) => Number(c.value_dkk)),
          backgroundColor: state.composition.map(
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
  return series.filter((p) => {
    const d = new Date(p.date);
    return d >= from && d <= to;
  });
}

function renderMainChart() {
  const canvas = document.getElementById("networth-main-chart");
  if (!canvas || !window.Chart) return;
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
          data: series.map((p) => Number(p.total_dkk)),
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
  renderMainChart();
  renderDonut();
  bindAccountRows(root);
}
