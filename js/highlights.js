/* 형광펜·메모의 "문장 기반" 위치 저장 & 재연결.

   핵심: 형광펜을 "몇 번째 글자"가 아니라 "그 문장 자체 + 앞뒤 일부"로 저장한다.
   그래서 같은 작품의 더 긴 업데이트 파일(예: 1~99화 → 1~163화)로 갈아끼워도
   안 바뀐 구간이면 본문에서 다시 검색해 자동으로 제자리에 붙는다.

   못 찾으면 절대 삭제하지 않고 status='unlinked' (미연결 보관함)로 보존한다. */
(function (global) {
  'use strict';

  const CONTEXT = 24; // 앞뒤 문맥 글자 수

  function uid() {
    return 'h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // 비교용 정규화: 공백 축약 (검색 견고성)
  function norm(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * 선택 구간으로부터 앵커 생성.
   * text: 전체 본문, start/end: 글자 오프셋
   */
  function makeAnchor(text, start, end) {
    const quote = text.slice(start, end);
    const prefix = text.slice(Math.max(0, start - CONTEXT), start);
    const suffix = text.slice(end, Math.min(text.length, end + CONTEXT));
    return { quote, prefix, suffix };
  }

  /**
   * 본문에서 앵커 위치를 다시 찾는다.
   * 반환: { start, end } 또는 null
   * 전략:
   *  1) prefix+quote+suffix 정확 일치
   *  2) prefix+quote 일치
   *  3) quote+suffix 일치
   *  4) quote 가 유일하게 1번만 등장하면 그 위치
   */
  function locate(text, anchor) {
    const { quote, prefix, suffix } = anchor;
    if (!quote) return null;

    // 1) 전체 문맥
    let full = prefix + quote + suffix;
    let idx = text.indexOf(full);
    if (idx !== -1) return { start: idx + prefix.length, end: idx + prefix.length + quote.length };

    // 2) prefix + quote
    if (prefix) {
      idx = text.indexOf(prefix + quote);
      if (idx !== -1) return { start: idx + prefix.length, end: idx + prefix.length + quote.length };
    }

    // 3) quote + suffix
    if (suffix) {
      idx = text.indexOf(quote + suffix);
      if (idx !== -1) return { start: idx, end: idx + quote.length };
    }

    // 4) quote 유일 등장
    idx = text.indexOf(quote);
    if (idx !== -1 && text.indexOf(quote, idx + 1) === -1) {
      return { start: idx, end: idx + quote.length };
    }

    // 5) 공백 정규화 후 유일 등장 (관대한 최후 시도)
    const nq = norm(quote);
    if (nq && nq.length >= 6) {
      const nText = norm(text);
      const ni = nText.indexOf(nq);
      if (ni !== -1 && nText.indexOf(nq, ni + 1) === -1) {
        // 정규화 좌표는 원본과 어긋날 수 있어 근사 위치만 제공
        const approx = Math.min(text.length, ni);
        return { start: approx, end: Math.min(text.length, approx + quote.length), approx: true };
      }
    }

    return null;
  }

  /**
   * 책의 모든 형광펜을 새 본문에 재연결.
   * 반환: { linked, needCheck, total }
   */
  async function relinkAll(bookId, text) {
    const list = await DB.byIndex('highlights', 'bookId', bookId);
    let linked = 0, needCheck = 0;
    for (const h of list) {
      const found = locate(text, h.anchor);
      if (found && !found.approx) {
        h.start = found.start;
        h.end = found.end;
        h.status = 'linked';
        linked++;
      } else if (found && found.approx) {
        h.start = found.start;
        h.end = found.end;
        h.status = 'linked';
        h.approx = true;
        linked++;
      } else {
        h.status = 'unlinked'; // 미연결 보관함으로
        needCheck++;
      }
      await DB.put('highlights', h);
    }
    return { linked, needCheck, total: list.length };
  }

  global.Highlights = { uid, makeAnchor, locate, relinkAll, norm };
})(window);
