// SELF-DESTRUCT service worker. PWA install is paused; this SW exists only to
// cleanly unregister itself on any device that previously installed it, so no
// stale/old SW can interfere with the live site. (Re-add a real SW later.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  try { await self.registration.unregister(); } catch (x) {}
  const cs = await self.clients.matchAll({ type: 'window' });
  cs.forEach((c) => { try { c.navigate(c.url); } catch (x) {} });
})()));
