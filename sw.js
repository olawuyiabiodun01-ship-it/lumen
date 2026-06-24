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
  // Pass every request straight through to the network.
  event.respondWith(fetch(event.request));
});
