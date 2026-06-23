/* 앱 셸: 화면 전환, 모달/토스트/입력, 파일 선택·읽기, 초기화. */
(function (global) {
  'use strict';

  // ───────── 화면 전환 (+ 뒤로가기 히스토리) ─────────
  let popHandling = false;
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
    // 안드로이드 하드웨어 뒤로가기로 서재까지 돌아올 수 있게 히스토리 스택을 쌓는다
    if (!popHandling && name !== 'library') {
      history.pushState({ screen: name }, '');
    }
  }

  // ───────── 토스트 ─────────
  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 2400);
  }

  // ───────── 모달 ─────────
  function closeModal() {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
    root.classList.remove('open');
  }

  function modal(title, bodyEl, buttons) {
    const root = document.getElementById('modal-root');
    root.innerHTML = '';
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.onclick = (e) => { if (e.target === back) closeModal(); };
    const box = document.createElement('div');
    box.className = 'modal-box';
    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = title;
    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'modal-body';
    if (typeof bodyEl === 'string') bodyWrap.innerHTML = bodyEl;
    else bodyWrap.appendChild(bodyEl);
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    (buttons || [{ label: '닫기' }]).forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'modal-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      btn.textContent = b.label;
      btn.onclick = async () => {
        if (b.onClick) { const keep = await b.onClick(); if (keep === true) return; }
        closeModal();
      };
      foot.appendChild(btn);
    });
    box.appendChild(h); box.appendChild(bodyWrap); box.appendChild(foot);
    back.appendChild(box);
    root.appendChild(back);
    root.classList.add('open');
  }

  function confirm(title, message) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      body.className = 'modal-message';
      body.textContent = message;
      modal(title, body, [
        { label: '취소', onClick: () => resolve(false) },
        { label: '확인', primary: true, onClick: () => resolve(true) },
      ]);
    });
  }

  function prompt(title, initial) {
    return new Promise((resolve) => {
      const body = document.createElement('div');
      const input = document.createElement('input');
      input.className = 'prompt-input';
      input.value = initial || '';
      body.appendChild(input);
      modal(title, body, [
        { label: '취소', onClick: () => resolve(null) },
        { label: '확인', primary: true, onClick: () => resolve(input.value) },
      ]);
      setTimeout(() => { input.focus(); input.select(); }, 50);
    });
  }

  // ───────── 파일 선택 (핸들 우선, 폴백은 input) ─────────
  let pendingTextCb = null;
  async function pickText(cb) {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'TXT', accept: { 'text/plain': ['.txt'] } }],
          multiple: false,
        });
        const file = await handle.getFile();
        cb(file, handle);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 사용자가 취소
        // 그 외엔 input 폴백
      }
    }
    pendingTextCb = cb;
    document.getElementById('file-input-txt').click();
  }

  // 책 본문 텍스트 로드: 전용 저장소(texts) → (구버전)cachedText 이관 → 핸들 → 없으면 null
  async function loadBookText(book) {
    const row = await DB.get('texts', book.id);
    if (row && row.text) return { text: row.text, source: 'store' };

    // 구버전 데이터(cachedText)를 texts 저장소로 1회 이관
    if (book.cachedText) {
      const t = book.cachedText;
      await DB.put('texts', { bookId: book.id, text: t });
      delete book.cachedText; book.hasText = true; book.needsRelink = false;
      await DB.put('books', book);
      return { text: t, source: 'migrated' };
    }

    // 데스크톱 파일 핸들(있으면) → 읽어서 저장소에 보관
    if (book.fileHandle) {
      try {
        const perm = await ensurePermission(book.fileHandle);
        if (perm) {
          const file = await book.fileHandle.getFile();
          const { text } = Encoding.decode(await file.arrayBuffer());
          await DB.put('texts', { bookId: book.id, text });
          book.hasText = true; book.needsRelink = false; await DB.put('books', book);
          return { text, source: 'handle' };
        }
      } catch (e) { /* 무효 → 재연결 */ }
    }

    book.needsRelink = true;
    await DB.put('books', book);
    return null;
  }

  // 본문 저장(한 번만). 책 추가/재연결 시 호출.
  async function saveBookText(bookId, text) {
    await DB.put('texts', { bookId, text });
  }

  async function ensurePermission(handle) {
    if (!handle.queryPermission) return true;
    const opts = { mode: 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  // ───────── 화면 깨우기(꺼짐 방지) ─────────
  let wakeLock = null;
  async function applyKeepAwake() {
    const on = await DB.getSetting('keepAwake', false);
    try {
      if (on && 'wakeLock' in navigator) {
        if (!wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      } else if (wakeLock) { await wakeLock.release(); wakeLock = null; }
    } catch (e) { /* 미지원/거부 무시 */ }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyKeepAwake();
    else wakeLock = null; // 백그라운드 가면 자동 해제됨
  });

  // ───────── 뒤로가기 ─────────
  function isLibraryActive() { return document.getElementById('screen-library').classList.contains('active'); }
  function handleBack() {
    popHandling = true;
    if (Viewer.isActive()) Viewer.close();
    else if (!isLibraryActive()) { showScreen('library'); Library.render(); }
    popHandling = false;
  }
  function setupHardwareBack() {
    const Cap = window.Capacitor;
    if (Cap && Cap.Plugins && Cap.Plugins.App) {
      Cap.Plugins.App.addListener('backButton', () => {
        if (!isLibraryActive()) handleBack();
        else if (Cap.Plugins.App.exitApp) Cap.Plugins.App.exitApp();
      });
    }
    window.addEventListener('popstate', handleBack); // 웹 브라우저용
  }

  // ───────── 파일 매니저에서 '책갈피로 열기' (실험적) ─────────
  async function setupFileOpen() {
    const Cap = window.Capacitor;
    if (!Cap || !Cap.Plugins || !Cap.Plugins.App) return;
    const App = Cap.Plugins.App;
    try {
      const launch = await App.getLaunchUrl();
      if (launch && launch.url) importFromUri(launch.url);
    } catch (e) { /* 무시 */ }
    App.addListener('appUrlOpen', (data) => { if (data && data.url) importFromUri(data.url); });
  }
  async function importFromUri(uri) {
    const Cap = window.Capacitor;
    const FS = Cap && Cap.Plugins && Cap.Plugins.Filesystem;
    if (!FS) return;
    try {
      const res = await FS.readFile({ path: uri }); // base64
      const bin = atob(res.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const { text } = Encoding.decode(bytes.buffer);
      let name = decodeURIComponent(uri.split('/').pop() || '가져온 소설').replace(/\.txt$/i, '');
      await Library.addBookFromText(name, text);
      toast(`"${name}"을(를) 가져왔어요`);
    } catch (e) { toast('파일을 여는 데 실패했어요'); }
  }

  // ───────── 앱 설정 (메인 상단 '책갈피' 탭) ─────────
  async function openAppSettings() {
    const keepAwake = await DB.getSetting('keepAwake', false);
    const viewMode = await DB.getSetting('viewMode', 'grid');
    const theme = document.body.dataset.theme;
    const body = document.createElement('div');
    body.className = 'settings-panel';
    body.innerHTML = `
      <label class="switch-row">화면 꺼짐 방지
        <input type="checkbox" id="set-awake" ${keepAwake ? 'checked' : ''}></label>
      <div class="set-label">서재 보기</div>
      <div class="theme-row" id="set-view">
        <button data-v="grid">서재형</button>
        <button data-v="gallery">갤러리형</button>
        <button data-v="list">목록형</button>
      </div>
      <div class="set-label">테마</div>
      <div class="theme-row" id="set-theme">
        <button data-theme="light">라이트</button>
        <button data-theme="sepia">세피아</button>
        <button data-theme="dark">다크</button>
      </div>
      <p class="muted" style="margin-top:14px">글씨 크기·문단 간격·여백·터치 영역은 책을 펼친 뒤 ⚙(읽기 설정)에서 바꿀 수 있어요.</p>`;
    body.querySelector('#set-awake').onchange = async (e) => { await DB.setSetting('keepAwake', e.target.checked); applyKeepAwake(); };
    body.querySelectorAll('#set-view button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.v === viewMode);
      b.onclick = async () => { await DB.setSetting('viewMode', b.dataset.v); body.querySelectorAll('#set-view button').forEach((x) => x.classList.toggle('sel', x === b)); Library.setViewMode(b.dataset.v); };
    });
    body.querySelectorAll('#set-theme button').forEach((b) => {
      b.classList.toggle('sel', b.dataset.theme === theme);
      b.onclick = async () => {
        document.body.dataset.theme = b.dataset.theme;
        const opts = await DB.getSetting('readOpts', {}); opts.theme = b.dataset.theme; await DB.setSetting('readOpts', opts);
        body.querySelectorAll('#set-theme button').forEach((x) => x.classList.toggle('sel', x === b));
      };
    });
    modal('설정', body, [{ label: '닫기' }]);
  }

  // ───────── 초기화 ─────────
  async function init() {
    const savedOpts = await DB.getSetting('readOpts', null);
    document.body.dataset.theme = (savedOpts && savedOpts.theme)
      ? savedOpts.theme
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

    history.replaceState({ screen: 'library' }, '');
    setupHardwareBack();

    await Library.loadPrefs();
    Library.init();
    Viewer.init();
    Excerpts.init();

    document.getElementById('file-input-txt').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file && pendingTextCb) { const cb = pendingTextCb; pendingTextCb = null; cb(file, null); }
    });

    document.getElementById('file-input-json').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const res = await Backup.importAll(file);
        await Library.render();
        toast(`복원 완료 · 책 ${res.bookCount}권, 형광펜 ${res.highlights}개 (본문 재연결 필요)`);
      } catch (err) { toast('불러오기 실패: ' + err.message); }
    });

    // 메인 상단 '책갈피' 누르면 설정
    const brand = document.querySelector('#screen-library .brand');
    if (brand) { brand.style.cursor = 'pointer'; brand.onclick = openAppSettings; }

    await Library.render();
    showScreen('library');
    applyKeepAwake();
    setupFileOpen();

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  global.App = { showScreen, toast, modal, closeModal, confirm, prompt, pickText, loadBookText, saveBookText, applyKeepAwake, openAppSettings };
  document.addEventListener('DOMContentLoaded', init);
})(window);
