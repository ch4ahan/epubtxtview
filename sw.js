/* 오프라인 우선 서비스워커.
   앱 셸(코드/스타일)을 캐시해 인터넷 없이도 동작.
   사용자 데이터는 IndexedDB에 있으므로 캐시 대상이 아니다.

   ⚠️ 코드/스타일(js·css·html)은 '네트워크 우선'으로 바꿨다.
   - 예전 cache-first + 고정 캐시 이름은, 앱을 새로 빌드해도 웹뷰에 남은 옛 캐시가
     계속 옛 viewer.js를 돌려줘서 "수정이 적용 안 되는" 문제가 있었다.
   - 자산은 앱에 번들되어 있어 네트워크(로컬) 요청이 빠르므로, 항상 최신을 먼저 쓰고
     오프라인일 때만 캐시로 떨어진다. 캐시 이름도 올려서 옛 캐시를 비운다. */
const CACHE = 'chaekgalpi-v3';
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
  // 네트워크 우선: 최신 코드/스타일을 항상 먼저 가져오고, 실패(오프라인) 시 캐시로 떨어진다.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
