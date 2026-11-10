// Serverboy service worker: makes Serverboy installable as an app, shows push notifications
// (alerts, messages, login approvals) and opens the right page when one is tapped.
// It caches nothing but a small offline page: Serverboy always shows live data.
const CACHE = 'serverboy-v1';
const OFFLINE = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([OFFLINE, '/icons/icon-192.png'])));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// Pages come from the network; without a connection, the offline page.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  const login = /^login:/.test(d.tag || '');
  event.waitUntil(
    self.registration.showNotification(d.title || 'Serverboy', {
      body: d.body || '',
      tag: d.tag || undefined,
      renotify: Boolean(d.tag),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: d.url || '/' },
      // A login waiting for approval stays on screen until it is answered.
      requireInteraction: login,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (win) {
        await win.focus();
        if ('navigate' in win) return win.navigate(url);
        return win.postMessage({ type: 'open', url });
      }
      return self.clients.openWindow(url);
    })(),
  );
});
