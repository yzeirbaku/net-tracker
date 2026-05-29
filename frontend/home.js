/**
 * Home view. Composes /networth and /budget/months/{ym} into a hero tile
 * (net worth), a budget tile (current month free money + progress), and
 * a next-up tile (3 largest unticked items). All click-throughs deep-link
 * to the source view — Home is read-only.
 */

import { api } from "./shared/api.js";
import { escapeHtml, friendlyError } from "./shared/ui.js";
import { paintViewLoading, paintViewError } from "./shared/view-loading.js";
import { ASSET_CLASS_COLORS, ASSET_CLASS_ORDER, getNetWorthViewMode } from "./networth.js";
import { getEffectiveYearMonth } from "./shared/effective-month.js";

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
  // Honors the Settings "current month" advance toggle.
  return getEffectiveYearMonth();
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

function compositionForView(nw, mode) {
  const raw = nw.composition || [];
  if (raw.length === 0) return [];
  if (mode === "no_pension") {
    const filtered = raw.filter((c) => c.asset_class !== "Pension");
    const total = filtered.reduce((s, c) => s + Number(c.value_dkk), 0);
    if (total <= 0) return [];
    return filtered.map((c) => ({
      asset_class: c.asset_class,
      value_dkk: Number(c.value_dkk),
      percentage: (Number(c.value_dkk) / total) * 100,
    }));
  }
  if (mode === "liquid") {
    const haircut = Number(nw.pension_haircut_rate);
    const adjusted = raw.map((c) => ({
      asset_class: c.asset_class,
      value_dkk: c.asset_class === "Pension" ? Number(c.value_dkk) * (1 - haircut) : Number(c.value_dkk),
    }));
    const total = adjusted.reduce((s, c) => s + c.value_dkk, 0);
    if (total <= 0) return [];
    return adjusted.map((c) => ({
      ...c,
      percentage: (c.value_dkk / total) * 100,
    }));
  }
  return raw.map((c) => ({
    asset_class: c.asset_class,
    value_dkk: Number(c.value_dkk),
    percentage: Number(c.pct) * 100,
  }));
}

function renderCompositionTile(nw, mode) {
  const comp = compositionForView(nw, mode);
  if (comp.length === 0) return "";
  // Canonical asset-class order for visual consistency with the Net Worth view.
  const ordered = [...comp].sort(
    (a, b) => ASSET_CLASS_ORDER.indexOf(a.asset_class) - ASSET_CLASS_ORDER.indexOf(b.asset_class),
  );
  const segments = ordered.map((c) => {
    const color = ASSET_CLASS_COLORS[c.asset_class] || "#999";
    return `<div class="home-comp-seg" style="width:${c.percentage.toFixed(2)}%;background:${color}" title="${escapeHtml(c.asset_class)} · ${c.percentage.toFixed(1)}%"></div>`;
  }).join("");
  const legend = ordered.map((c) => {
    const color = ASSET_CLASS_COLORS[c.asset_class] || "#999";
    return `
      <span class="home-comp-legend-item">
        <span class="home-dot" style="background:${color}"></span>
        ${escapeHtml(c.asset_class)} <span class="home-comp-pct">${c.percentage.toFixed(0)}%</span>
      </span>
    `;
  }).join("");
  return `
    <div class="home-tile" role="button" tabindex="0" data-home-nav="networth" aria-label="Open Net Worth">
      <div class="home-label">Composition</div>
      <div class="home-comp-bar">${segments}</div>
      <div class="home-comp-legend">${legend}</div>
    </div>
  `;
}

function monthLabel(year, month) {
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  return `${names[month - 1]} ${year}`;
}

function summarizeMonth(month) {
  const items = (month.categories || []).flatMap((c) => c.items || []);
  let planned = 0;
  let spent = 0;
  let ticked = 0;
  for (const it of items) {
    const p = Number(it.planned_dkk);
    const r = Number(it.remaining_dkk);
    planned += p;
    spent += (p - r);
    if ((it.ticked_at !== null && it.ticked_at !== undefined) || r <= 0) ticked += 1;
  }
  const salary = Number(month.salary_dkk);
  return {
    planned, spent, ticked,
    total: items.length,
    freeMoney: salary - planned,
    pct: planned > 0 ? Math.max(0, Math.min(100, (spent / planned) * 100)) : 0,
  };
}

function renderBudgetTile(month) {
  const s = summarizeMonth(month);
  const freeCls = s.freeMoney >= 0 ? "home-free-positive" : "home-free-negative";
  return `
    <div class="home-tile" role="button" tabindex="0" data-home-nav="budget" aria-label="Open Budget">
      <div class="home-label">${monthLabel(month.year, month.month)} · free money</div>
      <div class="home-free ${freeCls}">${fmtDot(s.freeMoney)} dkk</div>
      <div class="home-progress"><div style="width:${s.pct.toFixed(1)}%"></div></div>
      <div class="home-sub">${fmtDot(s.spent)} spent of ${fmtDot(s.planned)} planned · ${s.ticked}/${s.total} ticked</div>
    </div>
  `;
}

function topUntickedItems(month, limit = 3) {
  const out = [];
  for (const cat of (month.categories || [])) {
    for (const it of (cat.items || [])) {
      const r = Number(it.remaining_dkk);
      const isTicked = (it.ticked_at !== null && it.ticked_at !== undefined) || r <= 0;
      if (!isTicked) {
        out.push({
          name: it.name,
          remaining: r,
          color: cat.category_color || "#22c55e",
        });
      }
    }
  }
  out.sort((a, b) => b.remaining - a.remaining);
  return out.slice(0, limit);
}

function renderNextUpTile(month) {
  const items = topUntickedItems(month);
  if (items.length === 0) return "";
  const rows = items.map((it) => `
    <div class="home-next-row">
      <span class="home-next-left">
        <span class="home-dot" style="background:${it.color}"></span>
        ${escapeHtml(it.name)}
      </span>
      <span class="home-next-amount">${fmtDot(it.remaining)}</span>
    </div>
  `).join("");
  return `
    <div class="home-tile" role="button" tabindex="0" data-home-nav="budget" aria-label="Open Budget">
      <div class="home-label">Next up</div>
      ${rows}
    </div>
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

  const [nwRes, budgetRes] = await Promise.allSettled([
    api.get(`/networth?range_from=${since}`),
    api.get(`/budget/months/${year}/${month}`),
  ]);

  if (nwRes.status === "rejected") {
    // Hero is mandatory — if NW fails, the page can't render meaningfully.
    paintViewError(root, friendlyError(nwRes.reason, "Couldn't load Home"));
    return;
  }
  const nw = nwRes.value;
  let budget = null;
  if (budgetRes.status === "fulfilled") {
    budget = budgetRes.value;
  } else if (budgetRes.reason?.message !== "month_not_stamped") {
    console.warn("Home: budget fetch failed", budgetRes.reason);
  }

  const mode = getNetWorthViewMode();
  const tiles = [
    `<div class="home-tile" role="button" tabindex="0" data-home-nav="networth" aria-label="Open Net Worth">${renderHeroBody(nw, mode)}</div>`,
  ];
  const composition = renderCompositionTile(nw, mode);
  if (composition) tiles.push(composition);
  if (budget) {
    tiles.push(renderBudgetTile(budget));
    const nextUp = renderNextUpTile(budget);
    if (nextUp) tiles.push(nextUp);
  }

  root.innerHTML = tiles.join("");
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
