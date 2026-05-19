/**
 * Spending view. Plan 4 will turn this into the CSV import + review queue +
 * monthly stacks. For now it's a stub with the same proof-of-life loading
 * pattern as budget.js / settings.js / networth.js, so the page is never
 * blank while the backend is waking up.
 */

import { api } from "./shared/api.js";
import { paintViewError, paintViewLoading } from "./shared/view-loading.js";

let booted = false;

export async function renderSpending() {
  const root = document.getElementById("spending-root");
  if (!root) return;
  if (!booted) paintViewLoading(root, "Loading spending…");
  try {
    await api.get("/auth/me");
  } catch (err) {
    paintViewError(root, `Couldn't reach backend: ${err.message}`);
    return;
  }
  booted = true;
  root.innerHTML = `
    <div class="card">
      <p class="muted">CSV import + review queue + monthly stacks land here in a later plan.</p>
    </div>
  `;
}
