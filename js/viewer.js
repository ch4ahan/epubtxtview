/* 뷰어 (읽기 화면).
   - 페이지 넘김(스크롤 아님, 애니메이션 없음): CSS 다단(column)으로 페이지 분할 후 translateX.
   - 자유 터치 영역: 좌표 기반 그리드(가변 경계)로 다음/이전/메뉴 재배정 가능 (기본 U자).
   - 읽기 옵션: 글씨 크기 / 문단 간격 / 여백 / 테마.
   - 이어보기: 페이지 넘길 때마다 '글자 오프셋'으로 실시간 저장 → 강제 종료에도 복원.
   - 형광펜: 모드 켜면 본문 선택 → 색 지정. 문장 기반 앵커로 저장.
   - 목차/완독 처리. */
(function (global) {
  'use strict';

  const HL_COLORS = [
    { id: 'hanji1', label: '쑥색', color: '#cfd6c3' },
    { id: 'hanji2', label: '흙색', color: '#e3d2bf' },
    { id: 'hanji3', label: '쪽빛', color: '#c3d0da' },
    { id: 'hanji4', label: '연지', color: '#e6c9cb' },
  ];

  let book = null;       // 현재 책 메타
  let text = '';         // 전체 본문
  let paras = [];        // [{start, el}] 문단 위치 캐시
  let pageUnit = 0;      // 한 페이지 폭 + 간격
  let totalPages = 0;
  let curPage = 0;
  let hlMode = false;
  let opts = null;       // 읽기 옵션
  let zones = null;      // 터치 영역 설정
  let menuVisible = false;
  let highlightsCache = [];
  let bookmarksCache = [];

  const $page = () => document.getElementById('reader-page');
  const $touch = () => document.getElementById('touch-layer');
  const $menu = () => document.getElementById('reader-menu');

  // ───────── 옵션/영역 기본값 ─────────
  const DEFAULT_OPTS = { fontSize: 20, lineHeight: 1.8, paraGap: 14, margin: 22, theme: 'sepia' };
  // 그리드 경계(0~1). 세로 3행(상단 메뉴띠 / 중간 / 하단), 가로 3열.
  const DEFAULT_ZONES = {
    rows: [0.12, 0.85],   // 상단 띠 끝(0.12), 하단 시작(0.85)
    cols: [0.22, 0.78],   // 좌측 끝, 우측 시작
    // 9칸 역할: 'next' | 'prev' | 'menu'
    // 기본 U자: 상단 띠 전체=menu, 좌/우/하 = next, 가운데 = prev
    cells: [
      'menu', 'menu', 'menu',
      'next', 'prev', 'next',
      'next', 'next', 'next',
    ],
  };

  async function loadOpts() {
    opts = Object.assign({}, DEFAULT_OPTS, await DB.getSetting('readOpts', {}));
    zones = Object.assign({}, DEFAULT_ZONES, await DB.getSetting('touchZones', {}));
    document.body.dataset.theme = opts.theme;
  }
  async function saveOpts() { await DB.setSetting('readOpts', opts); }
  async function saveZones() { await DB.setSetting('touchZones', zones); }

  // ───────── HTML 빌드 (문단 + 형광펜 마크) ─────────
  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderParagraph(rawStart, line, hls) {
    // line: '\n' 제외한 한 문단. hls: 이 문단과 겹치는 형광펜들.
    const pEnd = rawStart + line.length;
    const overlaps = hls
      .filter((h) => h.status === 'linked' && h.end > rawStart && h.start < pEnd)
      .sort((a, b) => a.start - b.start);
    if (overlaps.length === 0) return esc(line);

    let html = '';
    let cursor = rawStart;
    for (const h of overlaps) {
      const s = Math.max(rawStart, h.start);
      const e = Math.min(pEnd, h.end);
      if (s > cursor) html += esc(text.slice(cursor, s));
      const c = (HL_COLORS.find((x) => x.id === h.color) || HL_COLORS[0]).color;
      const noteMark = h.note ? ' data-note="1"' : '';
      html += `<mark class="hl" data-id="${h.id}"${noteMark} style="--hl:${c}">${esc(text.slice(s, e))}</mark>`;
      cursor = e;
    }
    if (cursor < pEnd) html += esc(text.slice(cursor, pEnd));
    return html;
  }

  function buildContent() {
    const lines = text.split('\n');
    let offset = 0;
    let html = '';
    for (const line of lines) {
      const start = offset;
      if (line.trim() === '') {
        html += `<p class="para blank" data-start="${start}"></p>`;
      } else {
        html += `<p class="para" data-start="${start}">${renderParagraph(start, line, highlightsCache)}</p>`;
      }
      offset += line.length + 1; // '\n'
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

  // ───────── 페이지 분할 ─────────
  function layout(keepOffset) {
    const p = $page();
    applyStyleVars();
    p.scrollLeft = 0;
    p.style.transform = 'translateX(0)';

    const colW = p.clientWidth - opts.margin * 2;
    const colH = p.clientHeight - opts.margin * 2;
    const content = p.firstElementChild;
    content.style.columnWidth = colW + 'px';
    content.style.columnGap = (opts.margin * 2) + 'px';
    content.style.height = colH + 'px';
    content.style.width = colW + 'px';

    pageUnit = colW + opts.margin * 2;

    // 레이아웃 강제 계산
    const total = Math.max(1, Math.round(content.scrollWidth / pageUnit));
    totalPages = total;

    // 문단 위치 캐시
    paras = [];
    const contentRect = content.getBoundingClientRect();
    content.querySelectorAll('.para').forEach((el) => {
      const r = el.getBoundingClientRect();
      const left = r.left - contentRect.left;
      paras.push({ start: parseInt(el.dataset.start, 10), left, el });
    });

    if (keepOffset != null) {
      goToOffset(keepOffset, false);
    } else {
      goToPage(curPage, false);
    }
    updateMenu();
  }

  function pageOfOffset(offset) {
    // offset 이상 첫 위치를 포함하는 문단 찾기
    let target = paras[0];
    for (const pr of paras) {
      if (pr.start <= offset) target = pr; else break;
    }
    if (!target) return 0;
    return Math.max(0, Math.min(totalPages - 1, Math.round(target.left / pageUnit)));
  }

  function offsetOfPage(page) {
    // 해당 페이지에 처음 등장하는 문단의 start
    let best = 0;
    for (const pr of paras) {
      const pg = Math.round(pr.left / pageUnit);
      if (pg <= page) best = pr.start; else break;
    }
    return best;
  }

  function goToPage(page, save = true) {
    curPage = Math.max(0, Math.min(totalPages - 1, page));
    const p = $page();
    p.style.transform = `translateX(${-curPage * pageUnit}px)`;
    updateMenu();
    if (save) persistPosition();
    checkFinished();
  }

  function goToOffset(offset, save = true) {
    goToPage(pageOfOffset(offset), save);
  }

  function nextPage() {
    if (curPage >= totalPages - 1) { checkFinished(true); return; }
    goToPage(curPage + 1);
  }
  function prevPage() { goToPage(curPage - 1); }

  // ───────── 이어보기 저장 ─────────
  let saveTimer = null;
  function persistPosition() {
    if (!book) return;
    book.readPosition = offsetOfPage(curPage);
    book.lastReadAt = Date.now();
    book.progress = totalPages > 1 ? Math.round((curPage / (totalPages - 1)) * 100) : 100;
    logToday();
    // 디바운스 없이 즉시 저장하되, 너무 잦은 쓰기는 묶기
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => DB.put('books', book), 120);
  }

  function logToday() {
    const today = new Date().toISOString().slice(0, 10);
    if (book._lastLog === today) return;
    book._lastLog = today;
    const id = book.id + '_' + today;
    DB.put('readlog', { id, bookId: book.id, date: today });
  }

  function checkFinished(forced) {
    if (!book) return;
    const atEnd = curPage >= totalPages - 1;
    if ((atEnd || forced) && !book.finished) {
      book.finished = true;
      book.finishedAt = Date.now();
      book.progress = 100;
      DB.put('books', book);
      App.toast('🎉 완독 처리했어요');
    }
  }

  // ───────── 메뉴 ─────────
  function updateMenu() {
    document.getElementById('page-now').textContent = curPage + 1;
    document.getElementById('page-total').textContent = totalPages;
    const slider = document.getElementById('page-slider');
    slider.max = Math.max(1, totalPages - 1);
    slider.value = curPage;
    const bm = document.getElementById('btn-bookmark');
    if (bm) bm.classList.toggle('active', !!currentPageBookmark());
  }

  // ───────── 북마크 ─────────
  function pageRange() {
    const start = offsetOfPage(curPage);
    const end = curPage + 1 < totalPages ? offsetOfPage(curPage + 1) : text.length + 1;
    return { start, end };
  }
  function currentPageBookmark() {
    const { start, end } = pageRange();
    return bookmarksCache.find((b) => b.position >= start && b.position < end);
  }
  async function toggleBookmark() {
    const existing = currentPageBookmark();
    if (existing) {
      await DB.del('bookmarks', existing.id);
      App.toast('북마크를 뺐어요');
    } else {
      const pos = offsetOfPage(curPage);
      const snippetEnd = Math.min(text.length, pos + 60);
      const bm = {
        id: 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        bookId: book.id,
        position: pos,
        snippet: text.slice(pos, snippetEnd).replace(/\s+/g, ' ').trim(),
        anchor: Highlights.makeAnchor(text, pos, snippetEnd),
        createdAt: Date.now(),
      };
      await DB.put('bookmarks', bm);
      App.toast('🔖 북마크를 더했어요');
    }
    bookmarksCache = await DB.byIndex('bookmarks', 'bookId', book.id);
    updateMenu();
  }

  function toggleMenu(force) {
    menuVisible = force != null ? force : !menuVisible;
    $menu().classList.toggle('hidden', !menuVisible);
  }

  // ───────── 터치 영역 ─────────
  function actionAt(x, y, w, h) {
    const fx = x / w, fy = y / h;
    const col = fx < zones.cols[0] ? 0 : fx < zones.cols[1] ? 1 : 2;
    const row = fy < zones.rows[0] ? 0 : fy < zones.rows[1] ? 1 : 2;
    return zones.cells[row * 3 + col];
  }

  function onTouchTap(e) {
    if (hlMode) return; // 형광펜 모드에선 선택 우선
    const rect = $touch().getBoundingClientRect();
    const x = (e.changedTouches ? e.changedTouches[0].clientX : e.clientX) - rect.left;
    const y = (e.changedTouches ? e.changedTouches[0].clientY : e.clientY) - rect.top;
    const act = actionAt(x, y, rect.width, rect.height);
    if (act === 'next') nextPage();
    else if (act === 'prev') prevPage();
    else if (act === 'menu') toggleMenu();
  }

  // 탭/스와이프 구분
  let downX = 0, downY = 0, downT = 0;
  function bindTouch() {
    const t = $touch();
    const onDown = (e) => {
      const pt = e.changedTouches ? e.changedTouches[0] : e;
      downX = pt.clientX; downY = pt.clientY; downT = Date.now();
    };
    const onUp = (e) => {
      const pt = e.changedTouches ? e.changedTouches[0] : e;
      const dx = pt.clientX - downX, dy = pt.clientY - downY, dt = Date.now() - downT;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
        // 가로 스와이프
        if (dx < 0) nextPage(); else prevPage();
        return;
      }
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
    // node가 속한 .para를 찾아 raw offset 계산
    let el = node.nodeType === 3 ? node.parentNode : node;
    const para = el.closest ? el.closest('.para') : el.parentNode.closest('.para');
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
    const startOff = pointToOffset(r.startContainer, r.startOffset);
    const endOff = pointToOffset(r.endContainer, r.endOffset);
    if (startOff == null || endOff == null) return;
    const s = Math.min(startOff, endOff), eo = Math.max(startOff, endOff);
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
      <textarea class="hl-note" placeholder="메모 (선택)">${existing ? esc(existing.note || '') : ''}</textarea>
    `;
    const colorWrap = body.querySelector('.hl-colors');
    let chosen = existing ? existing.color : HL_COLORS[0].id;
    HL_COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'hl-swatch' + (c.id === chosen ? ' sel' : '');
      b.style.background = c.color;
      b.title = c.label;
      b.onclick = () => {
        chosen = c.id;
        colorWrap.querySelectorAll('.hl-swatch').forEach((x) => x.classList.remove('sel'));
        b.classList.add('sel');
      };
      colorWrap.appendChild(b);
    });

    const buttons = [
      { label: existing ? '저장' : '형광펜 추가', primary: true, onClick: async () => {
        const note = body.querySelector('.hl-note').value.trim();
        if (existing) {
          existing.color = chosen; existing.note = note;
          await DB.put('highlights', existing);
        } else {
          const h = {
            id: Highlights.uid(), bookId: book.id, color: chosen, note,
            anchor: Highlights.makeAnchor(text, start, end),
            start, end, status: 'linked', createdAt: Date.now(),
          };
          await DB.put('highlights', h);
        }
        await reloadHighlights();
        App.toast('형광펜을 저장했어요');
      }},
    ];
    if (existing) {
      buttons.unshift({ label: '삭제', danger: true, onClick: async () => {
        await DB.del('highlights', existing.id);
        await reloadHighlights();
        App.toast('삭제했어요');
      }});
    }
    App.modal(existing ? '형광펜 편집' : '형광펜', body, buttons);
  }

  async function reloadHighlights() {
    highlightsCache = await DB.byIndex('highlights', 'bookId', book.id);
    const off = offsetOfPage(curPage);
    $page().innerHTML = `<div class="reader-content">${buildContent()}</div>`;
    layout(off);
    bindMarkClicks();
  }

  function bindMarkClicks() {
    $page().querySelectorAll('mark.hl').forEach((m) => {
      m.addEventListener('click', (e) => {
        if (!hlMode) return; // 읽기 모드에선 페이지 넘김 방해 안 함
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
      const head = document.createElement('div');
      head.className = 'toc-head';
      head.textContent = '🔖 북마크';
      body.appendChild(head);
      bookmarksCache.slice().sort((a, b) => a.position - b.position).forEach((m) => {
        const b = document.createElement('button');
        b.className = 'toc-item bm';
        b.textContent = m.snippet || '(북마크)';
        b.onclick = () => { goToOffset(m.position); App.closeModal(); toggleMenu(false); };
        body.appendChild(b);
      });
      const head2 = document.createElement('div');
      head2.className = 'toc-head';
      head2.textContent = '목차';
      body.appendChild(head2);
    }

    (book.chapters || []).forEach((ch) => {
      const b = document.createElement('button');
      b.className = 'toc-item';
      b.textContent = ch.title;
      b.onclick = () => { goToOffset(ch.offset); App.closeModal(); toggleMenu(false); };
      body.appendChild(b);
    });
    App.modal('목차 · 북마크', body, [{ label: '닫기' }]);
  }

  // ───────── 읽기 설정 ─────────
  function openSettings() {
    const body = document.createElement('div');
    body.className = 'settings-panel';
    body.innerHTML = `
      <label>글씨 크기 <output>${opts.fontSize}</output>
        <input type="range" min="14" max="34" value="${opts.fontSize}" data-k="fontSize"></label>
      <label>문단 간격 <output>${opts.paraGap}</output>
        <input type="range" min="0" max="40" value="${opts.paraGap}" data-k="paraGap"></label>
      <label>줄 간격 <output>${opts.lineHeight}</output>
        <input type="range" min="1.3" max="2.4" step="0.1" value="${opts.lineHeight}" data-k="lineHeight"></label>
      <label>화면 여백 <output>${opts.margin}</output>
        <input type="range" min="8" max="60" value="${opts.margin}" data-k="margin"></label>
      <div class="theme-row">
        <button data-theme="light">라이트</button>
        <button data-theme="sepia">세피아</button>
        <button data-theme="dark">다크</button>
      </div>
      <button class="link-btn" id="open-zone-editor">터치 영역 설정 (다음/이전/메뉴)</button>
    `;
    body.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k;
        opts[k] = k === 'lineHeight' ? parseFloat(inp.value) : parseInt(inp.value, 10);
        inp.previousElementSibling && (inp.parentNode.querySelector('output').textContent = opts[k]);
        const off = offsetOfPage(curPage);
        layout(off);
        saveOpts();
      });
    });
    body.querySelectorAll('.theme-row button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.theme === opts.theme);
      b.onclick = () => {
        opts.theme = b.dataset.theme;
        document.body.dataset.theme = opts.theme;
        body.querySelectorAll('.theme-row button').forEach((x) => x.classList.toggle('sel', x === b));
        saveOpts();
      };
    });
    body.querySelector('#open-zone-editor').onclick = () => { App.closeModal(); openZoneEditor(); };
    App.modal('읽기 설정', body, [{ label: '닫기' }]);
  }

  function openZoneEditor() {
    const body = document.createElement('div');
    body.className = 'zone-editor';
    body.innerHTML = `
      <p class="muted">각 칸을 눌러 역할을 바꾸세요. 경계 슬라이더로 영역 크기를 조절합니다.</p>
      <div class="zone-grid"></div>
      <label>상단 띠 높이 <input type="range" min="0.05" max="0.3" step="0.01" value="${zones.rows[0]}" data-k="r0"></label>
      <label>하단 영역 시작 <input type="range" min="0.6" max="0.95" step="0.01" value="${zones.rows[1]}" data-k="r1"></label>
      <label>좌측 영역 폭 <input type="range" min="0.1" max="0.45" step="0.01" value="${zones.cols[0]}" data-k="c0"></label>
      <label>우측 영역 시작 <input type="range" min="0.55" max="0.9" step="0.01" value="${zones.cols[1]}" data-k="c1"></label>
      <button class="link-btn" id="zone-reset">기본값(U자)로 되돌리기</button>
    `;
    const grid = body.querySelector('.zone-grid');
    const ROLES = ['next', 'prev', 'menu'];
    const LABEL = { next: '다음', prev: '이전', menu: '메뉴' };
    function paint() {
      grid.innerHTML = '';
      zones.cells.forEach((role, i) => {
        const cell = document.createElement('button');
        cell.className = 'zone-cell role-' + role;
        cell.textContent = LABEL[role];
        cell.onclick = () => {
          const next = ROLES[(ROLES.indexOf(role) + 1) % ROLES.length];
          zones.cells[i] = next;
          saveZones(); paint();
        };
        grid.appendChild(cell);
      });
    }
    paint();
    body.querySelectorAll('input[type=range]').forEach((inp) => {
      inp.addEventListener('input', () => {
        const k = inp.dataset.k, v = parseFloat(inp.value);
        if (k === 'r0') zones.rows[0] = v;
        if (k === 'r1') zones.rows[1] = v;
        if (k === 'c0') zones.cols[0] = v;
        if (k === 'c1') zones.cols[1] = v;
        saveZones();
      });
    });
    body.querySelector('#zone-reset').onclick = () => {
      zones = JSON.parse(JSON.stringify(DEFAULT_ZONES));
      saveZones(); App.closeModal(); openZoneEditor();
    };
    App.modal('터치 영역 설정', body, [{ label: '닫기' }]);
  }

  // ───────── 열기/닫기 ─────────
  async function open(b) {
    book = b;
    await loadOpts();
    App.showScreen('reader');
    document.getElementById('reader-title').textContent = b.title;

    const loaded = await App.loadBookText(b);
    if (!loaded) { App.showScreen('library'); return; }
    text = loaded.text;

    // 목차 갱신(없으면 생성)
    if (!book.chapters || book.chapters.length === 0) {
      book.chapters = Chapters.detect(text);
    }
    // 최초 오픈일 기록
    if (!book.firstOpenedAt) book.firstOpenedAt = Date.now();

    // 형광펜·북마크 로드 + (필요시) 재연결
    highlightsCache = await DB.byIndex('highlights', 'bookId', book.id);
    bookmarksCache = await DB.byIndex('bookmarks', 'bookId', book.id);

    $page().innerHTML = `<div class="reader-content">${buildContent()}</div>`;
    curPage = 0;
    // 약간의 지연 후 레이아웃(폰트 적용 대기)
    requestAnimationFrame(() => {
      layout(book.readPosition || 0);
      bindMarkClicks();
      persistPosition();
    });
  }

  function close() {
    if (book) { persistPosition(); DB.put('books', book); }
    setHlMode(false);
    toggleMenu(false);
    App.showScreen('library');
    if (global.Library) Library.render();
  }

  // ───────── 이벤트 바인딩 ─────────
  function init() {
    bindTouch();
    document.getElementById('btn-reader-back').onclick = close;
    document.getElementById('btn-toc').onclick = openTOC;
    document.getElementById('btn-bookmark').onclick = toggleBookmark;
    document.getElementById('btn-reader-settings').onclick = openSettings;
    document.getElementById('btn-highlight-mode').onclick = () => setHlMode(!hlMode);
    document.getElementById('page-slider').addEventListener('input', (e) => {
      goToPage(parseInt(e.target.value, 10));
    });
    // 선택 종료 시 형광펜 다이얼로그
    document.addEventListener('mouseup', () => { if (hlMode) setTimeout(onSelectionHighlight, 10); });
    $page().addEventListener('touchend', () => { if (hlMode) setTimeout(onSelectionHighlight, 10); });

    // 강제 종료/백그라운드 대비 즉시 저장
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && book) DB.put('books', book);
    });
    window.addEventListener('pagehide', () => { if (book) DB.put('books', book); });

    // 키보드(데스크탑 테스트용)
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('screen-reader').classList.contains('active')) return;
      if (e.key === 'ArrowRight' || e.key === ' ') nextPage();
      if (e.key === 'ArrowLeft') prevPage();
    });

    window.addEventListener('resize', () => {
      if (document.getElementById('screen-reader').classList.contains('active') && book) {
        const off = offsetOfPage(curPage);
        layout(off);
      }
    });
  }

  global.Viewer = { init, open, close, HL_COLORS };
})(window);
