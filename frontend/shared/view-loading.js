/**
 * Shared loading-card helper. Every view's render function paints this on the
 * first visit so the page never sits blank while the backend is waking up
 * (Render free-tier cold starts can take 20-30s).
 *
 *   paintViewLoading(rootEl)
 *
 * Same copy as the Home view's boot-loading card so the language stays
 * consistent across tabs. The `label` argument is accepted but ignored —
 * kept for backwards compatibility with existing callers.
 *
 * Returns nothing. The caller is expected to overwrite rootEl.innerHTML once
 * its data fetch resolves. Subsequent renders should skip the loading paint
 * (use root.firstElementChild as a "have we ever rendered?" sentinel) so
 * Add/Delete operations don't blink.
 */

import { escapeHtml } from "./ui.js";

const _WAKE_HINT_MS = 2500;

export function paintViewLoading(rootEl, _label) {
  if (!rootEl) return;
  rootEl.innerHTML = `
    <div class="card loading-card">
      <div class="loading-row">
        <span class="spinner" aria-hidden="true"></span>
        <span>Connecting…</span>
      </div>
      <p class="muted-tiny view-loading-hint" hidden style="margin: 0.5rem 0 0">
        The server is waking up — this can take up to 30 seconds.
      </p>
    </div>
  `;
  // Reveal the wake-up hint after a short delay so a fast load doesn't show
  // the long-wait copy unnecessarily.
  const hint = rootEl.querySelector(".view-loading-hint");
  if (hint) {
    setTimeout(() => {
      // Only reveal if the loading card is still on screen (i.e., the render
      // didn't beat the timer).
      if (hint.isConnected) hint.hidden = false;
    }, _WAKE_HINT_MS);
  }
}

export function paintViewError(rootEl, message) {
  if (!rootEl) return;
  rootEl.innerHTML = `<div class="card"><p class="muted">${escapeHtml(message)}</p></div>`;
}
