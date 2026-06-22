/* 뷰어 (읽기 화면).
   - 페이지 넘김(스크롤 아님, 애니메이션 없음): CSS 다단(column)으로 페이지 분할 후 translateX.
   - 큰 책도 즉시 열리도록 본문을 '창(window, 약 8천자)' 단위로만 렌더 → 무한로딩 방지.
   - 자유 터치 영역: 좌표 기반 그리드(가변 경계)로 다음/이전/메뉴 재배정 (기본 U자).
   - 읽기 옵션: 글씨 크기 / 문단 간격 / 여백 / 테마. 기본은 흰 바탕·검은 글씨(시스템 밝기 따름).
   - 이어보기: 페이지 넘길 때마다 '글자 오프셋'으로 실시간 저장 → 강제 종료에도 복원.
   - 형광펜/북마크: 문장 기반 앵커. 목차/완독 처리. */
(function (global) {
  'use strict';

  // 파스텔 형광펜 (핑크 · 스카이 · 연두 · 청록)
  const HL_COLORS = [
    { id: 'pink', label: '핑크', color: '#f6c6d4' },
    { id: 'sky', label: '스카이', color: '#bfe1f5' },
    { id: 'green', label: '연두', color: '#d7ecb3' },
    { id: 'teal', label: '청록', color: '#b6e7dc' },
  ];

  const WIN_SIZE = 8000; // 한 창의 대략 글자 수

  let book = null;
  let text = '';
  let windows = [];      // [{start, end}] 본문을 나눈 창들
  let curWin = 0;        // 현재 창 인덱스
  let winPages = 1;      // 현재 창의 페이지 수
  let paras = [];        // [{start(글로벌), left, el}] 현재 창 문단 위치
  let pageUnit = 0;      // 한 페이지 폭 + 간격
  let curPage = 0;       // 현재 창 내 페이지
  let hlMode = false;
  let opts = null;
  let zones = null;
  let menuVisible = false;
  let highlightsCache = [];
  let bookmarksCache = [];

  const $page = () => document.getElementById('reader-page');
  const $touch = () => document.getElementById('touch-layer');
  const $menu = () => document.getElementById('reader-menu');
  const content = () => $page().firstElementChild;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ───────── 옵션/영역 기본값 ─────────
  const DEFAULT_OPTS = { fontSize: 20, lineHeight: 1.8, paraGap: 14, margin: 22, theme: 'light' };
  const DEFAULT_ZONES = {
    rows: [0.12, 0.85],
    cols: [0.22, 0.78],
    cells: ['menu', 'menu', 'menu', 'next', 'prev', 'next', 'next', 'next', 'next'],
  };

  async function loadOpts() {
    const saved = await DB.getSetting('readOpts', null);
    opts = Object.assign({}, DEFAULT_OPTS, saved || {});
    if (!saved || !saved.theme) {
      // 처음엔 시스템 밝기를 따른다 (다크면 다크, 아니면 라이트)
      opts.theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    zones = Object.assign({}, DEFAULT_ZONES, await DB.getSetting('touchZones', {}));
    document.body.dataset.theme = opts.theme;
  }
  async function saveOpts() { await DB.setSetting('readOpts', opts); }
  async function saveZones() { await DB.setSetting('touchZones', zones); }

  // ───────── 창 분할 ─────────
  function buildWindows() {
    windows = [];
    const lines = text.split('\n');
    let pos = 0, winStart = 0;
    for (const line of lines) {
      pos += line.length + 1;
      if (pos - winStart >= WIN_SIZE) { windows.push({ start: winStart, end: pos }); winStart = pos; }
    }
    if (winStart < text.length || windows.length === 0) windows.push({ start: winStart, end: text.length });
  }
  function windowOfOffset(off) {
    for (let i = 0; i < windows.length; i++) {
      if (off >= windows[i].start && off < windows[i].end) return i;
    }
    return windows.length - 1;
  }

  // ───────── HTML 빌드 ─────────
  function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function renderParagraph(rawStart, line, hls) {
    const pEnd = rawStart + line.length;
    const overlaps = hls
      .filter((h) => h.status === 'linked' && h.end > rawStart && h.start < pEnd)
      .sort((a, b) => a.start - b.start);
    if (overlaps.length === 0) return esc(line);
    let html = '', cursor = rawStart;
    for (const h of overlaps) {
      const s = Math.max(rawStart, h.start), e = Math.min(pEnd, h.end);
      if (s > cursor) html += esc(text.slice(cursor, s));
      const c = (HL_COLORS.find((x) => x.id === h.color) || HL_COLORS[0]).color;
      const noteMark = h.note ? ' data-note="1"' : '';
      html += `<mark class="hl" data-id="${h.id}"${noteMark} style="--hl:${c}">${esc(text.slice(s, e))}</mark>`;
      cursor = e;
    }
    if (cursor < pEnd) html += esc(text.slice(cursor, pEnd));
    return html;
  }

  function buildContent(winStart, winEnd) {
    const seg = text.slice(winStart, winEnd);
    const lines = seg.split('\n');
    let offset = winStart, html = '';
    for (const line of lines) {
      const start = offset;
      if (line.trim() === '') html += `<p class="para blank" data-start="${start}"></p>`;
      else html += `<p class="para" data-start="${start}">${renderParagraph(start, line, highlightsCache)}</p>`;
      offset += line.length + 1;
    }
    return html;
  }

  function applyStyleVars() {
    const p = $page();
    p.style.setProperty('--fs', opts.fontSize + 'px');
    p.style.setProperty('--lh', opts.lineHeight);
    p.style.setProperty('--pgap', opts.paraGap + 'px');
    p.style.setProperty('--mg', opts.margin + 'px');
  }

  // ───────── 창 렌더 + 페이지 분할 ─────────
  function renderWindow(winIndex, keepOffset) {
    curWin = clamp(winIndex, 0, windows.length - 1);
    const w = windows[curWin];
    $page().innerHTML = `<div class="reader-content">${buildContent(w.start, w.end)}</div>`;
    layoutWindow(keepOffset);
    bindMarkClicks();
  }

  function layoutWindow(keepOffset) {
    const p = $page();
    applyStyleVars();
    const c = content();
    if (!c) return;
    c.style.transform = 'translateX(0)';

    const colW = p.clientWidth - opts.margin * 2;
    const colH = p.clientHeight - opts.margin * 2;
    if (colW <= 0 || colH <= 0) { setTimeout(() => layoutWindow(keepOffset), 60); return; }

    c.style.columnWidth = colW + 'px';
    c.style.columnGap = (opts.margin * 2) + 'px';
    c.style.height = colH + 'px';
    c.style.width = colW + 'px';
    pageUnit = colW + opts.margin * 2;

    winPages = Math.max(1, Math.round(c.scrollWidth / pageUnit));

    paras = [];
    const cr = c.getBoundingClientRect();
    c.querySelectorAll('.para').forEach((el) => {
      const r = el.getBoundingClientRect();
      paras.push({ start: parseInt(el.dataset.start, 10), left: r.left - cr.left });
    });

    const w = windows[curWin];
    if (keepOffset != null && keepOffset >= w.start && keepOffset <= w.end) curPage = pageOfOffset(keepOffset);
    else curPage = clamp(curPage, 0, winPages - 1);

    applyTransform();
    updateMenu();
    persistPosition();
  }

  function applyTransform() {
    const c = content();
    if (c) c.style.transform = `translateX(${-curPage * pageUnit}px)`;
  }

  function pageOfOffset(globalOffset) {
    let target = paras[0];
    for (const pr of paras) { if (pr.start <= globalOffset) target = pr; else break; }
    if (!target) return 0;
    return clamp(Math.round(target.left / pageUnit), 0, winPages - 1);
  }
  function offsetOfPage(page) {
    let best = windows[curWin].start;
    for (const pr of paras) { if (Math.round(pr.left / pageUnit) <= page) best = pr.start; else break; }
    return best;
  }
  function globalTop() { return offsetOfPage(curPage); }

  // ───────── 페이지/창 이동 ─────────
  function goToPage(page) {
    curPage = clamp(page, 0, winPages - 1);
    applyTransform();
    updateMenu();
    persistPosition();
    checkFinished();
  }
  function nextPage() {
    if (curPage < winPages - 1) return goToPage(curPage + 1);
    if (curWin < windows.length - 1) { renderWindow(curWin + 1, windows[curWin + 1].start); }
    else checkFinished(true);
  }
  function prevPage() {
    if (curPage > 0) return goToPage(curPage - 1);
    if (curWin > 0) { renderWindow(curWin - 1, windows[curWin - 1].end - 1); }
  }
  function goToOffset(globalOffset) {
    const wi = windowOfOffset(globalOffset);
    if (wi !== curWin) renderWindow(wi, globalOffset);
    else { curPage = pageOfOffset(globalOffset); applyTransform(); updateMenu(); persistPosition(); }
  }

  // ───────── 이어보기 저장 ─────────
  let saveTimer = null;
  function persistPosition() {
    if (!book) return;
    book.readPosition = globalTop();
    book.lastReadAt = Date.now();
    book.progress = progressPercent();
    logToday();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.put('books', book), 150);
  }
  function progressPercent() {
    if (!text.length) return 0;
    return clamp(Math.round((globalTop() / text.length) * 100), 0, 100);
  }
  function logToday() {
    const today = new Date().toISOString().slice(0, 10);
    if (book._lastLog === today) return;
    book._lastLog = today;
    DB.put('readlog', { id: book.id + '_' + today, bookId: book.id, date: today });
  }
  function checkFinished(forced) {
    if (!book) return;
    const atEnd = curWin >= windows.length - 1 && curPage >= winPages - 1;
    if ((atEnd || forced) && !book.finished) {
      book.finished = true; book.finishedAt = Date.now(); book.progress = 100;
      DB.put('books', book);
      App.toast('🎉 완독 처리했어요');
    }
  }

  // ───────── 메뉴 ─────────
  function updateMenu() {
    const ind = document.querySelector('.page-indicator');
    if (ind) ind.textContent = `${progressPercent()}% 읽음`;
    const slider = document.getElementById('page-slider');
    if (slider) { slider.min = 0; slider.max = 1000; slider.value = progressPercent() * 10; }
    const bm = document.getElementById('btn-bookmark');
    if (bm) bm.classList.toggle('active', !!currentPageBookmark());
  }
  function toggleMenu(force) {
    menuVisible = force != null ? force : !menuVisible;
    $menu().classList.toggle('hidden', !menuVisible);
  }

  // ───────── 북마크 ─────────
  function pageRange() {
    const start = globalTop();
    const end = curPage + 1 < winPages ? offsetOfPage(curPage + 1) : windows[curWin].end;
    return { start, end };
  }
  function currentPageBookmark() {
    const { start, end } = pageRange();
    return bookmarksCache.find((b) => b.position >= start && b.position < end);
  }
  async function toggleBookmark() {
    const existing = currentPageBookmark();
    if (existing) { await DB.del('bookmarks', existing.id); App.toast('북마크를 뺐어요'); }
    else {
      const pos = globalTop();
      const snippetEnd = Math.min(text.length, pos + 60);
      await DB.put('bookmarks', {
        id: 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        bookId: book.id, position: pos,
        snippet: text.slice(pos, snippetEnd).replace(/\s+/g, ' ').trim(),
        anchor: Highlights.makeAnchor(text, pos, snippetEnd), createdAt: Date.now(),
      });
      App.toast('🔖 북마크를 더했어요');
    }
    bookmarksCache = await DB.byIndex('bookmarks', 'bookId', book.id);
    updateMenu();
  }

  // ───────── 터치 영역 ─────────
  function actionAt(x, y, w, h) {
    const fx = x / w, fy = y / h;
    const col = fx < zones.cols[0] ? 0 : fx < zones.cols[1] ? 1 : 2;
    const row = fy < zones.rows[0] ? 0 : fy < zones.rows[1] ? 1 : 2;
    return zones.cells[row * 3 + col];
  }
  function onTouchTap(e) {
    if (hlMode) return;
    const rect = $touch().getBoundingClientRect();
    const x = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - rect.left;
    const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) - rect.top;
    const act = actionAt(x, y, rect.width, rect.height);
    if (act === 'next') nextPage();
    else if (act === 'prev') prevPage();
    else if (act === 'menu') toggleMenu();
  }
  let downX = 0, downY = 0, downT = 0;
  function bindTouch() {
    const t = $touch();
    const onDown = (e) => { const pt = e.changedTouches ? e.changedTouches[0] : e; downX = pt.clientX; downY = pt.clientY; downT = Date.now(); };
    const onUp = (e) => {
      const pt = e.changedTouches ? e.changedTouches[0] : e;
      const dx = pt.clientX - downX, dy = pt.clientY - downY, dt = Date.now() - downT;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) nextPage(); else prevPage(); return; }
      if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && dt < 500) onTouchTap(e);
    };
    t.addEventListener('touchstart', onDown, { passive: true });
    t.addEventListener('touchend', onUp, { passive: true });
    t.addEventListener('mousedown', onDown);
    t.addEventListener('mouseup', onUp);
  }

  // ───────── 형광펜 ─────────
  function setHlMode(on) {
    hlMode = on;
    $touch().style.pointerEvents = on ? 'none' : 'auto';
    document.getElementById('btn-highlight-mode').classList.toggle('active', on);
    App.toast(on ? '🖊 형광펜 모드: 본문을 드래그해 선택하세요' : '읽기 모드');
  }
  function pointToOffset(node, offsetInNode) {
    let el = node.nodeType === 3 ? node.parentNode : node;
    const para = el.closest ? el.closest('.para') : (el.parentNode && el.parentNode.closest('.para'));
    if (!para) return null;
    const base = parseInt(para.dataset.start, 10);
    const range = document.createRange();
    range.setStart(para, 0);
    range.setEnd(node, offsetInNode);
    return base + range.toString().length;
  }
  async function onSelectionHighlight() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0);
    const a = pointToOffset(r.startContainer, r.startOffset);
    const b = pointToOffset(r.endContainer, r.endOffset);
    if (a == null || b == null) return;
    const s = Math.min(a, b), eo = Math.max(a, b);
    if (eo - s < 1) return;
    sel.removeAllRanges();
    openHighlightDialog(s, eo);
  }
  function openHighlightDialog(start, end, existing) {
    const quote = text.slice(start, end);
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="hl-quote">${esc(quote.slice(0, 200))}${quote.length > 200 ? '…' : ''}</div>
      <div class="hl-colors"></div>
      <textarea class="hl-note" placeholder="메모 (선택)">${existing ? esc(existing.note || '') : ''}</textarea>`;
    const colorWrap = body.querySelector('.hl-colors');
    let chosen = existing ? existing.color : HL_COLORS[0].id;
    HL_COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.className = 'hl-swatch' + (c.id === chosen ? ' sel' : '');
      sw.style.background = c.color; sw.title = c.label;
      sw.onclick = () => { chosen = c.id; colorWrap.querySelectorAll('.hl-swatch').forEach((x) => x.classList.remove('sel')); sw.classList.add('sel'); };
      colorWrap.appendChild(sw);
    });
    const buttons = [{ label: existing ? '저장' : '형광펜 추가', primary: true, onClick: async () => {
      const note = body.querySelector('.hl-note').value.trim();
      if (existing) { existing.color = chosen; existing.note = note; await DB.put('highlights', existing); }
      else await DB.put('highlights', { id: Highlights.uid(), bookId: book.id, color: chosen, note, anchor: Highlights.makeAnchor(text, start, end), start, end, status: 'linked', createdAt: Date.now() });
      await reloadHighlights();
      App.toast('형광펜을 저장했어요');
    }}];
    if (existing) buttons.unshift({ label: '삭제', danger: true, onClick: async () => { await DB.del('highlights', existing.id); await reloadHighlights(); App.toast('삭제했어요'); }});
    App.modal(existing ? '형광펜 편집' : '형광펜', body, buttons);
  }
  async function reloadHighlights() {
    highlightsCache = await DB.byIndex('highlights', 'bookId', book.id);
    renderWindow(curWin, globalTop());
  }
  function bindMarkClicks() {
    content().querySelectorAll('mark.hl').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (!hlMode) return;
        e.stopPropagation();
        const h = highlightsCache.find((x) => x.id === m.dataset.id);
        if (h) openHighlightDialog(h.start, h.end, h);
      });
    });
  }

  // ───────── 목차 ─────────
  function openTOC() {
    const body = document.createElement('div');
    body.className = 'toc-list';
    if (bookmarksCache.length) {
      const head = document.createElement('div'); head.className = 'toc-head'; head.textContent = '🔖 북마크'; body.appendChild(head);
      bookmarksCache.slice().sort((a, b) => a.position - b.position).forEach((m) => {
        const b = document.createElement('button'); b.className = 'toc-item bm'; b.textContent = m.snippet || '(북마크)';
        b.onclick = () => { goToOffset(m.position); App.closeModal(); toggleMenu(false); }; body.appendChild(b);
      });
      const h2 = document.createElement('div'); h2.className = 'toc-head'; h2.textContent = '목차'; body.appendChild(h2);
    }
    (book.chapters || []).forEach((ch) => {
      const b = document.createElement('button'); b.className = 'toc-item'; b.textContent = ch.title;
      b.onclick = () => { goToOffset(ch.offset); App.closeModal(); toggleMenu(false); }; body.appendChild(b);
    });
    App.modal('목차 · 북마크', body, [{ label: '닫기' }]);
  }

  // ───────── 읽기 설정 ─────────
  function openSettings() {
    const body = document.createElement('div');
    body.className = 'settings-panel';
    body.innerHTML = `
      <label>글씨 크기 <output>${opts.fontSize}</output><input type="range" min="14" max="34" value="${opts.fontSize}" data-k="fontSize"></label>
      <label>문단 간격 <output>${opts.paraGap}</output><input type="range" min="0" max="40" value="${opts.paraGap}" data-k="paraGap"></label>
      <label>줄 간격 <output>${opts.lineHeight}</output><input type="range" min="1.3" max="2.4" step="0.1" value="${opts.lineHeight}" data-k="lineHeight"></label>
      <label>화면 여백 <output>${opts.margin}</output><input type="range" min="8" max="60" value="${opts.margin}" data-k="margin"></label>
      <div class="theme-row">
        <button data-theme="light">라이트</button>
        <button data-theme="sepia">세피아</button>
        <button data-theme="dark">다크</button>
      </div>
      <button class="link-btn" id="open-zone-editor">터치 영역 설정 (다음/이전/메뉴)</button>`;
    body.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
      const k = inp.dataset.k;
      opts[k] = k === 'lineHeight' ? parseFloat(inp.value) : parseInt(inp.value, 10);
      inp.parentNode.querySelector('output').textContent = opts[k];
      const off = globalTop();
      layoutWindow(off);
      saveOpts();
    }));
    body.querySelectorAll('.theme-row button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.theme === opts.theme);
      b.onclick = () => { opts.theme = b.dataset.theme; document.body.dataset.theme = opts.theme; body.querySelectorAll('.theme-row button').forEach((x) => x.classList.toggle('sel', x === b)); saveOpts(); };
    });
    body.querySelector('#open-zone-editor').onclick = () => { App.closeModal(); openZoneEditor(); };
    App.modal('읽기 설정', body, [{ label: '닫기' }]);
  }

  function openZoneEditor() {
    const body = document.createElement('div');
    body.className = 'zone-editor';
    body.innerHTML = `
      <p class="muted">각 칸을 눌러 역할을 바꾸세요. 슬라이더로 영역 크기를 조절합니다.</p>
      <div class="zone-grid"></div>
      <label>상단 띠 높이 <input type="range" min="0.05" max="0.3" step="0.01" value="${zones.rows[0]}" data-k="r0"></label>
      <label>하단 영역 시작 <input type="range" min="0.6" max="0.95" step="0.01" value="${zones.rows[1]}" data-k="r1"></label>
      <label>좌측 영역 폭 <input type="range" min="0.1" max="0.45" step="0.01" value="${zones.cols[0]}" data-k="c0"></label>
      <label>우측 영역 시작 <input type="range" min="0.55" max="0.9" step="0.01" value="${zones.cols[1]}" data-k="c1"></label>
      <button class="link-btn" id="zone-reset">기본값(U자)로 되돌리기</button>`;
    const grid = body.querySelector('.zone-grid');
    const ROLES = ['next', 'prev', 'menu'], LABEL = { next: '다음', prev: '이전', menu: '메뉴' };
    function paint() {
      grid.innerHTML = '';
      zones.cells.forEach((role, i) => {
        const cell = document.createElement('button');
        cell.className = 'zone-cell role-' + role; cell.textContent = LABEL[role];
        cell.onclick = () => { zones.cells[i] = ROLES[(ROLES.indexOf(role) + 1) % ROLES.length]; saveZones(); paint(); };
        grid.appendChild(cell);
      });
    }
    paint();
    body.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      ({ r0: () => zones.rows[0] = v, r1: () => zones.rows[1] = v, c0: () => zones.cols[0] = v, c1: () => zones.cols[1] = v }[inp.dataset.k])();
      saveZones();
    }));
    body.querySelector('#zone-reset').onclick = () => { zones = JSON.parse(JSON.stringify(DEFAULT_ZONES)); saveZones(); App.closeModal(); openZoneEditor(); };
    App.modal('터치 영역 설정', body, [{ label: '닫기' }]);
  }

  // ───────── 열기/닫기 ─────────
  async function open(b) {
    book = b;
    await loadOpts();
    App.showScreen('reader');
    document.getElementById('reader-title').textContent = b.title;
    $page().innerHTML = '<div class="reader-loading">불러오는 중…</div>';

    const loaded = await App.loadBookText(b);
    if (!loaded) { close(); return; }
    text = loaded.text;

    if (!book.chapters || !book.chapters.length) book.chapters = Chapters.detect(text);
    if (!book.firstOpenedAt) book.firstOpenedAt = Date.now();
    highlightsCache = await DB.byIndex('highlights', 'bookId', book.id);
    bookmarksCache = await DB.byIndex('bookmarks', 'bookId', book.id);
    buildWindows();

    const startOffset = book.readPosition || 0;
    renderWindow(windowOfOffset(startOffset), startOffset);

    // 컨트롤이 있다는 걸 알 수 있도록 메뉴를 잠깐 보여줬다 닫는다
    toggleMenu(true);
    setTimeout(() => { if (menuVisible) toggleMenu(false); }, 1600);
  }

  function close() {
    if (book) { persistPosition(); DB.put('books', book); }
    setHlMode(false);
    toggleMenu(false);
    text = ''; windows = []; paras = [];
    App.showScreen('library');
    if (global.Library) Library.render();
  }

  function isActive() { return document.getElementById('screen-reader').classList.contains('active'); }

  // ───────── 초기화 ─────────
  function init() {
    bindTouch();
    document.getElementById('btn-reader-back').onclick = close;
    document.getElementById('btn-toc').onclick = openTOC;
    document.getElementById('btn-bookmark').onclick = toggleBookmark;
    document.getElementById('btn-reader-settings').onclick = openSettings;
    document.getElementById('btn-highlight-mode').onclick = () => setHlMode(!hlMode);
    document.getElementById('page-slider').addEventListener('change', (e) => {
      const off = Math.round((parseInt(e.target.value, 10) / 1000) * text.length);
      goToOffset(clamp(off, 0, text.length - 1));
    });
    document.getElementById('page-slider').addEventListener('input', (e) => {
      const ind = document.querySelector('.page-indicator');
      if (ind) ind.textContent = `${Math.round(parseInt(e.target.value, 10) / 10)}% 읽음`;
    });

    document.addEventListener('mouseup', () => { if (hlMode && isActive()) setTimeout(onSelectionHighlight, 10); });
    $page().addEventListener('touchend', () => { if (hlMode) setTimeout(onSelectionHighlight, 10); });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && book) DB.put('books', book); });
    window.addEventListener('pagehide', () => { if (book) DB.put('books', book); });

    document.addEventListener('keydown', (e) => {
      if (!isActive()) return;
      if (e.key === 'ArrowRight' || e.key === ' ') nextPage();
      if (e.key === 'ArrowLeft') prevPage();
    });
    window.addEventListener('resize', () => { if (isActive() && book) layoutWindow(globalTop()); });
  }

  global.Viewer = { init, open, close, isActive, HL_COLORS };
})(window);
