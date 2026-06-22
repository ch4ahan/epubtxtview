/* 형광펜·메모 모아보기 + 기록 카드 이미지 추출.
   - 연결됨 / 미연결 보관함 탭.
   - 발췌별로 카드(PNG) 추출, 또는 한 권 전체를 모아 카드로. */
(function (global) {
  'use strict';

  let curBook = null;
  let tab = 'linked';

  async function open(book) {
    curBook = book;
    App.showScreen('excerpts');
    document.getElementById('excerpts-title').textContent = '형광펜 · 메모 — ' + book.title;
    document.querySelectorAll('.excerpt-tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.tab === tab));
    render();
  }

  async function render() {
    const wrap = document.getElementById('excerpt-list');
    wrap.innerHTML = '';

    if (tab === 'bookmarks') { return renderBookmarks(wrap); }

    const all = await DB.byIndex('highlights', 'bookId', curBook.id);
    const list = all.filter((h) => (tab === 'unlinked' ? h.status === 'unlinked' : h.status !== 'unlinked'));

    if (list.length === 0) {
      wrap.innerHTML = `<div class="empty-state"><p class="muted">${tab === 'unlinked' ? '미연결 발췌가 없어요.' : '아직 형광펜이 없어요.'}</p></div>`;
      return;
    }

    if (tab === 'linked') {
      const bar = document.createElement('div');
      bar.className = 'excerpt-actions';
      bar.innerHTML = `<button class="primary-btn" id="card-all">전체를 카드로 모아 보기</button>`;
      bar.querySelector('#card-all').onclick = () => makeCard(list, true);
      wrap.appendChild(bar);
    }

    for (const h of list) {
      const color = (Viewer.HL_COLORS.find((c) => c.id === h.color) || Viewer.HL_COLORS[0]).color;
      const card = document.createElement('div');
      card.className = 'excerpt-card';
      card.innerHTML = `
        <div class="excerpt-quote" style="border-color:${color}">
          <span class="hl-dot" style="background:${color}"></span>
          ${escapeHtml((h.anchor && h.anchor.quote) || '')}
        </div>
        ${h.note ? `<div class="excerpt-note">${escapeHtml(h.note)}</div>` : ''}
        <div class="excerpt-meta muted">
          <span>${new Date(h.createdAt).toLocaleDateString('ko-KR')}</span>
          <span class="excerpt-buttons">
            ${tab === 'unlinked' ? '<button class="link-btn relink-one">재연결 시도</button>' : ''}
            <button class="link-btn card-one">카드로</button>
            <button class="link-btn del-one">삭제</button>
          </span>
        </div>`;
      card.querySelector('.card-one').onclick = () => makeCard([h], false);
      card.querySelector('.del-one').onclick = async () => {
        if (await App.confirm('삭제', '이 형광펜을 삭제할까요?')) { await DB.del('highlights', h.id); render(); }
      };
      const relinkBtn = card.querySelector('.relink-one');
      if (relinkBtn) relinkBtn.onclick = async () => {
        const loaded = await App.loadBookText(curBook);
        if (!loaded) return;
        const found = Highlights.locate(loaded.text, h.anchor);
        if (found) { h.start = found.start; h.end = found.end; h.status = 'linked'; await DB.put('highlights', h); App.toast('재연결됐어요'); render(); }
        else App.toast('본문에서 찾지 못했어요');
      };
      wrap.appendChild(card);
    }
  }

  async function renderBookmarks(wrap) {
    const list = (await DB.byIndex('bookmarks', 'bookId', curBook.id)).sort((a, b) => a.position - b.position);
    if (list.length === 0) {
      wrap.innerHTML = '<div class="empty-state"><p class="muted">아직 북마크가 없어요.</p></div>';
      return;
    }
    for (const m of list) {
      const card = document.createElement('div');
      card.className = 'excerpt-card';
      card.innerHTML = `
        <div class="excerpt-quote" style="border-color:var(--accent)">🔖 ${escapeHtml(m.snippet || '')}</div>
        <div class="excerpt-meta muted">
          <span>${new Date(m.createdAt).toLocaleDateString('ko-KR')}</span>
          <span class="excerpt-buttons">
            <button class="link-btn card-one">카드로</button>
            <button class="link-btn del-one">삭제</button>
          </span>
        </div>`;
      card.querySelector('.card-one').onclick = async () => {
        const blob = await Cards.render({ title: curBook.title, date: true, quote: m.snippet || '', note: '', palette: 'paper' });
        Cards.download(blob, `북마크_${curBook.title}_${Date.now()}.png`);
        App.toast('카드를 저장했어요');
      };
      card.querySelector('.del-one').onclick = async () => {
        if (await App.confirm('삭제', '이 북마크를 삭제할까요?')) { await DB.del('bookmarks', m.id); render(); }
      };
      wrap.appendChild(card);
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  async function makeCard(highlights, combined) {
    // 카드 옵션 (작품명/날짜/톤)
    const body = document.createElement('div');
    body.className = 'card-options';
    body.innerHTML = `
      <label><input type="checkbox" id="cap-title" checked> 작품명 캡션</label>
      <label><input type="checkbox" id="cap-date" checked> 날짜 캡션</label>
      <div class="theme-row">
        <button data-pal="paper" class="sel">한지(밝게)</button>
        <button data-pal="night">먹빛(어둡게)</button>
      </div>`;
    let pal = 'paper';
    body.querySelectorAll('.theme-row button').forEach((b) => b.onclick = () => {
      pal = b.dataset.pal;
      body.querySelectorAll('.theme-row button').forEach((x) => x.classList.toggle('sel', x === b));
    });

    App.modal('기록 카드 만들기', body, [
      { label: '취소' },
      { label: '저장(PNG)', primary: true, onClick: async () => {
        const withTitle = body.querySelector('#cap-title').checked;
        const withDate = body.querySelector('#cap-date').checked;
        const quote = combined
          ? highlights.map((h) => '“' + ((h.anchor && h.anchor.quote) || '') + '”' + (h.note ? '\n— ' + h.note : '')).join('\n\n')
          : (highlights[0].anchor && highlights[0].anchor.quote) || '';
        const note = combined ? '' : (highlights[0].note || '');
        const blob = await Cards.render({
          title: withTitle ? curBook.title : '',
          date: withDate,
          quote: combined ? quote.replace(/^“|”$/g, '') : quote,
          note,
          palette: pal,
        });
        Cards.download(blob, `기록카드_${curBook.title}_${Date.now()}.png`);
        App.toast('카드를 저장했어요');
      }},
    ]);
  }

  function init() {
    document.getElementById('btn-excerpts-back').onclick = () => { App.showScreen('library'); Library.render(); };
    document.querySelectorAll('.excerpt-tabs .tab').forEach((t) => t.onclick = () => {
      tab = t.dataset.tab;
      document.querySelectorAll('.excerpt-tabs .tab').forEach((x) => x.classList.toggle('active', x === t));
      render();
    });
  }

  global.Excerpts = { init, open };
})(window);
