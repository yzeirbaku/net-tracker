/**
 * Custom themed date picker. Replaces native <input type="date"> wherever the
 * browser-default popup (a Chromium calendar dropdown on desktop, an iOS wheel
 * picker on mobile) would otherwise leak through.
 *
 * Usage:
 *   const dp = createDatePicker({
 *     value: "2026-05-19",         // ISO yyyy-mm-dd; null for unset.
 *     max: "2026-05-19",           // optional ISO upper bound; future dates blocked.
 *     min: "2020-01-01",           // optional ISO lower bound.
 *     onChange: (iso) => { ... },  // fires when user picks a date.
 *     ariaLabel: "Entry date",
 *   });
 *   container.appendChild(dp.element);
 *
 * API:
 *   dp.element          — the root DOM node.
 *   dp.getValue()       — ISO date string or null.
 *   dp.setValue(iso)    — set programmatically (no onChange fire).
 *   dp.setMin(iso)      — change lower bound at runtime (null = no lower bound).
 *   dp.setMax(iso)      — change upper bound at runtime (null = no upper bound).
 */

import { escapeHtml } from "./ui.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// Monday-first weekday headers. Two letters so Tue/Thu and Sat/Sun are unambiguous.
const WEEKDAY_LABELS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

let openPicker = null;

function closeOpen() {
  if (openPicker) {
    openPicker.classList.remove("dp-open");
    const t = openPicker.querySelector(".dp-trigger");
    if (t) t.setAttribute("aria-expanded", "false");
    openPicker = null;
  }
}

document.addEventListener("click", (e) => {
  if (!openPicker) return;
  if (openPicker.contains(e.target)) return;
  closeOpen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPicker) closeOpen();
});

function parseIso(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function isoFromDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function displayFromIso(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function createDatePicker({
  value = null,
  max = null,
  min = null,
  onChange = null,
  ariaLabel = "",
  placeholder = "Pick a date",
} = {}) {
  const root = document.createElement("div");
  root.className = "dp";
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

  let currentIso = value;
  let maxIso = max;
  let minIso = min;
  // The month currently visible in the popup. Defaults to the selected
  // value's month, falling back to max, then to today.
  let viewYear, viewMonth;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dp-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "dp-popup";
  popup.setAttribute("role", "dialog");

  function syncViewToCurrent() {
    const anchor =
      parseIso(currentIso) ||
      parseIso(maxIso) ||
      new Date();
    viewYear = anchor.getFullYear();
    viewMonth = anchor.getMonth();
  }
  syncViewToCurrent();

  function renderTrigger() {
    const label = currentIso ? displayFromIso(currentIso) : placeholder;
    trigger.innerHTML =
      `<span class="dp-trigger-label${currentIso ? "" : " dp-trigger-placeholder"}">${escapeHtml(label)}</span>` +
      `<span class="dp-trigger-icon" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">` +
      `<rect x="3" y="4" width="18" height="18" rx="2"/>` +
      `<line x1="16" y1="2" x2="16" y2="6"/>` +
      `<line x1="8" y1="2" x2="8" y2="6"/>` +
      `<line x1="3" y1="10" x2="21" y2="10"/>` +
      `</svg></span>`;
  }

  function renderPopup() {
    const maxDate = parseIso(maxIso);
    const minDate = parseIso(minIso);
    const selected = parseIso(currentIso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    // JS getDay: 0=Sun..6=Sat. Convert to Mon-first index.
    const startOffset = (firstOfMonth.getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const gridStart = new Date(viewYear, viewMonth, 1 - startOffset);

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const cell = new Date(gridStart);
      cell.setDate(gridStart.getDate() + i);
      const inMonth = cell.getMonth() === viewMonth;
      const disabled =
        (maxDate && cell > maxDate) || (minDate && cell < minDate);
      const isToday = sameDay(cell, today);
      const isSelected = selected && sameDay(cell, selected);
      const classes = ["dp-day"];
      if (!inMonth) classes.push("dp-day-other");
      if (disabled) classes.push("dp-day-disabled");
      if (isToday) classes.push("dp-day-today");
      if (isSelected) classes.push("dp-day-selected");
      cells.push({ cell, classes, disabled });
    }

    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-nav="prev" aria-label="Previous month">‹</button>
        <div class="dp-title">${MONTHS[viewMonth]} ${viewYear}</div>
        <button type="button" class="dp-nav" data-nav="next" aria-label="Next month">›</button>
      </div>
      <div class="dp-weekdays">
        ${WEEKDAY_LABELS.map((l) => `<span>${l}</span>`).join("")}
      </div>
      <div class="dp-grid">
        ${cells
          .map(
            ({ cell, classes, disabled }) => `
          <button type="button" class="${classes.join(" ")}" data-iso="${isoFromDate(cell)}" ${disabled ? "disabled" : ""}>${cell.getDate()}</button>`,
          )
          .join("")}
      </div>
      <div class="dp-footer">
        <button type="button" class="dp-today-btn" data-today>Today</button>
      </div>
    `;
  }

  function commit(iso, fire = true) {
    currentIso = iso;
    syncViewToCurrent();
    renderTrigger();
    if (fire && onChange) onChange(currentIso);
  }

  function open() {
    syncViewToCurrent();
    renderPopup();
    root.classList.add("dp-open");
    trigger.setAttribute("aria-expanded", "true");
    openPicker = root;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = root.classList.contains("dp-open");
    closeOpen();
    if (!isOpen) open();
  });

  function shiftMonth(dir) {
    viewMonth += dir;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderPopup();
  }

  popup.addEventListener("click", (e) => {
    e.stopPropagation();
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      shiftMonth(navBtn.dataset.nav === "prev" ? -1 : 1);
      return;
    }
    if (e.target.matches("[data-today]")) {
      const today = new Date();
      // Respect max — if today is past the max bound, don't override the selection.
      const maxDate = parseIso(maxIso);
      const minDate = parseIso(minIso);
      if (maxDate && today > maxDate) return;
      if (minDate && today < minDate) return;
      commit(isoFromDate(today));
      closeOpen();
      return;
    }
    const dayBtn = e.target.closest(".dp-day:not([disabled])");
    if (dayBtn) {
      commit(dayBtn.dataset.iso);
      closeOpen();
    }
  });

  function moveFocus(days) {
    // Anchor: currently-focused cell if any; else selected; else today.
    const focused = popup.querySelector(".dp-day:focus");
    const anchorIso = focused?.dataset.iso || currentIso || isoFromDate(new Date());
    const anchor = parseIso(anchorIso);
    if (!anchor) return;
    const target = new Date(anchor);
    target.setDate(target.getDate() + days);
    const maxDate = parseIso(maxIso);
    const minDate = parseIso(minIso);
    if (maxDate && target > maxDate) return;
    if (minDate && target < minDate) return;
    if (target.getFullYear() !== viewYear || target.getMonth() !== viewMonth) {
      viewYear = target.getFullYear();
      viewMonth = target.getMonth();
      renderPopup();
    }
    const targetIso = isoFromDate(target);
    const btn = popup.querySelector(`.dp-day[data-iso="${targetIso}"]:not([disabled])`);
    if (btn) btn.focus();
  }

  popup.addEventListener("keydown", (e) => {
    if (!root.classList.contains("dp-open")) return;
    switch (e.key) {
      case "ArrowLeft":  e.preventDefault(); moveFocus(-1);  break;
      case "ArrowRight": e.preventDefault(); moveFocus(1);   break;
      case "ArrowUp":    e.preventDefault(); moveFocus(-7);  break;
      case "ArrowDown":  e.preventDefault(); moveFocus(7);   break;
      case "PageUp":     e.preventDefault(); shiftMonth(-1); break;
      case "PageDown":   e.preventDefault(); shiftMonth(1);  break;
      case "Enter":
      case " ": {
        const focused = popup.querySelector(".dp-day:focus:not([disabled])");
        if (focused) {
          e.preventDefault();
          commit(focused.dataset.iso);
          closeOpen();
          trigger.focus();
        }
        break;
      }
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      if (!root.classList.contains("dp-open")) {
        trigger.click();
        // Move focus to the selected day (or today / first enabled) so arrow keys work immediately.
        requestAnimationFrame(() => {
          const target =
            popup.querySelector(".dp-day-selected:not([disabled])") ||
            popup.querySelector(".dp-day-today:not([disabled])") ||
            popup.querySelector(".dp-day:not([disabled])");
          if (target) target.focus();
        });
      }
    }
  });

  root.appendChild(trigger);
  root.appendChild(popup);
  renderTrigger();

  return {
    element: root,
    getValue: () => currentIso,
    setValue: (iso) => commit(iso, false),
    setMax: (iso) => {
      maxIso = iso;
      // If the popup is open we need a re-render; sync the view first so a
      // change to the bounds doesn't leave the user staring at a month
      // unrelated to their current selection.
      if (root.classList.contains("dp-open")) {
        syncViewToCurrent();
        renderPopup();
      }
    },
    setMin: (iso) => {
      minIso = iso;
      if (root.classList.contains("dp-open")) {
        syncViewToCurrent();
        renderPopup();
      }
    },
  };
}


// ── Month picker ─────────────────────────────────────────────────────────
//
// Used by the Budget view's month navigator. Visually shares the day picker's
// trigger + popup chrome (so the two read as the same component family) but
// the grid shows 12 months instead of ~42 days, and the prev/next buttons
// shift the year, not the month.
//
// Value shape: "yyyy-mm" (zero-padded month). Pass min/max in the same shape.

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parseYM(ym) {
  if (!ym) return null;
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return null;
  return { year: y, month: m };
}

function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// "yyyy-mm" → "Mmm yyyy" for the trigger label.
function displayFromYm(ym) {
  if (!ym) return "";
  const parsed = parseYM(ym);
  if (!parsed) return "";
  return `${SHORT_MONTHS[parsed.month - 1]} ${parsed.year}`;
}

function ymCmp(a, b) {
  // both {year, month}
  if (a.year !== b.year) return a.year - b.year;
  return a.month - b.month;
}

export function createMonthPicker({
  value = null,
  min = null,
  max = null,
  onChange = null,
  ariaLabel = "",
  placeholder = "Pick a month",
} = {}) {
  const root = document.createElement("div");
  root.className = "dp mp";
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

  let currentYm = value;
  let minYm = min;
  let maxYm = max;
  let viewYear;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dp-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");

  const popup = document.createElement("div");
  popup.className = "dp-popup mp-popup";
  popup.setAttribute("role", "dialog");

  function syncViewToCurrent() {
    const anchor =
      parseYM(currentYm) ||
      parseYM(maxYm) ||
      (() => {
        const t = new Date();
        return { year: t.getFullYear(), month: t.getMonth() + 1 };
      })();
    viewYear = anchor.year;
  }
  syncViewToCurrent();

  function renderTrigger() {
    const label = currentYm ? displayFromYm(currentYm) : placeholder;
    trigger.innerHTML =
      `<span class="dp-trigger-label${currentYm ? "" : " dp-trigger-placeholder"}">${escapeHtml(label)}</span>` +
      `<span class="dp-trigger-icon" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">` +
      `<rect x="3" y="4" width="18" height="18" rx="2"/>` +
      `<line x1="16" y1="2" x2="16" y2="6"/>` +
      `<line x1="8" y1="2" x2="8" y2="6"/>` +
      `<line x1="3" y1="10" x2="21" y2="10"/>` +
      `</svg></span>`;
  }

  function renderPopup() {
    const minP = parseYM(minYm);
    const maxP = parseYM(maxYm);
    const selected = parseYM(currentYm);
    const today = new Date();
    const todayYM = { year: today.getFullYear(), month: today.getMonth() + 1 };

    const cells = [];
    for (let m = 1; m <= 12; m++) {
      const cellYM = { year: viewYear, month: m };
      const disabled =
        (minP && ymCmp(cellYM, minP) < 0) || (maxP && ymCmp(cellYM, maxP) > 0);
      const isCurrent = ymCmp(cellYM, todayYM) === 0;
      const isSelected = selected && ymCmp(cellYM, selected) === 0;
      const classes = ["dp-day", "mp-month"];
      if (disabled) classes.push("dp-day-disabled");
      if (isCurrent) classes.push("dp-day-today");
      if (isSelected) classes.push("dp-day-selected");
      cells.push({ ym: ymKey(cellYM.year, cellYM.month), label: SHORT_MONTHS[m - 1], classes, disabled });
    }

    popup.innerHTML = `
      <div class="dp-header">
        <button type="button" class="dp-nav" data-nav="prev" aria-label="Previous year">‹</button>
        <div class="dp-title">${viewYear}</div>
        <button type="button" class="dp-nav" data-nav="next" aria-label="Next year">›</button>
      </div>
      <div class="dp-grid mp-grid">
        ${cells
          .map(
            (c) =>
              `<button type="button" class="${c.classes.join(" ")}" data-ym="${c.ym}" ${c.disabled ? "disabled" : ""}>${c.label}</button>`,
          )
          .join("")}
      </div>
      <div class="dp-footer">
        <button type="button" class="dp-today-btn" data-this-month>This month</button>
      </div>
    `;
  }

  function commit(ym, fire = true) {
    currentYm = ym;
    syncViewToCurrent();
    renderTrigger();
    if (fire && onChange) onChange(currentYm);
  }

  function open() {
    syncViewToCurrent();
    renderPopup();
    root.classList.add("dp-open");
    trigger.setAttribute("aria-expanded", "true");
    openPicker = root;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = root.classList.contains("dp-open");
    closeOpen();
    if (!isOpen) open();
  });

  function shiftYear(dir) {
    viewYear += dir;
    renderPopup();
  }

  popup.addEventListener("click", (e) => {
    e.stopPropagation();
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      shiftYear(navBtn.dataset.nav === "prev" ? -1 : 1);
      return;
    }
    if (e.target.matches("[data-this-month]")) {
      const today = new Date();
      const ym = ymKey(today.getFullYear(), today.getMonth() + 1);
      const minP = parseYM(minYm);
      const maxP = parseYM(maxYm);
      const todayYM = { year: today.getFullYear(), month: today.getMonth() + 1 };
      if (minP && ymCmp(todayYM, minP) < 0) return;
      if (maxP && ymCmp(todayYM, maxP) > 0) return;
      commit(ym);
      closeOpen();
      return;
    }
    const cellBtn = e.target.closest(".mp-month:not([disabled])");
    if (cellBtn) {
      commit(cellBtn.dataset.ym);
      closeOpen();
    }
  });

  root.appendChild(trigger);
  root.appendChild(popup);
  renderTrigger();

  return {
    element: root,
    getValue: () => currentYm,
    setValue: (ym) => commit(ym, false),
    setMin: (ym) => {
      minYm = ym;
      if (root.classList.contains("dp-open")) {
        syncViewToCurrent();
        renderPopup();
      }
    },
    setMax: (ym) => {
      maxYm = ym;
      if (root.classList.contains("dp-open")) {
        syncViewToCurrent();
        renderPopup();
      }
    },
  };
}
