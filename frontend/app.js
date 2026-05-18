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

function showView(name) {
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (!el) continue;
    el.hidden = v !== name;
  }
  document.querySelectorAll("#nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === name);
  });
  if (name === "settings") renderSettings();
}

function bindDrawer() {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  const open = () => {
    drawer.classList.add("open");
    backdrop.classList.add("open");
  };
  const close = () => {
    drawer.classList.remove("open");
    backdrop.classList.remove("open");
  };
  document.getElementById("menu-open").addEventListener("click", open);
  document.getElementById("drawer-close").addEventListener("click", close);
  backdrop.addEventListener("click", close);

  document.querySelectorAll("#nav button").forEach((b) => {
    b.addEventListener("click", () => {
      showView(b.dataset.view);
      close();
    });
  });
}

function bindLogin() {
  document.getElementById("login-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    closeDialog("login-dialog");
  });
  document.getElementById("login-send").addEventListener("click", async (e) => {
    e.preventDefault();
    const email = document.getElementById("login-email").value.trim();
    if (!email) {
      toast("Email required", "error");
      return;
    }
    try {
      await api.post("/auth/request-link", { email });
      toast("Check your inbox for the sign-in link", "info");
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
    toast(`Signed in as ${res.email}`, "info");
    return true;
  } catch (err) {
    toast(`Sign-in failed: ${err.message}`, "error");
    return false;
  }
}

async function refreshSignedInState() {
  if (!isSignedIn()) {
    openDialog("login-dialog");
    return null;
  }
  try {
    const me = await api.get("/auth/me");
    return me;
  } catch {
    clearToken();
    openDialog("login-dialog");
    return null;
  }
}

window.addEventListener("auth:signed-out", () => {
  openDialog("login-dialog");
});

async function main() {
  bindDrawer();
  bindLogin();
  await tryVerify();
  await refreshSignedInState();
  showView("settings");
}

main();
