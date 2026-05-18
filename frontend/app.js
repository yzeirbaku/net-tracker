import { api } from "./shared/api.js";
import {
  clearToken,
  isSignedIn,
  readTokenFromHash,
  setToken,
} from "./shared/auth.js";
import { closeDialog, openDialog, toast } from "./shared/ui.js";
import { renderSettings } from "./settings.js";

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
    const email = $("#login-email").value.trim();
    if (!email) {
      toast("Email required", "error");
      return;
    }
    try {
      await api.post("/auth/request-link", { email });
      toast("Check your inbox for the sign-in link");
      closeDialog("login-dialog");
    } catch (err) {
      toast(`Could not send link: ${err.message}`, "error");
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

async function refreshSignedInState() {
  const accountInfo = $(".menu-account-info");
  const signOutBtn = $('.menu-item[data-action="signout"]');
  if (!isSignedIn()) {
    accountInfo.hidden = true;
    signOutBtn.hidden = true;
    openDialog("login-dialog");
    return null;
  }
  try {
    const me = await api.get("/auth/me");
    accountInfo.textContent = `Signed in as ${me.email}`;
    accountInfo.hidden = false;
    signOutBtn.hidden = false;
    return me;
  } catch {
    clearToken();
    accountInfo.hidden = true;
    signOutBtn.hidden = true;
    openDialog("login-dialog");
    return null;
  }
}

window.addEventListener("auth:signed-out", () => {
  $(".menu-account-info").hidden = true;
  $('.menu-item[data-action="signout"]').hidden = true;
  openDialog("login-dialog");
});

async function main() {
  bindDrawer();
  bindSwipe();
  bindTitleClick();
  bindLogin();
  await tryVerify();
  await refreshSignedInState();
  showView("settings");
}

main();
