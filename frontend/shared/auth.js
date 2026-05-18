const STORAGE_KEY = "net-tracker.session-token";

export function getToken() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
  localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

export function isSignedIn() {
  return !!getToken();
}

export function readTokenFromHash() {
  const m = window.location.hash.match(/auth=([^&]+)/);
  if (!m) return null;
  // Strip the token from the URL so reloads don't replay it.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(m[1]);
}
