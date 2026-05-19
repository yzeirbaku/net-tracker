/**
 * Shared loading-card helper. Every view's render function paints this on the
 * first visit so the page never sits blank while the backend is waking up
 * (Render free-tier cold starts can take 20-30s).
 *
 *   paintViewLoading(rootEl, "Loading budget…")
 *
 * Returns nothing. The caller is expected to overwrite rootEl.innerHTML once
 * its data fetch resolves. Subsequent renders should skip the loading paint
 * (use root.firstElementChild as a "have we ever rendered?" sentinel) so
 * Add/Delete operations don't blink.
 */

import { escapeHtml } from "./ui.js";

export function paintViewLoading(rootEl, label) {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="card loading-card">
      <div class="loading-row">
        <span class="spinner" aria-hidden="true"></span>
        <span>${escapeHtml(label)}</span>
      </div>
    </div>
  `;
}

export function paintViewError(rootEl, message) {
  if (!rootEl) return;
  rootEl.innerHTML = `<div class="card"><p class="muted">${escapeHtml(message)}</p></div>`;
}
