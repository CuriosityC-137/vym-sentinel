// Market Sentinel — Service Worker v3.0
const CACHE   = 'ms-sentinel-v3';
const OFFLINE = '/vym-sentinel/index.html';

const PRECACHE = [
  '/vym-sentinel/index.html',
  '/vym-sentinel/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match(OFFLINE)))
  );
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Market Sentinel', body: 'Threat level updated' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/vym-sentinel/icons/icon-192x192.png',
      vibrate: data.urgent ? [200, 100, 200, 100, 400] : [200],
      tag:     'ms-threat',
      renotify: true,
      data:    { url: '/vym-sentinel/index.html' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/vym-sentinel/index.html');
    })
  );
});
