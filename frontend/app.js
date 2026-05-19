import { api } from "./shared/api.js";
import {
  clearToken,
  isSignedIn,
  readTokenFromHash,
  setToken,
} from "./shared/auth.js";
import { closeDialog, openDialog, toast } from "./shared/ui.js";
import { renderSettings } from "./settings.js";
import { renderNetWorth } from "./networth.js";

const VIEWS = ["home", "budget", "spending", "networth", "settings"];

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

// ----- swipe gestures (lifted from gold-bar-tracker) -----
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
    const btn = e.currentTarget;
    const email = $("#login-email").value.trim();
    if (!email) {
      toast("Email required", "error");
      return;
    }
    // Disable + label the button while the request is in flight so
    // an impatient second tap doesn't fire a second magic-link email.
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = "Sending…";
    try {
      await api.post("/auth/request-link", { email });
      toast("Check your inbox for the sign-in link");
      closeDialog("login-dialog");
    } catch (err) {
      toast(`Could not send link: ${err.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
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
    toast(`Sign-in failed: ${err.message}`, "error");
    return false;
  }
}

/**
 * Toggle visibility of the auth-gated menu items + home-view panels.
 * Sign in shows only when signed out; Budget/Spending/Net Worth/
 * Settings/Sign out only when signed in. Home stays visible either
 * way.
 */
function applyAuthState(signedIn) {
  const gated = ["budget", "spending", "networth", "settings", "signout"];
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
  $("#home-signed-in").hidden = !signedIn;
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
  $("#home-signed-in").hidden = true;
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
  await tryVerify();
  await refreshSignedInState();
  showView("home");
}

main();
