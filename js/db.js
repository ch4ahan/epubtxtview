/* IndexedDB 래퍼.
   앱이 직접 보관하는 데이터만 저장한다:
   - books      : 책 메타(제목/표지/원본 파일 핸들 참조/읽기 기록/목차/완독 등)
   - highlights : 형광펜 + 메모 (문장 기반 앵커로 저장)
   - bookmarks  : 북마크
   - readlog    : 날짜별 읽은 기록
   - settings   : 앱/읽기 설정 (key-value)

   ※ 소설 본문 TXT 자체는 가능하면 파일 핸들(참조)로만 둔다.
     파일 핸들을 영구 저장할 수 없는 환경(예: 안드로이드 크롬)에서는
     books.cachedText 로 폴백 저장하고 needsRelink 플래그로 표시한다. */
(function (global) {
  'use strict';

  const DB_NAME = 'novel-viewer';
  const DB_VERSION = 2;
  let _db = null;

  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        // 본문 텍스트 전용 저장소 (책 메타와 분리 → 위치 저장이 가볍고 빠름, 재연결 불필요)
        if (!db.objectStoreNames.contains('texts')) {
          db.createObjectStore('texts', { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains('highlights')) {
          const s = db.createObjectStore('highlights', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('bookmarks')) {
          const s = db.createObjectStore('bookmarks', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('readlog')) {
          const s = db.createObjectStore('readlog', { keyPath: 'id' });
          s.createIndex('bookId', 'bookId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onerror = () => reject(req.error);
    });
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const DB = {
    // 범용 CRUD
    async put(store, value) { return reqToPromise((await tx(store, 'readwrite')).put(value)); },
    async get(store, key) { return reqToPromise((await tx(store, 'readonly')).get(key)); },
    async del(store, key) { return reqToPromise((await tx(store, 'readwrite')).delete(key)); },
    async all(store) { return reqToPromise((await tx(store, 'readonly')).getAll()); },

    async byIndex(store, index, value) {
      const os = await tx(store, 'readonly');
      return reqToPromise(os.index(index).getAll(value));
    },

    async delByIndex(store, index, value) {
      const os = await tx(store, 'readwrite');
      const keys = await reqToPromise(os.index(index).getAllKeys(value));
      for (const k of keys) os.delete(k);
    },

    // 설정 헬퍼
    async getSetting(key, fallback) {
      const row = await DB.get('settings', key);
      return row ? row.value : fallback;
    },
    async setSetting(key, value) { return DB.put('settings', { key, value }); },
  };

  global.DB = DB;
})(window);
