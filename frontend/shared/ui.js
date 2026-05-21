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

/**
 * Blur the element that `<dialog>.showModal()` auto-focused. iOS Safari (and
 * sometimes Firefox) paints `:focus-visible` on programmatic focus, so the
 * first button in the dialog menu appears with a permanent focus ring until
 * the user taps somewhere else. Calling this on the next animation frame
 * removes the ring without breaking the dialog's modal focus trap.
 *
 * Use this anywhere `<dialog>.showModal()` is called. openDialog() already
 * does it; confirmPrompt() does it; bespoke callers (custom dialog flows
 * with their own open code) MUST do it too.
 */
export function blurAutoFocusedInDialog(dlg) {
  if (!dlg) return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && dlg.contains(active)) active.blur();
  });
}

export function openDialog(id) {
  const dlg = document.getElementById(id);
  if (!dlg) return null;
  if (!dlg.open) {
    dlg.showModal();
    blurAutoFocusedInDialog(dlg);
  }
  return dlg;
}

export function closeDialog(id) {
  const dlg = document.getElementById(id);
  if (dlg && dlg.open) dlg.close();
}

/**
 * Disable a button + swap its label for a "doing the thing" message while
 * `fn()` is in flight; restore on completion (success OR failure). Always
 * use this around any button click that fires a backend call so the user
 * can't double-submit.
 *
 *   await withBusyButton(btn, "Adding…", async () => {
 *     await api.post("/categories", {...});
 *   });
 */
export async function withBusyButton(btn, busyLabel, fn) {
  if (!btn) return await fn();
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// Backend error codes (FastAPI HTTPException detail strings) → user-facing
// messages. Anything not in this map falls back to a generic message — we
// never surface raw backend codes / SQL constraint names / variable names.
const _ERROR_MESSAGES = {
  // accounts.py
  account_name_taken: "An account with this name already exists.",
  asset_class_required_for_wealth: "Pick an asset class for wealth accounts.",
  asset_class_only_for_wealth: "Only wealth accounts have an asset class.",
  // categories.py
  category_name_taken: "A category with this name already exists.",
  // balance_entries.py
  not_a_wealth_account: "Balances can only be added to wealth accounts.",
  future_date_not_allowed: "Future dates aren't allowed.",
  before_earliest_entry: "Can't add an entry earlier than this account's first balance.",
  // networth.py
  invalid_range: "The selected date range is invalid.",
  // shared
  not_found: "That item couldn't be found — it may have been removed.",
  // auth — generally handled by the global 401 path, but cover for safety.
  unauthorized: "You're not signed in.",
  invalid_token: "Sign-in link is invalid.",
  token_used: "Sign-in link has already been used.",
  token_expired: "Sign-in link has expired — request a new one.",
  // budget.py
  color_taken: "That color is already used by another category.",
  not_fully_ticked: "Some items are still open — tick them off before archiving.",
  month_archived: "This month is archived. Restore it to make changes.",
  month_already_stamped: "This month already has a budget. Delete it before stamping again.",
  cannot_stamp_past_month: "Past months can't be stamped. Only the current month and future months.",
  month_not_stamped: "This month doesn't have a budget yet.",
  template_empty: "Add at least one category to your template before stamping a month.",
  template_version_not_found: "That template version no longer exists.",
  category_not_found: "That category couldn't be found — it may have been removed.",
  category_already_in_month: "That category is already in this month's budget.",
  duplicate_category_in_template: "Each category can only appear once in the template.",
  invalid_month: "That month isn't valid.",
  invalid_year: "That year isn't valid.",
};

/**
 * Map a thrown Error from `api.js` into a friendly message. Never surfaces
 * raw backend codes / field names / SQL details to the UI.
 *
 *   try { ... } catch (err) { toast(friendlyError(err, "Couldn't add account"), "error"); }
 *
 * `fallbackPrefix` is the action context (e.g., "Couldn't add account") used
 * when the error code isn't in the map. Network errors and unknown codes
 * both fall back to a generic, action-scoped message.
 */
export function friendlyError(err, fallbackPrefix) {
  const code = err?.message;
  if (typeof code === "string" && code in _ERROR_MESSAGES) {
    return _ERROR_MESSAGES[code];
  }
  return `${fallbackPrefix}. Please try again.`;
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
      // Browsers restore focus to the element that opened the dialog
      // after a modal closes. That leaves a :focus-visible ring on the
      // triggering button (e.g. the × on a category row), which reads
      // as the row staying "highlighted" after Cancel. Blur it so the
      // page returns to a neutral state.
      if (document.activeElement && typeof document.activeElement.blur === "function") {
        document.activeElement.blur();
      }
      resolve(dlg.returnValue === "save");
    };
    dlg.addEventListener("close", onClose);
    dlg.showModal();
    blurAutoFocusedInDialog(dlg);
  });
}
