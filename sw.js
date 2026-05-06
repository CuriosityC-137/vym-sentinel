// VYM Market Sentinel — Service Worker v2.1
const CACHE   = 'vym-sentinel-v2';
const OFFLINE = '/index.html';

const PRECACHE = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// ── INSTALL: pre-cache shell ──────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── ACTIVATE: purge old caches ───────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── FETCH: network-first, fall back to cache ─────────────
self.addEventListener('fetch', e => {
  // Don't intercept Yahoo Finance / external API calls
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

// ── BACKGROUND SYNC: periodic data refresh ───────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'vym-refresh') {
    e.waitUntil(checkThreatLevel());
  }
});

// ── PUSH NOTIFICATIONS ────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'VYM Sentinel', body: 'Threat level updated' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icons/icon-192x192.png',
      badge:   '/icons/icon-72x72.png',
      vibrate: data.urgent ? [200, 100, 200, 100, 400] : [200],
      tag:     'vym-threat',
      renotify: true,
      data:    { url: '/index.html' },
      actions: [
        { action: 'open',    title: '📊 Open Dashboard' },
        { action: 'dismiss', title: 'Dismiss' },
      ]
    })
  );
});

// Notification click handler
self.addEventListener('notificationclick', e => {
  e.notification.close();
  if (e.action === 'dismiss') return;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      if (list.length) return list[0].focus();
      return clients.openWindow('/index.html');
    })
  );
});

// ── THREAT CHECK (called by periodic sync) ───────────────
async function checkThreatLevel() {
  try {
    // Fetch current VYM price
    const url = `https://api.allorigins.win/get?url=${encodeURIComponent(
      'https://query1.finance.yahoo.com/v8/finance/chart/VYM?interval=1d&range=5d'
    )}`;
    const res  = await fetch(url);
    const outer = await res.json();
    const data  = JSON.parse(outer.contents);
    const meta  = data.chart.result[0].meta;
    const price = meta.regularMarketPrice;
    const prev  = meta.chartPreviousClose;
    const chgPct = ((price - prev) / prev) * 100;

    // Retrieve stored trailing high from IndexedDB (or use price as fallback)
    const trailHigh = await getStored('trailHigh') || price;
    const stopFloor = trailHigh * 0.94;  // 6% stop
    const distPct   = ((price - stopFloor) / price) * 100;

    // Update trailing high if needed
    if (price > trailHigh) await setStored('trailHigh', price);

    // Notify on critical conditions
    if (distPct < 2.0) {
      await self.registration.showNotification('🚨 VYM STOP IMMINENT', {
        body:    `VYM at $${price.toFixed(2)} — only ${distPct.toFixed(1)}% above stop floor $${stopFloor.toFixed(2)}`,
        icon:    '/icons/icon-192x192.png',
        badge:   '/icons/icon-72x72.png',
        vibrate: [300,100,300,100,600],
        tag:     'vym-stop-imminent',
        renotify: true,
      });
    } else if (chgPct < -1.5) {
      await self.registration.showNotification('⚠ VYM LARGE DOWN DAY', {
        body:    `VYM ${chgPct.toFixed(2)}% today at $${price.toFixed(2)} — stop floor $${stopFloor.toFixed(2)}`,
        icon:    '/icons/icon-192x192.png',
        badge:   '/icons/icon-72x72.png',
        vibrate: [200,100,200],
        tag:     'vym-down-day',
        renotify: true,
      });
    }
  } catch (err) {
    console.warn('[SW] Background check failed:', err);
  }
}

// ── SIMPLE INDEXEDDB HELPERS ─────────────────────────────
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('vym-sentinel', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv', { keyPath: 'k' });
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e);
  });
}

async function getStored(key) {
  const db  = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = e => res(e.target.result ? e.target.result.v : null);
    req.onerror   = rej;
  });
}

async function setStored(key, val) {
  const db  = await openDB();
  return new Promise((res, rej) => {
    const tx  = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ k: key, v: val });
    tx.oncomplete = res;
    tx.onerror    = rej;
  });
}
