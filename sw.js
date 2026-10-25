// サービスワーカー: ホーム画面のアプリとして起動できるようにし、画面のファイルを手元にも置いておく
//
// - 画面のファイル（同じサイトの GET）は、まずネットから取り（更新をすぐ反映するため）、取れなければ手元の分を使う
// - Apps Script への通信（別のサイト）には関わらない

const CACHE = 'receipt-checker-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './api.js',
  './image.js',
  './receipt.js',
  './store.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))),
  );
});
