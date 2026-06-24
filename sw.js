// Minimal service worker — its only job is to exist and respond to fetches,
// which satisfies browser installability requirements for "Add to Home Screen."
// It deliberately does no caching: Lumen needs a live network connection to
// Supabase and Anthropic anyway, so offline mode isn't meaningful here.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Only ever touch same-origin GET requests for this app's own files.
  // Everything else — especially cross-origin calls to Supabase or Anthropic —
  // is left completely untouched, since intercepting those can break
  // auth and streaming requests.
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin){
    return; // no respondWith() at all = browser handles it exactly as normal
  }
  event.respondWith(fetch(event.request));
});