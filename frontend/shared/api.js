import { clearToken, getToken } from "./auth.js";
import { toast } from "./ui.js";

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

  let res;
  try {
    res = await fetch(url(path), { method, headers, body: bodyBlob });
  } catch (e) {
    toast("Network error — is the backend running?", "error");
    throw e;
  }

  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("auth:signed-out"));
    throw new Error("unauthorized");
  }
  if (res.status === 204) return null;

  let payload = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const detail = payload && payload.detail ? payload.detail : `${method} ${path} failed (${res.status})`;
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
