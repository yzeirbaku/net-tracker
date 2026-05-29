/**
 * Shared "effective current month" helper.
 *
 * Around payday at the end of the month, the user wants Home + Budget to
 * treat NEXT calendar month as "current." A Settings toggle flips this on.
 * The active target month is stored alongside the toggle so we auto-clear
 * the setting once the real calendar reaches that month — otherwise on
 * July 1 the toggle would silently bump the user to August.
 */

const STORAGE_KEY = "net-tracker.advance-month";
const EVENT_NAME = "nt:effective-month-changed";

function realYearMonth() {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function plusOneMonth({ year, month }) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function ymKey(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function readSetting() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSetting() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Returns { year, month } — the month Home/Budget should treat as current.
 * Performs the auto-clear when the calendar has caught up with the stored
 * target, so callers never see a stale advanced month.
 */
export function getEffectiveYearMonth() {
  const real = realYearMonth();
  const setting = readSetting();
  if (!setting?.target) return real;
  const [ty, tm] = String(setting.target).split("-").map(Number);
  if (!ty || !tm) {
    clearSetting();
    return real;
  }
  // Calendar has reached (or passed) the target — drop the setting.
  if (real.year > ty || (real.year === ty && real.month >= tm)) {
    clearSetting();
    return real;
  }
  return { year: ty, month: tm };
}

/** True iff the effective month differs from the real calendar month. */
export function isAdvanceActive() {
  const real = realYearMonth();
  const eff = getEffectiveYearMonth();
  return eff.year !== real.year || eff.month !== real.month;
}

/**
 * Persist the toggle. When enabling, target = next calendar month. Fires
 * a window event so other modules (e.g. budget-common.js) can rebind
 * state.currentMonth without a page reload.
 */
export function setAdvanceMonthEnabled(enabled) {
  if (enabled) {
    const next = plusOneMonth(realYearMonth());
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ target: ymKey(next.year, next.month) }),
    );
  } else {
    clearSetting();
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT_NAME));
  }
}

export const ADVANCE_MONTH_EVENT = EVENT_NAME;
