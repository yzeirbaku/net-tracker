/**
 * Budget view. Plan 3 will turn this into the template + monthly plan + ticks
 * editor. For now it's a stub that pings /auth/me as a proof-of-life so the
 * page is never blank while the backend is waking up, matching the loading
 * pattern from settings.js and networth.js.
 */

import { api } from "./shared/api.js";
import { paintViewError, paintViewLoading } from "./shared/view-loading.js";

let booted = false;

export async function renderBudget() {
  const root = document.getElementById("budget-root");
  if (!root) return;
  // Only paint the loading card on the first visit. Re-renders (when Plan 3
  // adds Add/Delete operations) will keep the current UI in place.
  if (!booted) paintViewLoading(root, "Loading budget…");
  try {
    await api.get("/auth/me");
  } catch (err) {
    paintViewError(root, `Couldn't reach backend: ${err.message}`);
    return;
  }
  booted = true;
  root.innerHTML = `
    <div class="card">
      <p class="muted">Template editor + monthly plan + ticks land here in a later plan.</p>
    </div>
  `;
}
