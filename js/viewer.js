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
  let paras = [];        // [{start(글로벌), page}] 현재 창 문단의 페이지 위치
  let pageTops = [0];    // 각 페이지의 세로 시작 위치(px)
  let curPage = 0;       // 현재 창 내 페이지
  let opts = null;
  let zones = null;
  let menuVisible = false;
  let highlightsCache = [];
  let bookmarksCache = [];

  const $page = () => document.getElementById('reader-page');
  const $menu = () => document.getElementById('reader-menu');
  const content = () => $page().querySelector('.reader-content');
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
    $page().innerHTML = `<div class="reader-viewport"><div class="reader-content">${buildContent(w.start, w.end)}</div></div>`;
    layoutWindow(keepOffset);
  }

  function layoutWindow(keepOffset) {
    const p = $page();
    applyStyleVars();
    const c = content();
    if (!c) return;
    c.style.transform = 'translateY(0)';

    const availW = p.clientWidth - opts.margin * 2;
    const colH = p.clientHeight - opts.margin * 2;
    if (availW <= 0 || colH <= 0) { setTimeout(() => layoutWindow(keepOffset), 60); return; }
    c.style.width = availW + 'px';

    // 페이지 분할: 세로로 쌓인 문단을 '한 화면 높이(colH)' 안에 들어가도록 묶는다.
    // 페이지 경계는 항상 '문단 사이'에만 생기므로 글줄이 잘리지 않는다.
    const els = c.querySelectorAll('.para');
    pageTops = [0];
    let curTop = 0;
    els.forEach((el) => {
      const top = el.offsetTop;
      const bottom = top + el.offsetHeight;
      if (bottom - curTop > colH + 1) {
        let newTop = top > curTop ? top : curTop + colH; // 한 문단이 화면보다 크면 강제로 끊음
        pageTops.push(newTop);
        curTop = newTop;
        while (bottom - curTop > colH + 1) { curTop += colH; pageTops.push(curTop); }
      }
    });
    winPages = pageTops.length;

    // 각 문단이 속한 페이지를 미리 계산
    paras = [];
    els.forEach((el) => {
      const top = el.offsetTop;
      let pg = 0;
      for (let k = 0; k < pageTops.length; k++) { if (pageTops[k] <= top + 0.5) pg = k; else break; }
      paras.push({ start: parseInt(el.dataset.start, 10), page: pg });
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
    if (c) c.style.transform = `translateY(${-(pageTops[curPage] || 0)}px)`;
  }

  function pageOfOffset(globalOffset) {
    let target = paras[0];
    for (const pr of paras) { if (pr.start <= globalOffset) target = pr; else break; }
    return target ? target.page : 0;
  }
  function offsetOfPage(page) {
    for (const pr of paras) { if (pr.page === page) return pr.start; } // 그 페이지 맨 위 문단
    let best = windows[curWin].start;
    for (const pr of paras) { if (pr.page < page) best = pr.start; else break; }
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
  function topBandPx() { return Math.max(52, $page().clientHeight * 0.07); }
  function hasSelection() {
    const s = window.getSelection();
    return s && !s.isCollapsed && s.rangeCount > 0 && String(s).trim().length > 0;
  }
  function onTap(x, y, rect) {
    if (menuVisible) { toggleMenu(false); return; }     // 메뉴가 떠 있으면 탭으로 닫기
    if (y < topBandPx()) { toggleMenu(true); return; }   // 최상단은 항상 툴바 열기
    const act = actionAt(x, y, rect.width, rect.height);
    if (act === 'next') nextPage();
    else if (act === 'prev') prevPage();
    else toggleMenu();
  }
  let downX = 0, downY = 0, downT = 0;
  function bindTouch() {
    const p = $page();
    const onDown = (e) => { const pt = e.changedTouches ? e.changedTouches[0] : e; downX = pt.clientX; downY = pt.clientY; downT = Date.now(); };
    const onUp = (e) => {
      const pt = e.changedTouches ? e.changedTouches[0] : e;
      // 본문을 길게 눌러 선택했으면 페이지 이동 대신 형광펜
      if (hasSelection()) { setTimeout(onSelectionHighlight, 10); return; }
      // 기존 형광펜을 탭하면 편집
      const markEl = e.target && e.target.closest ? e.target.closest('mark.hl') : null;
      if (markEl) { const h = highlightsCache.find((x) => x.id === markEl.dataset.id); if (h) { openHighlightDialog(h.start, h.end, h); return; } }
      const dx = pt.clientX - downX, dy = pt.clientY - downY, dt = Date.now() - downT;
      const rect = p.getBoundingClientRect();
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) nextPage(); else prevPage(); return; }
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14 && dt < 600) onTap(pt.clientX - rect.left, pt.clientY - rect.top, rect);
    };
    p.addEventListener('touchstart', onDown, { passive: true });
    p.addEventListener('touchend', onUp, { passive: true });
    p.addEventListener('mousedown', onDown);
    p.addEventListener('mouseup', onUp);
  }

  // ───────── 형광펜 (길게 눌러 선택 → 바로 칠하기) ─────────
  let defaultHlColor = HL_COLORS[0].id;
  async function loadHlColor() { defaultHlColor = await DB.getSetting('hlColor', HL_COLORS[0].id); }
  function openColorChooser() {
    const body = document.createElement('div');
    body.innerHTML = '<p class="muted">본문을 길게 눌러 문장을 선택하면 이 색으로 바로 칠해져요.</p><div class="hl-colors"></div>';
    const wrap = body.querySelector('.hl-colors');
    HL_COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.className = 'hl-swatch' + (c.id === defaultHlColor ? ' sel' : '');
      sw.style.background = c.color; sw.title = c.label;
      sw.onclick = () => { defaultHlColor = c.id; DB.setSetting('hlColor', c.id); wrap.querySelectorAll('.hl-swatch').forEach((x) => x.classList.remove('sel')); sw.classList.add('sel'); };
      wrap.appendChild(sw);
    });
    App.modal('형광펜 색', body, [{ label: '닫기' }]);
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
    if (!hasSelection()) return;
    const r = sel.getRangeAt(0);
    const a = pointToOffset(r.startContainer, r.startOffset);
    const b = pointToOffset(r.endContainer, r.endOffset);
    if (a == null || b == null) return;
    const s = Math.min(a, b), eo = Math.max(a, b);
    if (eo - s < 1) return;
    // 같은 구간이 이미 칠해져 있으면 중복 생성 금지
    if (highlightsCache.some((x) => x.status === 'linked' && x.start === s && x.end === eo)) { sel.removeAllRanges(); return; }
    sel.removeAllRanges();   // 선택 해제 → 안드로이드 기본 선택 메뉴도 사라짐
    // 바로 칠하기: 기본색으로 즉시 형광펜 생성 (색·메모 수정은 형광펜을 탭)
    const h = { id: Highlights.uid(), bookId: book.id, color: defaultHlColor, note: '', anchor: Highlights.makeAnchor(text, s, eo), start: s, end: eo, status: 'linked', createdAt: Date.now() };
    await DB.put('highlights', h);
    highlightsCache.push(h);
    renderWindow(curWin, globalTop());
    App.toast('형광펜 칠함 · 탭하면 색/메모 편집');
  }
  function openHighlightDialog(start, end, existing) {
    const quote = text.slice(start, end);
    const body = document.createElement('div');
    body.innerHTML = `
      <div class="hl-quote">${esc(quote.slice(0, 200))}${quote.length > 200 ? '…' : ''}</div>
      <div class="hl-colors"></div>
      <textarea class="hl-note" placeholder="메모 (선택)">${existing ? esc(existing.note || '') : ''}</textarea>`;
    const colorWrap = body.querySelector('.hl-colors');
    let chosen = existing ? existing.color : defaultHlColor;
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

  // ───────── 본문 검색 ─────────
  function chapterOf(offset) {
    let t = '';
    for (const ch of (book.chapters || [])) { if (ch.offset <= offset) t = ch.title; else break; }
    return t;
  }
  function flashParaAt(offset) {
    setTimeout(() => {
      const els = content().querySelectorAll('.para');
      let target = null;
      els.forEach((el) => { if (parseInt(el.dataset.start, 10) <= offset) target = el; });
      if (target) { target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1900); }
    }, 90);
  }
  function openSearch() {
    const body = document.createElement('div');
    body.className = 'search-panel';
    body.innerHTML = `
      <input class="prompt-input" id="search-q" placeholder="본문에서 검색…" inputmode="search" autocomplete="off">
      <div class="search-count muted" id="search-count">단어를 입력하면 본문에서 찾아요</div>
      <div class="search-results" id="search-results"></div>`;
    const q = body.querySelector('#search-q');
    const results = body.querySelector('#search-results');
    const countEl = body.querySelector('#search-count');
    let timer = null;

    function run() {
      const term = q.value.trim();
      results.innerHTML = '';
      if (term.length < 1) { countEl.textContent = '단어를 입력하면 본문에서 찾아요'; return; }
      const lower = text.toLowerCase();
      const t = term.toLowerCase();
      const hits = [];
      let i = lower.indexOf(t);
      while (i !== -1 && hits.length < 300) { hits.push(i); i = lower.indexOf(t, i + t.length); }
      countEl.textContent = hits.length ? `${hits.length}곳 찾음${hits.length >= 300 ? ' (상위 300곳)' : ''}` : '결과가 없어요';
      const frag = document.createDocumentFragment();
      for (const pos of hits) {
        const s = Math.max(0, pos - 18), e = Math.min(text.length, pos + term.length + 34);
        const before = esc(text.slice(s, pos)).replace(/\n/g, ' ');
        const mid = esc(text.slice(pos, pos + term.length));
        const after = esc(text.slice(pos + term.length, e)).replace(/\n/g, ' ');
        const ch = chapterOf(pos);
        const pct = Math.round((pos / text.length) * 100);
        const item = document.createElement('button');
        item.className = 'search-item';
        item.innerHTML = `<div class="search-meta">${ch ? esc(ch) + ' · ' : ''}${pct}%</div><div class="search-snip">${before}<mark>${mid}</mark>${after}</div>`;
        item.onclick = () => { App.closeModal(); toggleMenu(false); goToOffset(pos); flashParaAt(pos); };
        frag.appendChild(item);
      }
      results.appendChild(frag);
    }
    q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 180); });
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
    App.modal('검색', body, [{ label: '닫기' }]);
    setTimeout(() => q.focus(), 60);
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
  let openToken = 0;
  async function open(b) {
    const token = ++openToken;
    book = b;
    await loadOpts();
    await loadHlColor();
    App.showScreen('reader');
    document.getElementById('reader-title').textContent = b.title;
    $page().innerHTML = '<div class="reader-loading">불러오는 중…</div>';

    let loaded;
    try { loaded = await App.loadBookText(b); } catch (e) { loaded = null; }
    if (token !== openToken) return;          // 그새 서재로 나갔으면 중단(멈춤 방지)
    if (!loaded) { App.toast('본문을 불러오지 못했어요'); close(); return; }
    text = loaded.text;

    if (!book.chapters || !book.chapters.length) book.chapters = Chapters.detect(text);
    if (!book.firstOpenedAt) book.firstOpenedAt = Date.now();
    highlightsCache = await DB.byIndex('highlights', 'bookId', book.id);
    bookmarksCache = await DB.byIndex('bookmarks', 'bookId', book.id);
    if (token !== openToken) return;
    buildWindows();

    const startOffset = book.readPosition || 0;
    renderWindow(windowOfOffset(startOffset), startOffset);

    toggleMenu(true);
    setTimeout(() => { if (menuVisible && isActive()) toggleMenu(false); }, 1600);
    if (App.applyKeepAwake) App.applyKeepAwake();
  }

  function close() {
    openToken++; // 진행 중인 open이 있으면 취소
    if (book) { persistPosition(); DB.put('books', book); }
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
    document.getElementById('btn-search').onclick = openSearch;
    document.getElementById('btn-bookmark').onclick = toggleBookmark;
    document.getElementById('btn-reader-settings').onclick = openSettings;
    document.getElementById('btn-highlight-mode').onclick = openColorChooser;
    document.getElementById('page-slider').addEventListener('change', (e) => {
      const off = Math.round((parseInt(e.target.value, 10) / 1000) * text.length);
      goToOffset(clamp(off, 0, text.length - 1));
    });
    document.getElementById('page-slider').addEventListener('input', (e) => {
      const ind = document.querySelector('.page-indicator');
      if (ind) ind.textContent = `${Math.round(parseInt(e.target.value, 10) / 10)}% 읽음`;
    });

    // 길게 눌러 텍스트를 선택하면(안드로이드 기본 선택 메뉴가 떠도) 잠시 후 자동으로 형광펜 적용
    let selTimer = null;
    document.addEventListener('selectionchange', () => {
      if (!isActive()) return;
      clearTimeout(selTimer);
      selTimer = setTimeout(() => { if (hasSelection()) onSelectionHighlight(); }, 450);
    });

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
