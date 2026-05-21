/**
 * Category color picker — trigger button + floating swatch popup. Matches
 * the established settings-page UX: round trigger chip shows the current
 * color, click opens a popup with a grid of swatches, click a swatch to
 * commit + close. Already-used colors render disabled and dimmed so the
 * unique-per-user constraint is communicated up front.
 *
 * Usage:
 *   const picker = createColorPicker({
 *     value: "#ef4444",
 *     takenColors: ["#22c55e", "#8b5cf6"],
 *     onChange: (hex) => { state.color = hex; },
 *   });
 *   container.appendChild(picker.element);
 *
 * API: picker.element (a `.color-picker` div containing trigger + popup),
 * picker.getValue(), picker.setValue(v), picker.setTaken(arr).
 *
 * Palette: 12 well-spaced hues — chosen so any two are visually
 * differentiable (no neighbors like teal+cyan+sky stacked). Keep in this
 * order — the settings page rotates the "next default color" through it.
 */

import { escapeHtml } from "./ui.js";

export const PALETTE = [
  // Row 1 — bright primaries (warm → cool)
  "#ef4444", // red
  "#f97316", // orange
  "#f59e0b", // amber
  "#eab308", // yellow
  "#84cc16", // lime
  "#22c55e", // green
  // Row 2 — secondary primaries (continuing the wheel)
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#0ea5e9", // sky
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  // Row 3 — pastels / lighter variants
  "#fb7185", // rose
  "#fdba74", // peach
  "#86efac", // mint
  "#93c5fd", // light blue
  "#d8b4fe", // lilac
  "#f9a8d4", // light pink
  // Row 4 — deep / earth tones + neutrals
  "#991b1b", // wine
  "#c2410c", // rust
  "#65a30d", // olive
  "#047857", // forest
  "#94a3b8", // light slate
  "#475569", // dark slate
];

// Track open pickers so a click outside only closes the relevant one. Same
// pattern as shared/dropdown.js.
let openPicker = null;

document.addEventListener("click", (e) => {
  if (!openPicker) return;
  if (openPicker.contains(e.target)) return;
  closeOpen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openPicker) closeOpen();
});

function closeOpen() {
  if (!openPicker) return;
  const popup = openPicker.querySelector(".color-picker-popup");
  const trigger = openPicker.querySelector(".color-picker-trigger");
  if (popup) popup.hidden = true;
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  openPicker = null;
}

export function createColorPicker({ value = null, takenColors = [], onChange = () => {} } = {}) {
  const root = document.createElement("div");
  root.className = "color-picker";

  let current = value;
  let taken = new Set((takenColors || []).filter((c) => c && c !== value));

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "color-picker-trigger";
  trigger.setAttribute("aria-haspopup", "dialog");
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-label", "Choose color");

  const popup = document.createElement("div");
  popup.className = "color-picker-popup";
  popup.setAttribute("role", "dialog");
  popup.setAttribute("aria-label", "Pick a color");
  popup.hidden = true;

  function syncTrigger() {
    trigger.style.background = current || "var(--muted)";
  }

  function renderPopup() {
    // Hide taken colors entirely (don't render them). The user's CURRENT
    // selection always renders, even if it's also in the "taken" set —
    // that lets them keep their existing color when editing.
    const visible = PALETTE.filter((hex) => {
      const isCurrent = current && hex.toLowerCase() === current.toLowerCase();
      return isCurrent || !taken.has(hex);
    });
    const cells = visible.map((hex) => {
      const isCurrent = current && hex.toLowerCase() === current.toLowerCase();
      const classes = ["swatch"];
      if (isCurrent) classes.push("active");
      return `<button type="button" class="${classes.join(" ")}" data-color="${escapeHtml(hex)}" style="background: ${escapeHtml(hex)}" title="Color ${escapeHtml(hex)}" aria-label="Color ${escapeHtml(hex)}"></button>`;
    });
    // Every category must have a color — no "no color" cell offered.
    popup.innerHTML = `<div class="color-grid">${cells.join("")}</div>`;
  }

  function open() {
    if (openPicker && openPicker !== root) closeOpen();
    renderPopup();
    popup.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    openPicker = root;
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!popup.hidden && openPicker === root) {
      closeOpen();
    } else {
      open();
    }
  });

  popup.addEventListener("click", (e) => {
    e.stopPropagation();
    const sw = e.target.closest(".swatch");
    if (!sw || sw.disabled) return;
    const hex = sw.dataset.color || null;
    current = hex;
    syncTrigger();
    closeOpen();
    onChange(hex);
  });

  syncTrigger();
  root.appendChild(trigger);
  root.appendChild(popup);

  return {
    element: root,
    getValue: () => current,
    setValue: (v) => {
      current = v;
      syncTrigger();
      if (openPicker === root) renderPopup();
    },
    setTaken: (arr) => {
      taken = new Set((arr || []).filter((c) => c && c !== current));
      if (openPicker === root) renderPopup();
    },
  };
}
