/* JSON 백업 내보내기/불러오기 — 폰 교체 대비.
   포함: 형광펜·메모, 읽기 기록(날짜·위치·완독), 책 등록 정보(제목·표지·원본 파일명 참조), 설정.
   제외: 본문 TXT 원문(앱이 들고 있지 않음), 파일 핸들(기기 전용).
   → 새 기기에서 불러온 뒤 "본문 파일 다시 연결"로 TXT를 재지정하면
     형광펜·메모가 문장 기반으로 제자리를 다시 찾는다. */
(function (global) {
  'use strict';

  function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }
  async function dataURLToBlob(dataURL) {
    const res = await fetch(dataURL);
    return res.blob();
  }

  async function exportAll() {
    const books = await DB.all('books');
    const highlights = await DB.all('highlights');
    const bookmarks = await DB.all('bookmarks');
    const readlog = await DB.all('readlog');
    const settings = await DB.all('settings');

    // 책: 핸들/본문캐시 제외, 표지는 dataURL로
    const exportedBooks = [];
    for (const b of books) {
      const copy = Object.assign({}, b);
      delete copy.fileHandle;
      delete copy.cachedText;
      copy._lastLog = undefined;
      if (b.coverBlob) copy.coverDataURL = await blobToDataURL(b.coverBlob);
      delete copy.coverBlob;
      exportedBooks.push(copy);
    }

    const data = {
      app: 'novel-viewer',
      version: 1,
      exportedAt: new Date().toISOString(),
      books: exportedBooks,
      highlights, bookmarks, readlog, settings,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `책갈피_백업_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importAll(file) {
    const txt = await file.text();
    const data = JSON.parse(txt);
    if (data.app !== 'novel-viewer') throw new Error('이 앱의 백업 파일이 아닙니다.');

    let bookCount = 0;
    for (const b of (data.books || [])) {
      const copy = Object.assign({}, b);
      if (copy.coverDataURL) {
        copy.coverBlob = await dataURLToBlob(copy.coverDataURL);
        delete copy.coverDataURL;
      }
      // 본문은 새 기기에 없으므로 재연결 필요 표시
      copy.needsRelink = true;
      delete copy.fileHandle;
      delete copy.cachedText;
      await DB.put('books', copy);
      bookCount++;
    }
    for (const h of (data.highlights || [])) await DB.put('highlights', h);
    for (const m of (data.bookmarks || [])) await DB.put('bookmarks', m);
    for (const r of (data.readlog || [])) await DB.put('readlog', r);
    for (const s of (data.settings || [])) await DB.put('settings', s);

    return { bookCount, highlights: (data.highlights || []).length };
  }

  global.Backup = { exportAll, importAll };
})(window);
