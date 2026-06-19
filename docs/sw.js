// World Cup Bet — minimal NO-CACHE service worker.
// Its only job is to make the app installable ("add to home screen"). It does
// NOT cache anything, so it can never serve a stale build — updates are always
// fetched fresh from the network (deliberate, after earlier cache pain).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
// No fetch handler that calls respondWith → the browser uses the network normally.
self.addEventListener('fetch', () => {});
