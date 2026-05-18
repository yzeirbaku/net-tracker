/**
 * Custom themed dropdown. Used wherever native <select> would otherwise leak
 * the browser's default option list (which we can't fully style).
 *
 * Usage:
 *   const dd = createDropdown({
 *     options: [{ value: "Savings", label: "Savings" }, ...],
 *     value: "Savings",
 *     onChange: (v) => state.foo = v,
 *     ariaLabel: "Asset class",
 *   });
 *   container.appendChild(dd.element);
 *
 * API: dd.element, dd.getValue(), dd.setValue(v)
 */

import { escapeHtml } from "./ui.js";

let openDropdown = null;

function closeOpen() {
  if (openDropdown) {
    openDropdown.classList.remove("dd-open");
    const t = openDropdown.querySelector(".dd-trigger");
    if (t) t.setAttribute("aria-expanded", "false");
    openDropdown = null;
  }
}

document.addEventListener("click", (e) => {
  if (!openDropdown) return;
  if (openDropdown.contains(e.target)) return;
  closeOpen();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openDropdown) closeOpen();
});

export function createDropdown({ options, value, onChange, ariaLabel = "" }) {
  const root = document.createElement("div");
  root.className = "dd";
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);

  let current = value ?? options[0]?.value ?? null;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");

  const list = document.createElement("ul");
  list.className = "dd-list";
  list.setAttribute("role", "listbox");

  function render() {
    const opt = options.find((o) => o.value === current);
    trigger.innerHTML =
      `<span class="dd-label">${escapeHtml(opt?.label ?? "")}</span>` +
      `<span class="dd-chevron" aria-hidden="true"></span>`;
    list.querySelectorAll("li").forEach((li) => {
      const isActive = li.dataset.value === current;
      li.classList.toggle("active", isActive);
      li.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  function setValue(newValue, fireChange = true) {
    if (newValue === current) return;
    current = newValue;
    render();
    if (fireChange && onChange) onChange(current);
  }

  options.forEach((o) => {
    const li = document.createElement("li");
    li.className = "dd-option";
    li.setAttribute("role", "option");
    li.tabIndex = -1;
    li.dataset.value = o.value;
    li.textContent = o.label;
    li.addEventListener("click", (e) => {
      e.stopPropagation();
      setValue(o.value);
      closeOpen();
      trigger.focus();
    });
    list.appendChild(li);
  });

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = root.classList.contains("dd-open");
    closeOpen();
    if (!isOpen) {
      root.classList.add("dd-open");
      trigger.setAttribute("aria-expanded", "true");
      openDropdown = root;
      // Scroll the active option into view if present.
      const active = list.querySelector("li.active");
      if (active) active.scrollIntoView({ block: "nearest" });
    }
  });

  trigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!root.classList.contains("dd-open")) trigger.click();
    } else if (e.key === "ArrowUp" && !root.classList.contains("dd-open")) {
      e.preventDefault();
      trigger.click();
    }
  });

  root.appendChild(trigger);
  root.appendChild(list);
  render();
  return { element: root, getValue: () => current, setValue };
}
