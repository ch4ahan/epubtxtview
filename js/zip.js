/* 의존성 없는 최소 ZIP 작성기 (STORE 방식, 압축 없음).
   EPUB은 정해진 구조의 ZIP이므로 이 정도면 충분하다.
   mimetype 파일은 반드시 압축 없이 맨 앞에 와야 하는데, 전부 STORE이므로 자연히 만족. */
(function (global) {
  'use strict';

  // CRC32 테이블
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function toBytes(data) {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error('지원하지 않는 데이터 형식');
  }

  // DOS 날짜/시간 (현재 시각)
  function dosDateTime() {
    const d = new Date();
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time, date };
  }

  /**
   * files: [{ name: 'mimetype', data: string|Uint8Array }]
   * 반환: Blob (application/epub+zip 등은 호출측에서 지정)
   */
  function createZip(files, mimeType) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, date } = dosDateTime();

    function pushLE(arr, val, bytes) {
      for (let i = 0; i < bytes; i++) arr.push((val >>> (i * 8)) & 0xff);
    }

    for (const f of files) {
      const nameBytes = new TextEncoder().encode(f.name);
      const dataBytes = toBytes(f.data);
      const crc = crc32(dataBytes);

      // Local file header
      const local = [];
      pushLE(local, 0x04034b50, 4); // signature
      pushLE(local, 20, 2);         // version needed
      pushLE(local, 0, 2);          // flags
      pushLE(local, 0, 2);          // method = 0 (store)
      pushLE(local, time, 2);
      pushLE(local, date, 2);
      pushLE(local, crc, 4);
      pushLE(local, dataBytes.length, 4); // compressed size
      pushLE(local, dataBytes.length, 4); // uncompressed size
      pushLE(local, nameBytes.length, 2);
      pushLE(local, 0, 2);          // extra length
      const localHeader = new Uint8Array(local);

      const localOffset = offset;
      chunks.push(localHeader, nameBytes, dataBytes);
      offset += localHeader.length + nameBytes.length + dataBytes.length;

      // Central directory record
      const cd = [];
      pushLE(cd, 0x02014b50, 4);
      pushLE(cd, 20, 2); // version made by
      pushLE(cd, 20, 2); // version needed
      pushLE(cd, 0, 2);  // flags
      pushLE(cd, 0, 2);  // method
      pushLE(cd, time, 2);
      pushLE(cd, date, 2);
      pushLE(cd, crc, 4);
      pushLE(cd, dataBytes.length, 4);
      pushLE(cd, dataBytes.length, 4);
      pushLE(cd, nameBytes.length, 2);
      pushLE(cd, 0, 2); // extra
      pushLE(cd, 0, 2); // comment
      pushLE(cd, 0, 2); // disk number
      pushLE(cd, 0, 2); // internal attrs
      pushLE(cd, 0, 4); // external attrs
      pushLE(cd, localOffset, 4);
      central.push(new Uint8Array(cd), nameBytes);
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      chunks.push(c);
      cdSize += c.length;
    }
    offset += cdSize;

    // End of central directory
    const eocd = [];
    pushLE(eocd, 0x06054b50, 4);
    pushLE(eocd, 0, 2); // disk
    pushLE(eocd, 0, 2); // cd disk
    pushLE(eocd, files.length, 2);
    pushLE(eocd, files.length, 2);
    pushLE(eocd, cdSize, 4);
    pushLE(eocd, cdStart, 4);
    pushLE(eocd, 0, 2); // comment len
    chunks.push(new Uint8Array(eocd));

    return new Blob(chunks, { type: mimeType || 'application/zip' });
  }

  global.MiniZip = { createZip, crc32 };
})(window);
