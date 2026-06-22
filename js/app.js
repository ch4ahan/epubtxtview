/* 앱 셸: 화면 전환, 모달/토스트/입력, 파일 선택·읽기, 초기화. */
(function (global) {
  'use strict';

  // ───────── 화면 전환 ─────────
  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('screen-' + name).classList.add('active');
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

  // 책 본문 텍스트 로드: 핸들 → 캐시 → 없으면 null
  async function loadBookText(book) {
    if (book.fileHandle) {
      try {
        const perm = await ensurePermission(book.fileHandle);
        if (perm) {
          const file = await book.fileHandle.getFile();
          const buf = await file.arrayBuffer();
          const { text } = Encoding.decode(buf);
          return { text, source: 'handle' };
        }
      } catch (e) { /* 핸들 무효 → 폴백/재연결 */ }
    }
    if (book.cachedText) return { text: book.cachedText, source: 'cache' };
    // 본문 없음 → 재연결 필요
    book.needsRelink = true;
    await DB.put('books', book);
    toast('본문 파일을 다시 연결해야 해요');
    return null;
  }

  async function ensurePermission(handle) {
    if (!handle.queryPermission) return true;
    const opts = { mode: 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  // ───────── 초기화 ─────────
  async function init() {
    await Library.loadPrefs();
    Library.init();
    Viewer.init();
    Excerpts.init();

    // TXT input 폴백 핸들러
    document.getElementById('file-input-txt').addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file && pendingTextCb) { const cb = pendingTextCb; pendingTextCb = null; cb(file, null); }
    });

    // JSON 백업 불러오기
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

    await Library.render();
    showScreen('library');

    // 서비스워커 (오프라인)
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  global.App = { showScreen, toast, modal, closeModal, confirm, prompt, pickText, loadBookText };
  document.addEventListener('DOMContentLoaded', init);
})(window);
