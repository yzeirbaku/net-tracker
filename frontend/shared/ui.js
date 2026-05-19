const TOAST_TIMEOUT_MS = 3000;
let toastTimer = null;

export function toast(message, kind = "info") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), TOAST_TIMEOUT_MS);
}

export function openDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) return null;
  if (!dlg.open) dlg.showModal();
  return dlg;
}

export function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg && dlg.open) dlg.close();
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Custom themed confirmation dialog. Returns Promise<boolean>.
 * Resolves true if the user clicks the affirmative button, false on cancel / Esc / backdrop.
 *
 * Options:
 *  - title: header text (default "Confirm")
 *  - message: body text
 *  - okLabel: affirmative button text (default "Confirm")
 *  - danger: true → makes the affirmative button red (for destructive actions)
 */
export function confirmPrompt({ title = "Confirm", message = "", okLabel = "Confirm", danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("confirm-dialog");
    if (!dlg) {
      // Fallback if the dialog markup is missing — shouldn't happen.
      resolve(window.confirm(message));
      return;
    }
    const titleEl = document.getElementById("confirm-dialog-title");
    const messageEl = document.getElementById("confirm-dialog-message");
    const okBtn = document.getElementById("confirm-dialog-ok");
    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle("dialog-danger-confirm", !!danger);

    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      okBtn.classList.remove("dialog-danger-confirm");
      resolve(dlg.returnValue === "save");
    };
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    // showModal() auto-focuses Cancel (the first focusable). iOS Safari
    // treats programmatic focus as `:focus-visible`, painting a ring
    // that looks stuck. Blur it — the dialog itself remains modal so
    // keyboard focus trap still works.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && dlg.contains(active)) active.blur();
    });
  });
}
