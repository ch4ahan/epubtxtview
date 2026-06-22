/* 오프라인 우선 서비스워커.
   앱 셸(코드/스타일)을 캐시해 인터넷 없이도 동작.
   사용자 데이터는 IndexedDB에 있으므로 캐시 대상이 아니다. */
const CACHE = 'chaekgalpi-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './css/styles.css',
  './js/zip.js',
  './js/db.js',
  './js/encoding.js',
  './js/chapters.js',
  './js/highlights.js',
  './js/viewer.js',
  './js/cards.js',
  './js/epub.js',
  './js/backup.js',
  './js/excerpts.js',
  './js/library.js',
  './js/app.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
