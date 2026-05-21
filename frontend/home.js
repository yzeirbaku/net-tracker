/**
 * Home view. Composes /networth and /budget/months/{ym} into a hero tile
 * (net worth), a budget tile (current month free money + progress), and
 * a next-up tile (3 largest unticked items). All click-throughs deep-link
 * to the source view — Home is read-only.
 */

import { api } from "./shared/api.js";
import { friendlyError } from "./shared/ui.js";
import { paintViewLoading, paintViewError } from "./shared/view-loading.js";
import { getNetWorthViewMode } from "./networth.js";

const DKK_TO_EUR_RATE = 7.46038;

let booted = false;

function isoMinusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function currentYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function fmtDot(n) {
  const negative = n < 0;
  const abs = Math.abs(Math.round(Number(n) || 0));
  const s = abs.toLocaleString("de-DE");
  return negative ? `−${s}` : s;
}

function topForView(nw, mode) {
  if (mode === "liquid") return Number(nw.liquid_dkk);
  if (mode === "no_pension") return Number(nw.total_dkk) - Number(nw.pension_total_dkk);
  return Number(nw.total_dkk);
}

function deltaForView(nw, mode) {
  const d = (nw.deltas || []).find((x) => x.period === "1M");
  if (!d) return null;
  if (mode === "liquid") return { value: Number(d.delta_liquid_dkk), isSinceStart: !!d.is_since_start };
  if (mode === "no_pension") {
    const haircut = Number(nw.pension_haircut_rate);
    const totalD = Number(d.delta_dkk);
    const liquidD = Number(d.delta_liquid_dkk);
    const pensionD = haircut === 0 ? 0 : (totalD - liquidD) / haircut;
    return { value: totalD - pensionD, isSinceStart: !!d.is_since_start };
  }
  return { value: Number(d.delta_dkk), isSinceStart: !!d.is_since_start };
}

function pointForView(p, nw, mode) {
  if (mode === "liquid") return Number(p.liquid_dkk);
  if (mode === "no_pension") {
    const haircut = Number(nw.pension_haircut_rate);
    const pension = haircut === 0 ? 0 : (Number(p.total_dkk) - Number(p.liquid_dkk)) / haircut;
    return Number(p.total_dkk) - pension;
  }
  return Number(p.total_dkk);
}

function renderSparklineSvg(series, nw, mode) {
  if (!series || series.length < 2) return "";
  const values = series.map((p) => pointForView(p, nw, mode));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const W = 300;
  const H = 36;
  const step = W / (values.length - 1);
  const points = values.map((v, i) => {
    const x = i * step;
    const y = H - ((v - min) / range) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const linePath = "M" + points.join(" L");
  const areaPath = linePath + ` L${W},${H} L0,${H} Z`;
  return `
    <svg class="home-sparkline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="home-sparkline-grad" x2="0" y2="1"><stop offset="0" stop-color="#22c55e" stop-opacity=".35"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></linearGradient></defs>
      <path d="${areaPath}" fill="url(#home-sparkline-grad)"/>
      <path d="${linePath}" stroke="#22c55e" stroke-width="2" fill="none"/>
    </svg>
  `;
}

function renderHeroBody(nw, mode) {
  const hasAccounts = (nw.accounts || []).length > 0;
  const hasBalances = hasAccounts && (nw.series || []).length > 0;

  if (!hasAccounts) {
    return `
      <div class="home-label">Net worth</div>
      <div class="home-headline">0 dkk</div>
      <a class="home-cta" data-home-nav="settings">Add your first account →</a>
    `;
  }
  if (!hasBalances) {
    return `
      <div class="home-label">Net worth</div>
      <div class="home-headline">0 dkk</div>
      <a class="home-cta" data-home-nav="networth">Add a balance →</a>
    `;
  }

  const top = topForView(nw, mode);
  const eur = Math.round(top / DKK_TO_EUR_RATE);
  const delta = deltaForView(nw, mode);
  let deltaLine = "";
  if (delta) {
    const arrow = delta.value >= 0 ? "▲" : "▼";
    const cls = delta.value >= 0 ? "home-delta-up" : "home-delta-down";
    const suffix = delta.isSinceStart ? "since start" : "this month";
    const sign = delta.value >= 0 ? "+" : "−";
    deltaLine = `<div class="home-delta ${cls}">${sign}${fmtDot(Math.abs(delta.value))} ${suffix} ${arrow}</div>`;
  }
  return `
    <div class="home-label">Net worth</div>
    <div class="home-headline">${fmtDot(top)} dkk</div>
    <div class="home-eur">≈ ${fmtDot(eur)} eur</div>
    ${deltaLine}
    ${renderSparklineSvg(nw.series, nw, mode)}
  `;
}

export async function renderHome() {
  const root = document.getElementById("home-root");
  if (!root) return;
  if (!booted) paintViewLoading(root);

  const { year, month } = currentYearMonth();
  const since = isoMinusDays(30);

  let nw = null;
  try {
    nw = await api.get(`/networth?range_from=${since}`);
  } catch (err) {
    paintViewError(root, friendlyError(err, "Couldn't load Home"));
    return;
  }

  const mode = getNetWorthViewMode();
  root.innerHTML = `
    <div class="home-tile" role="button" tabindex="0" data-home-nav="networth" aria-label="Open Net Worth">
      ${renderHeroBody(nw, mode)}
    </div>
  `;
  booted = true;
  bindHomeClickThroughs(root);
}

function bindHomeClickThroughs(root) {
  const handler = (target) => {
    const dest = target.closest("[data-home-nav]")?.dataset.homeNav;
    if (!dest) return;
    // app.js owns navigation — dispatch a synthetic menu click on the matching item.
    const item = document.querySelector(`.menu-item[data-action="${dest}"]`);
    if (item) item.click();
  };
  root.addEventListener("click", (e) => handler(e.target));
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches('[data-home-nav], [data-home-nav] *')) {
      e.preventDefault();
      handler(e.target);
    }
  });
}
