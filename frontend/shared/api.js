import { clearToken, getToken } from "./auth.js";

const REQUEST_TIMEOUT_MS = 20000;

function url(path) {
  const base = window.BACKEND_URL || "";
  return base + path;
}

async function request(method, path, body) {
  const headers = { "Accept": "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  let bodyBlob = undefined;
  if (body !== undefined && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    bodyBlob = JSON.stringify(body);
  } else if (body instanceof FormData) {
    bodyBlob = body;
  }

  // Every request gets a deadline. Without one a flaky mobile connection can
  // leave fetch pending indefinitely, and the button that started it stuck
  // on "Saving…" with it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url(path), { method, headers, body: bodyBlob, signal: controller.signal });
  } catch (e) {
    // No toast here: every caller already reports failures through
    // friendlyError(), so toasting too flashed two messages in a row. The
    // codes below are mapped to user-facing copy in ui.js.
    const err = new Error(controller.signal.aborted ? "timeout" : "network_error");
    err.cause = e;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    // Only clear the token on a 401 from /auth/me — that's the canonical
    // "is your session valid" check. A 401 on any other endpoint may be a
    // transient race (Render cold start, browser network blip, etc.); we
    // surface it as an error but DON'T sign the user out, so a single flaky
    // request can't wipe localStorage and force a re-login.
    if (path === "/auth/me") {
      clearToken();
      window.dispatchEvent(new CustomEvent("auth:signed-out"));
    }
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;

  let payload = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    // err.message carries the backend's `detail` code (e.g. "account_name_taken")
    // so the UI's friendlyError() helper can map it to a user-facing string.
    // When the backend didn't send a JSON detail (500s, empty bodies), we emit
    // an opaque "server_error" sentinel — never a method/path leak.
    const detail = payload && payload.detail ? payload.detail : "server_error";
    const err = new Error(detail);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body) => request("POST", path, body),
  patch: (path, body) => request("PATCH", path, body),
  put: (path, body) => request("PUT", path, body),
  delete: (path) => request("DELETE", path),
};
