// Minimal service worker — exists only to satisfy installability requirements
// for "Add to Home Screen." No caching: the vault always needs a live
// connection to Supabase, so offline mode isn't meaningful here.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return; // leave cross-origin (Supabase) requests completely untouched
  }
  event.respondWith(fetch(event.request));
});
