/* 인코딩 자동 처리.
   한국 웹소설 TXT는 EUC-KR(CP949)이 많다.
   UTF-8로 먼저 디코딩하고, 깨짐(U+FFFD `�`)이 많으면 EUC-KR로 재해석한다.
   사용자에게 인코딩을 묻지 않는다. */
(function (global) {
  'use strict';

  function countReplacementChars(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 0xfffd) n++;
    return n;
  }

  function decode(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    // BOM 검사
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    }

    // 1) UTF-8 시도 (fatal: false → 깨지면 U+FFFD)
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const bad = countReplacementChars(utf8);

    // 깨진 글자가 거의 없으면 UTF-8 확정
    const ratio = bad / Math.max(1, utf8.length);
    if (bad === 0 || ratio < 0.0005) {
      return { text: utf8, encoding: 'utf-8' };
    }

    // 2) EUC-KR(CP949) 재해석
    try {
      const euckr = new TextDecoder('euc-kr').decode(bytes);
      const euckrBad = countReplacementChars(euckr);
      // EUC-KR 쪽 깨짐이 더 적으면 EUC-KR 채택
      if (euckrBad <= bad) return { text: euckr, encoding: 'euc-kr' };
    } catch (e) {
      // 일부 브라우저에서 euc-kr 라벨 미지원 시 cp949 시도
      try {
        const cp949 = new TextDecoder('cp949').decode(bytes);
        return { text: cp949, encoding: 'cp949' };
      } catch (_) { /* 무시 */ }
    }

    return { text: utf8, encoding: 'utf-8' };
  }

  global.Encoding = { decode };
})(window);
