/* 형광펜·북마크 발췌 → 세로형 기록 카드 이미지(PNG).
   SNS용이 아니라 개인 데일리 로그/리뷰용 → 차분한 편집형 톤.
   잡지 인용구 같은 레이아웃: 발췌 본문이 주인공, 작품명·날짜는 작은 캡션. */
(function (global) {
  'use strict';

  const PALETTES = {
    paper: { bg: '#f4f1ea', fg: '#2c2722', sub: '#9a9082', rule: '#d8d2c6', accent: '#8c7b66' },
    night: { bg: '#22201d', fg: '#ece6da', sub: '#8c857a', rule: '#3a362f', accent: '#c9b79c' },
  };

  function wrapText(ctx, txt, maxWidth) {
    const lines = [];
    for (const para of txt.split('\n')) {
      if (para.trim() === '') { lines.push(''); continue; }
      let line = '';
      for (const ch of para) {
        const test = line + ch;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = ch;
        } else line = test;
      }
      lines.push(line);
    }
    return lines;
  }

  /**
   * options: { title, date(boolean|string), quote, note, palette }
   * 반환: Promise<Blob>
   */
  function render(options) {
    const pal = PALETTES[options.palette || 'paper'];
    const W = 1080;
    const PAD = 90;
    const maxW = W - PAD * 2;

    const measure = document.createElement('canvas').getContext('2d');
    const quoteFont = '300 46px "Noto Serif KR", serif';
    const noteFont = '400 30px "Noto Sans KR", sans-serif';
    const capFont = '500 26px "Noto Sans KR", sans-serif';

    measure.font = quoteFont;
    const quoteLines = wrapText(measure, '“' + options.quote + '”', maxW);
    measure.font = noteFont;
    const noteLines = options.note ? wrapText(measure, options.note, maxW) : [];

    const quoteLH = 70, noteLH = 48;
    let H = PAD;
    H += 60;                      // 상단 장식
    H += quoteLines.length * quoteLH;
    if (noteLines.length) H += 40 + noteLines.length * noteLH;
    H += 60;                      // 캡션 영역
    H += PAD;
    H = Math.max(H, 720);

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');

    // 배경
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, W, H);

    // 상단 가는 선 + 인용 부호 느낌의 악센트
    ctx.fillStyle = pal.accent;
    ctx.fillRect(PAD, PAD, 64, 5);

    let y = PAD + 60;
    ctx.fillStyle = pal.fg;
    ctx.font = quoteFont;
    ctx.textBaseline = 'top';
    for (const ln of quoteLines) { ctx.fillText(ln, PAD, y); y += quoteLH; }

    if (noteLines.length) {
      y += 24;
      ctx.strokeStyle = pal.rule;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(PAD + 80, y); ctx.stroke();
      y += 24;
      ctx.fillStyle = pal.sub;
      ctx.font = noteFont;
      for (const ln of noteLines) { ctx.fillText(ln, PAD, y); y += noteLH; }
    }

    // 캡션 (작품명 · 날짜)
    y = H - PAD - 8;
    ctx.fillStyle = pal.sub;
    ctx.font = capFont;
    const caps = [];
    if (options.title) caps.push(options.title);
    if (options.date) caps.push(typeof options.date === 'string' ? options.date : new Date().toLocaleDateString('ko-KR'));
    if (caps.length) {
      ctx.strokeStyle = pal.rule;
      ctx.beginPath(); ctx.moveTo(PAD, y - 26); ctx.lineTo(W - PAD, y - 26); ctx.stroke();
      ctx.fillText(caps.join('   ·   '), PAD, y);
    }

    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  global.Cards = { render, download, PALETTES };
})(window);
