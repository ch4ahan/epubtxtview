/* 서재 (Library).
   - TXT 1개 = 책 1권. 표지 지정/교체, 텍스트 표지 자동 생성.
   - 목록형 ↔ 그리드(표지)형 토글. 정렬. 완독 뱃지. 진행률.
   - 롱프레스 컨텍스트 메뉴: 표지 변경/제목 수정/삭제/EPUB 내보내기/읽은 기간 보기/본문 재연결. */
(function (global) {
  'use strict';

  let books = [];
  let viewMode = 'grid';   // 'grid' | 'list'
  let sortMode = 'recent'; // 'recent' | 'title' | 'added'
  let pendingCoverBookId = null;
  let pendingRelinkBookId = null;

  function uid() { return 'b_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7); }

  // 제목 → 차분한 텍스트 표지 (회색 네모 금지)
  // 파스텔 표지 톤 [배경, 글자]
  const COVER_TONES = [
    ['#f6c6d4', '#7a3b4e'], // 핑크
    ['#bfe1f5', '#345a73'], // 스카이
    ['#d7ecb3', '#4d6b2e'], // 연두
    ['#b6e7dc', '#2f6b5f'], // 청록
    ['#d9cdf0', '#544478'], // 라벤더
    ['#ffe0b8', '#8a5a25'], // 살구
  ];
  function textCoverDataURL(title) {
    const c = document.createElement('canvas');
    c.width = 300; c.height = 440;
    const ctx = c.getContext('2d');
    const tone = COVER_TONES[Math.abs(hashStr(title)) % COVER_TONES.length];
    ctx.fillStyle = tone[0];
    ctx.fillRect(0, 0, 300, 440);
    ctx.strokeStyle = tone[1]; ctx.globalAlpha = 0.5;
    ctx.strokeRect(18, 18, 264, 404);
    ctx.globalAlpha = 1;
    ctx.fillStyle = tone[1];
    ctx.font = '600 30px "Noto Serif KR", serif';
    ctx.textAlign = 'center';
    const lines = wrap(ctx, title, 230);
    let y = 200 - (lines.length - 1) * 22;
    for (const l of lines.slice(0, 6)) { ctx.fillText(l, 150, y); y += 44; }
    return c.toDataURL('image/png');
  }
  function wrap(ctx, txt, maxW) {
    const out = []; let line = '';
    for (const ch of txt) {
      if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; }
      else line += ch;
    }
    if (line) out.push(line);
    return out;
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // ───────── 정렬 ─────────
  function sortBooks() {
    const arr = books.slice();
    if (sortMode === 'title') arr.sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    else if (sortMode === 'added') arr.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    else arr.sort((a, b) => (b.lastReadAt || b.addedAt || 0) - (a.lastReadAt || a.addedAt || 0));
    return arr;
  }

  // ───────── 렌더 ─────────
  async function render() {
    books = await DB.all('books');
    const grid = document.getElementById('library-grid');
    const empty = document.getElementById('library-empty');
    grid.className = 'library ' + (viewMode === 'grid' ? 'grid-view' : 'list-view');
    grid.innerHTML = '';
    empty.classList.toggle('hidden', books.length > 0);

    for (const b of sortBooks()) {
      grid.appendChild(viewMode === 'grid' ? gridCard(b) : listRow(b));
    }
  }

  function coverSrc(b) {
    if (b._coverURL) return b._coverURL;
    if (b.coverBlob) { b._coverURL = URL.createObjectURL(b.coverBlob); return b._coverURL; }
    return textCoverDataURL(b.title);
  }

  function badges(b) {
    let h = '';
    if (b.finished) h += '<span class="badge done">다 읽음</span>';
    if (b.needsRelink) h += '<span class="badge warn">재연결 필요</span>';
    return h;
  }

  function gridCard(b) {
    const el = document.createElement('div');
    el.className = 'book-card';
    el.innerHTML = `
      <div class="cover-wrap">
        <img class="cover" src="${coverSrc(b)}" alt="${b.title}"/>
        ${badges(b)}
        <div class="progress-bar"><span style="width:${b.progress || 0}%"></span></div>
      </div>
      <div class="book-title">${escapeHtml(b.title)}</div>`;
    attachOpen(el, b);
    return el;
  }

  function listRow(b) {
    const el = document.createElement('div');
    el.className = 'book-row';
    el.innerHTML = `
      <img class="cover-mini" src="${coverSrc(b)}" alt=""/>
      <div class="row-main">
        <div class="book-title">${escapeHtml(b.title)} ${badges(b)}</div>
        <div class="row-sub muted">${b.progress || 0}% · 마지막 읽음 ${fmtDate(b.lastReadAt)}</div>
      </div>`;
    attachOpen(el, b);
    return el;
  }

  function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // ───────── 열기 + 롱프레스 ─────────
  function attachOpen(el, b) {
    let pressTimer = null, longPressed = false;
    const startPress = () => {
      longPressed = false;
      pressTimer = setTimeout(() => { longPressed = true; openContextMenu(b); }, 500);
    };
    const cancel = () => clearTimeout(pressTimer);
    el.addEventListener('touchstart', startPress, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchmove', cancel, { passive: true });
    el.addEventListener('mousedown', startPress);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); openContextMenu(b); });
    el.addEventListener('click', () => { if (!longPressed) openBook(b); });
  }

  async function openBook(b) {
    if (b.needsRelink || (!b.fileHandle && !b.cachedText)) {
      const ok = await App.confirm('본문 다시 연결', `"${b.title}"의 본문 파일이 필요해요. 지금 선택할까요?`);
      if (ok) startRelink(b);
      return;
    }
    Viewer.open(b);
  }

  function openContextMenu(b) {
    const body = document.createElement('div');
    body.className = 'context-menu';
    const items = [
      ['표지 변경', () => changeCover(b)],
      ['제목 수정', () => editTitle(b)],
      ['읽은 기간 보기', () => showReadPeriod(b)],
      ['형광펜·메모 보기', () => { App.closeModal(); Excerpts.open(b); }],
      ['EPUB으로 내보내기', () => exportEpub(b)],
      ['본문 파일 다시 연결', () => startRelink(b)],
      ['삭제', () => removeBook(b), 'danger'],
    ];
    for (const [label, fn, cls] of items) {
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (cls ? ' ' + cls : '');
      btn.textContent = label;
      btn.onclick = () => { App.closeModal(); fn(); };
      body.appendChild(btn);
    }
    App.modal(b.title, body, [{ label: '닫기' }]);
  }

  // ───────── 액션들 ─────────
  function changeCover(b) {
    pendingCoverBookId = b.id;
    document.getElementById('file-input-cover').click();
  }

  async function onCoverPicked(file) {
    const b = books.find((x) => x.id === pendingCoverBookId);
    if (!b) return;
    b.coverBlob = file;
    if (b._coverURL) { URL.revokeObjectURL(b._coverURL); b._coverURL = null; }
    await DB.put('books', b);
    await render();
    App.toast('표지를 바꿨어요');
  }

  async function editTitle(b) {
    const val = await App.prompt('제목 수정', b.title);
    if (val == null) return;
    b.title = val.trim() || b.title;
    await DB.put('books', b);
    await render();
  }

  async function showReadPeriod(b) {
    const logs = (await DB.byIndex('readlog', 'bookId', b.id)).map((r) => r.date).sort();
    const body = document.createElement('div');
    body.className = 'read-period';
    const days = logs.length;
    body.innerHTML = `
      <dl>
        <dt>처음 펼친 날</dt><dd>${fmtDate(b.firstOpenedAt)}</dd>
        <dt>마지막 읽은 날</dt><dd>${fmtDate(b.lastReadAt)}</dd>
        <dt>읽은 기간</dt><dd>${b.firstOpenedAt ? fmtDate(b.firstOpenedAt) + ' ~ ' + fmtDate(b.lastReadAt) : '아직 안 읽음'}</dd>
        <dt>읽은 날 수</dt><dd>${days}일</dd>
        <dt>완독</dt><dd>${b.finished ? '완독 (' + fmtDate(b.finishedAt) + ')' : '읽는 중 (' + (b.progress || 0) + '%)'}</dd>
      </dl>
      ${days ? '<div class="log-dates muted">' + logs.join(', ') + '</div>' : ''}`;
    App.modal('읽은 기간 — ' + b.title, body, [{ label: '닫기' }]);
  }

  async function exportEpub(b) {
    const loaded = await App.loadBookText(b);
    if (!loaded) return;
    App.toast('EPUB 만드는 중…');
    const chapters = b.chapters && b.chapters.length ? b.chapters : Chapters.detect(loaded.text);
    const blob = await Epub.build(b, loaded.text, chapters);
    Cards.download(blob, b.title.replace(/[\\/:*?"<>|]/g, '_') + '.epub');
    App.toast('EPUB을 내보냈어요');
  }

  async function removeBook(b) {
    const ok = await App.confirm('삭제', `"${b.title}"을(를) 서재에서 지울까요?\n(형광펜·메모·읽기 기록도 함께 삭제됩니다. 원본 TXT 파일은 그대로 남습니다.)`);
    if (!ok) return;
    await DB.del('books', b.id);
    await DB.delByIndex('highlights', 'bookId', b.id);
    await DB.delByIndex('bookmarks', 'bookId', b.id);
    await DB.delByIndex('readlog', 'bookId', b.id);
    await render();
    App.toast('삭제했어요');
  }

  function startRelink(b) {
    pendingRelinkBookId = b.id;
    App.pickText(async (file, handle) => {
      const buf = await file.arrayBuffer();
      const { text, encoding } = Encoding.decode(buf);
      b.encoding = encoding;
      b.fileName = file.name;
      if (handle) b.fileHandle = handle; else b.cachedText = text;
      b.needsRelink = false;
      b.chapters = Chapters.detect(text);
      // 형광펜 재연결
      const res = await Highlights.relinkAll(b.id, text);
      await DB.put('books', b);
      await render();
      App.toast(`연결 완료 · 형광펜 ${res.linked}/${res.total} 자동 연결` + (res.needCheck ? `, ${res.needCheck}개 확인 필요` : ''));
      Viewer.open(b);
    });
  }

  // ───────── 새 책 추가 ─────────
  async function addBookFromFile(file, handle) {
    const buf = await file.arrayBuffer();
    const { text, encoding } = Encoding.decode(buf);
    const title = file.name.replace(/\.txt$/i, '');
    const book = {
      id: uid(),
      title,
      encoding,
      fileName: file.name,
      size: file.size,
      charCount: text.length,
      addedAt: Date.now(),
      firstOpenedAt: null,
      lastReadAt: null,
      readPosition: 0,
      progress: 0,
      finished: false,
      chapters: Chapters.detect(text),
    };
    if (handle) book.fileHandle = handle;
    else book.cachedText = text; // 핸들 미지원 환경 폴백
    await DB.put('books', book);
    await render();
    App.toast(`"${title}" 추가됨`);
  }

  // ───────── 툴바 ─────────
  function init() {
    document.getElementById('btn-add-book').onclick = () => {
      App.pickText((file, handle) => addBookFromFile(file, handle));
    };
    document.getElementById('btn-view-toggle').onclick = async () => {
      viewMode = viewMode === 'grid' ? 'list' : 'grid';
      await DB.setSetting('viewMode', viewMode);
      render();
    };
    document.getElementById('btn-sort').onclick = () => {
      const order = ['recent', 'title', 'added'];
      const labels = { recent: '최근 읽은 순', title: '제목순', added: '추가한 순' };
      sortMode = order[(order.indexOf(sortMode) + 1) % order.length];
      DB.setSetting('sortMode', sortMode);
      App.toast('정렬: ' + labels[sortMode]);
      render();
    };
    document.getElementById('file-input-cover').addEventListener('change', (e) => {
      if (e.target.files[0]) onCoverPicked(e.target.files[0]);
      e.target.value = '';
    });

    // 백업 메뉴
    document.getElementById('btn-backup').onclick = openBackupMenu;
  }

  function openBackupMenu() {
    const body = document.createElement('div');
    body.className = 'context-menu';
    const exportBtn = document.createElement('button');
    exportBtn.className = 'ctx-item';
    exportBtn.textContent = 'JSON 백업 내보내기';
    exportBtn.onclick = async () => { App.closeModal(); await Backup.exportAll(); App.toast('백업을 저장했어요'); };
    const importBtn = document.createElement('button');
    importBtn.className = 'ctx-item';
    importBtn.textContent = 'JSON 백업 불러오기';
    importBtn.onclick = () => { App.closeModal(); document.getElementById('file-input-json').click(); };
    body.appendChild(exportBtn); body.appendChild(importBtn);
    App.modal('백업 / 복원', body, [{ label: '닫기' }]);
  }

  async function loadPrefs() {
    viewMode = await DB.getSetting('viewMode', 'grid');
    sortMode = await DB.getSetting('sortMode', 'recent');
  }

  global.Library = { init, render, loadPrefs, addBookFromFile };
})(window);
