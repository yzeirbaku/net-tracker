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
 *   dp.setMax(iso)      — change upper bound at runtime.
 */

import { escapeHtml } from "./ui.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// Danish week — Monday first.
const WEEKDAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

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

  popup.addEventListener("click", (e) => {
    e.stopPropagation();
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      const dir = navBtn.dataset.nav === "prev" ? -1 : 1;
      viewMonth += dir;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderPopup();
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

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      if (!root.classList.contains("dp-open")) trigger.click();
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
      if (root.classList.contains("dp-open")) renderPopup();
    },
    setMin: (iso) => {
      minIso = iso;
      if (root.classList.contains("dp-open")) renderPopup();
    },
  };
}
