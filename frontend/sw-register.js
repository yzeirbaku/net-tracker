// Register the (deliberately no-op) service worker. Required for iOS install;
// no caching, so it doesn't gate deploys. Lives in its own file so the strict
// CSP (script-src 'self' …) doesn't need 'unsafe-inline'.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
