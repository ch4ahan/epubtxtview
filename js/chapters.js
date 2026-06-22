/* 목차 자동 인식.
   "○○화", "제 N 화", "프롤로그", "에필로그", "외전", "N장" 등의 패턴을
   줄 단위로 찾아 챕터 목록을 만든다. 각 챕터는 본문 내 글자 오프셋을 가진다. */
(function (global) {
  'use strict';

  // 한 줄이 "챕터 제목"으로 보이는지 판정하는 정규식들
  const PATTERNS = [
    /^\s*(프롤로그|에필로그|서장|종장|작가\s*후기|외전)\b/,
    /^\s*제?\s*\d{1,4}\s*화\b/,            // 제 12 화 / 12화
    /^\s*\d{1,4}\s*화[\s.).:-]/,           // 12화. / 12화)
    /^\s*제?\s*\d{1,4}\s*장\b/,            // 제 3 장 / 3장
    /^\s*Chapter\s*\d{1,4}\b/i,
    /^\s*#+\s*\S/,                         // 마크다운식 헤더
    /^\s*\d{1,4}\s*[.．]\s*\S/,            // 1. 제목
  ];

  function looksLikeHeading(line) {
    const t = line.trim();
    if (!t) return false;
    if (t.length > 40) return false; // 너무 긴 줄은 제목 아님
    return PATTERNS.some((re) => re.test(t));
  }

  /**
   * text 전체를 받아 챕터 배열 반환.
   * 반환: [{ title, offset }]  (offset = 본문 시작 글자 인덱스)
   */
  function detect(text) {
    const chapters = [];
    let pos = 0;
    const lines = text.split('\n');
    for (const line of lines) {
      if (looksLikeHeading(line)) {
        chapters.push({ title: line.trim().slice(0, 40), offset: pos });
      }
      pos += line.length + 1; // +1 = '\n'
    }
    // 챕터가 하나도 없으면 글 전체를 단일 챕터로
    if (chapters.length === 0) {
      chapters.push({ title: '본문', offset: 0 });
    } else if (chapters[0].offset > 0) {
      // 첫 챕터 이전 도입부가 있으면 "시작" 챕터 추가
      chapters.unshift({ title: '시작', offset: 0 });
    }
    return chapters;
  }

  global.Chapters = { detect, looksLikeHeading };
})(window);
