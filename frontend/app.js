import { api } from "./shared/api.js";
import {
  clearToken,
  isSignedIn,
  readTokenFromHash,
  setToken,
} from "./shared/auth.js";
import { closeDialog, friendlyError, openDialog, toast, withBusyButton } from "./shared/ui.js";
import { renderBudget, resetBudgetSubView } from "./budget.js";
import { renderHome } from "./home.js";
import { renderNetWorth } from "./networth.js";
import { renderPutAside } from "./put-aside.js";
import { renderSettings } from "./settings.js";

// "put-aside" is reachable via Home tile only (no drawer entry) but still
// participates in showView so the hamburger can navigate to it and away.
const VIEWS = ["home", "budget", "networth", "put-aside", "settings"];

function $(sel) { return document.querySelector(sel); }

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (!el) continue;
    el.hidden = v !== name;
  }
  document.querySelectorAll("#menu-dropdown .menu-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.action === name);
  });
  if (name === "settings") renderSettings();
  if (name === "networth") renderNetWorth();
  if (name === "budget") { resetBudgetSubView(); renderBudget(); }
  if (name === "put-aside") renderPutAside();
  if (name === "home") renderHome();
}

// ----- drawer -----

function isMenuOpen() {
  return $("#menu-dropdown").classList.contains("is-open");
}

function setMenuOpen(open) {
  const drawer = $("#menu-dropdown");
  const backdrop = $("#menu-backdrop");
  const btn = $("#menu-btn");
  drawer.classList.toggle("is-open", open);
  backdrop.classList.toggle("is-open", open);
  btn.setAttribute("aria-expanded", String(open));
}

function bindDrawer() {
  $("#menu-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    setMenuOpen(!isMenuOpen());
  });
  $("#menu-backdrop").addEventListener("click", () => setMenuOpen(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMenuOpen()) setMenuOpen(false);
  });

  $("#menu-dropdown").addEventListener("click", async (e) => {
    const item = e.target.closest(".menu-item");
    if (!item) return;
    const action = item.dataset.action;
    setMenuOpen(false);
    if (action === "signin") {
      openDialog("login-dialog");
      return;
    }
    if (action === "signout") {
      try { await api.post("/auth/logout"); } catch { /* ignore */ }
      clearToken();
      location.reload();
      return;
    }
    if (VIEWS.includes(action)) {
      showView(action);
    }
  });
}

// ----- swipe gestures (lifted from gold-price-tracker) -----
function bindSwipe() {
  const EDGE_START_MIN = 0;
  const EDGE_START_MAX = 50;
  const MIN_DISTANCE_X = 40;
  const MAX_DEVIATION_Y = 50;
  const LOCK_THRESHOLD_X = 5;
  let startX = 0;
  let startY = 0;
  let mode = null;

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    if (document.querySelector("dialog[open]") !== null) return;
    const t = e.touches[0];
    if (isMenuOpen()) {
      startX = t.clientX;
      startY = t.clientY;
      mode = "close";
    } else {
      if (t.clientX < EDGE_START_MIN || t.clientX > EDGE_START_MAX) return;
      startX = t.clientX;
      startY = t.clientY;
      mode = "open";
    }
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!mode) return;
    const t = e.touches[0];
    const dxRaw = t.clientX - startX;
    const dy = Math.abs(t.clientY - startY);
    if (dy > MAX_DEVIATION_Y) { mode = null; return; }
    if (Math.abs(dxRaw) > LOCK_THRESHOLD_X && Math.abs(dxRaw) > dy) {
      e.preventDefault();
    }
    const dx = mode === "open" ? dxRaw : -dxRaw;
    if (dx >= MIN_DISTANCE_X) {
      setMenuOpen(mode === "open");
      mode = null;
    }
  }, { passive: false });

  const cancel = () => { mode = null; };
  document.addEventListener("touchend", cancel, { passive: true });
  document.addEventListener("touchcancel", cancel, { passive: true });
}

// ----- header title clickable -----

function bindTitleClick() {
  const link = $("#header-title-link");
  if (!link) return;
  const go = () => showView("home");
  link.addEventListener("click", go);
  link.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
}

// ----- login -----

function bindLogin() {
  $("#login-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    closeDialog("login-dialog");
  });
  $("#login-send").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = $("#login-email").value.trim();
    if (!email) {
      toast("Email required", "error");
      return;
    }
    try {
      await withBusyButton(e.currentTarget, "Sending…", () =>
        api.post("/auth/request-link", { email }),
      );
      toast("Check your inbox for the sign-in link");
      closeDialog("login-dialog");
    } catch (err) {
      toast(friendlyError(err, "Couldn't send sign-in link"), "error");
    }
  });
  // iOS PWA fallback: paste the magic link, extract the token, verify.
  // We deliberately do NOT call refreshSignedInState() here — that would fire
  // an extra GET /auth/me, and api.js aggressively clears the token on a 401.
  // The /verify response already gives us email + token, so we update the UI
  // directly from it (same pattern as gold-price-tracker).
  $("#login-paste-submit").addEventListener("click", async (e) => {
    e.preventDefault();
    const raw = $("#login-paste").value.trim();
    if (!raw) {
      toast("Paste the sign-in link first", "error");
      return;
    }
    const match = raw.match(/auth=([^&\s#]+)/);
    if (!match) {
      toast("That doesn't look like a sign-in link", "error");
      return;
    }
    const token = decodeURIComponent(match[1]);
    try {
      await withBusyButton(e.currentTarget, "Signing in…", async () => {
        const res = await api.post("/auth/verify", { token });
        setToken(res.token);
        $(".menu-account-info").textContent = `Signed in as ${res.email}`;
        applyAuthState(true);
        toast(`Signed in as ${res.email}`);
      });
      $("#login-paste").value = "";
      closeDialog("login-dialog");
      // Populate the home tiles now that we're signed in — without this the
      // home view would render whatever the signed-out version painted.
      showView("home");
    } catch (err) {
      toast(friendlyError(err, "Sign-in failed"), "error");
    }
  });
}

async function tryVerify() {
  const token = readTokenFromHash();
  if (!token) return false;
  try {
    const res = await api.post("/auth/verify", { token });
    setToken(res.token);
    toast(`Signed in as ${res.email}`);
    return true;
  } catch (err) {
    toast(friendlyError(err, "Sign-in failed"), "error");
    return false;
  }
}

/**
 * Toggle visibility of the auth-gated menu items + home-view panels.
 * Sign in shows only when signed out; Budget/Net Worth/Settings/
 * Sign out only when signed in. Home stays visible either way.
 */
function applyAuthState(signedIn) {
  const gated = ["budget", "networth", "settings", "signout"];
  for (const action of gated) {
    const el = document.querySelector(`.menu-item[data-action="${action}"]`);
    if (el) el.hidden = !signedIn;
  }
  const signinItem = document.querySelector('.menu-item[data-action="signin"]');
  if (signinItem) signinItem.hidden = signedIn;

  const divider = document.querySelector(".menu-divider");
  if (divider) divider.hidden = !signedIn;
  const accountInfo = $(".menu-account-info");
  if (accountInfo) accountInfo.hidden = !signedIn;

  $("#home-loading").hidden = true;
  $("#home-root").hidden = !signedIn;
  $("#home-signed-out").hidden = signedIn;
}

/**
 * Show the "Connecting…" card while the boot /auth/me call is in
 * flight. After ~2.5s reveals the "server waking up" hint so the
 * user knows why it's slow rather than thinking the app is broken.
 * Returns a cleanup function that hides the card.
 */
function showBootLoading() {
  const loading = $("#home-loading");
  const detail = $("#home-loading-detail");
  loading.hidden = false;
  $("#home-root").hidden = true;
  $("#home-signed-out").hidden = true;
  detail.hidden = true;
  const hintTimer = setTimeout(() => { detail.hidden = false; }, 2500);
  return () => {
    clearTimeout(hintTimer);
    loading.hidden = true;
  };
}

/**
 * On boot: verify a magic-link token (if any in the URL), then ask
 * the backend who we are. Only clear the local token on an explicit
 * 401 (handled inside api.js). Transient errors — Render free-tier
 * cold starts, flaky network — leave the token alone so a refresh
 * later just works, instead of forcing a new magic-link email.
 */
async function refreshSignedInState() {
  if (!isSignedIn()) {
    applyAuthState(false);
    return null;
  }
  const hideLoading = showBootLoading();
  try {
    const me = await api.get("/auth/me");
    $(".menu-account-info").textContent = `Signed in as ${me.email}`;
    applyAuthState(true);
    return me;
  } catch (err) {
    if (err && err.message === "unauthorized") {
      // api.js already cleared the token on 401.
      applyAuthState(false);
    } else {
      // Transient — keep the token, optimistically render signed-in.
      applyAuthState(true);
    }
    return null;
  } finally {
    hideLoading();
  }
}

window.addEventListener("auth:signed-out", () => {
  applyAuthState(false);
  showView("home");
});

async function main() {
  bindDrawer();
  bindSwipe();
  bindTitleClick();
  bindLogin();
  // Reveal the Home view BEFORE the async checks so the user never stares
  // at a blank shell while /auth/me is in flight. refreshSignedInState
  // then flips the loading / signed-in / signed-out card inside Home.
  showView("home");
  await tryVerify();
  await refreshSignedInState();
}

main();
