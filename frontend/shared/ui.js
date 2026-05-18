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

export function confirmPrompt(message) {
  // Replace with a custom dialog later if we need it; native confirm is fine for MVP.
  return Promise.resolve(window.confirm(message));
}
