/* TXT → EPUB 내보내기.
   EPUB은 정해진 구조의 ZIP. MiniZip(STORE)으로 조립한다.
   - "○○화" 패턴으로 챕터 분리 → 목차(nav + ncx) 생성.
   - 표지가 있으면 cover 이미지 포함. 없으면 표지 없이도 변환.
   "다른 리더기에서도 보게 깔끔한 사본을 뽑는 내보내기" 기능. */
(function (global) {
  'use strict';

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function paragraphsToHtml(block) {
    return block.split('\n')
      .map((l) => l.trim() ? `<p>${esc(l)}</p>` : '<p class="blank">&#160;</p>')
      .join('\n');
  }

  /**
   * book: { title, author? }, text, chapters([{title, offset}]), coverBlob?
   * 반환: Promise<Blob> (application/epub+zip)
   */
  async function build(book, text, chapters) {
    const id = uuid();
    const title = book.title || '제목 없음';
    const author = book.author || '미상';
    const files = [];

    // mimetype (반드시 STORE & 첫 항목)
    files.push({ name: 'mimetype', data: 'application/epub+zip' });

    files.push({ name: 'META-INF/container.xml', data:
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>` });

    files.push({ name: 'OEBPS/style.css', data:
`body { margin: 5% 6%; line-height: 1.7; font-family: serif; }
h1 { font-size: 1.3em; margin: 1.4em 0 0.8em; }
p { margin: 0 0 0.7em; text-indent: 0; }
p.blank { margin: 0.4em 0; }` });

    // 챕터 분리
    const chs = (chapters && chapters.length) ? chapters : [{ title: '본문', offset: 0 }];
    const manifestItems = [];
    const spineItems = [];
    const navPoints = [];

    for (let i = 0; i < chs.length; i++) {
      const start = chs[i].offset;
      const end = i + 1 < chs.length ? chs[i + 1].offset : text.length;
      const block = text.slice(start, end);
      const fname = `chap${i + 1}.xhtml`;
      const chTitle = chs[i].title || `${i + 1}`;
      const html =
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko">
<head><meta charset="utf-8"/><title>${esc(chTitle)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${esc(chTitle)}</h1>
${paragraphsToHtml(block)}
</body>
</html>`;
      files.push({ name: 'OEBPS/' + fname, data: html });
      manifestItems.push(`<item id="ch${i + 1}" href="${fname}" media-type="application/xhtml+xml"/>`);
      spineItems.push(`<itemref idref="ch${i + 1}"/>`);
      navPoints.push({ id: i + 1, title: chTitle, file: fname });
    }

    // 표지
    let coverManifest = '', coverMeta = '', coverSpine = '';
    if (book.coverBlob) {
      const buf = await book.coverBlob.arrayBuffer();
      const ext = (book.coverBlob.type || 'image/jpeg').includes('png') ? 'png' : 'jpg';
      const mediaType = ext === 'png' ? 'image/png' : 'image/jpeg';
      files.push({ name: 'OEBPS/cover.' + ext, data: new Uint8Array(buf) });
      files.push({ name: 'OEBPS/cover.xhtml', data:
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>표지</title></head>
<body style="margin:0;text-align:center;"><img src="cover.${ext}" alt="표지" style="max-width:100%;height:auto;"/></body></html>` });
      coverManifest =
`<item id="cover-image" href="cover.${ext}" media-type="${mediaType}" properties="cover-image"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
      coverMeta = `<meta name="cover" content="cover-image"/>`;
      coverSpine = `<itemref idref="cover" linear="yes"/>`;
    }

    // nav.xhtml (EPUB3 목차)
    const navList = navPoints.map((n) => `<li><a href="${n.file}">${esc(n.title)}</a></li>`).join('\n');
    files.push({ name: 'OEBPS/nav.xhtml', data:
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko">
<head><meta charset="utf-8"/><title>목차</title></head>
<body><nav epub:type="toc" id="toc"><h1>목차</h1><ol>
${navList}
</ol></nav></body></html>` });

    // toc.ncx (EPUB2 호환)
    const ncxPoints = navPoints.map((n, i) =>
`<navPoint id="np${n.id}" playOrder="${i + 1}"><navLabel><text>${esc(n.title)}</text></navLabel><content src="${n.file}"/></navPoint>`).join('\n');
    files.push({ name: 'OEBPS/toc.ncx', data:
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${id}"/></head>
<docTitle><text>${esc(title)}</text></docTitle>
<navMap>
${ncxPoints}
</navMap></ncx>` });

    // content.opf
    files.push({ name: 'OEBPS/content.opf', data:
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="ko">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="bookid">urn:uuid:${id}</dc:identifier>
  <dc:title>${esc(title)}</dc:title>
  <dc:creator>${esc(author)}</dc:creator>
  <dc:language>ko</dc:language>
  <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  ${coverMeta}
</metadata>
<manifest>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  <item id="css" href="style.css" media-type="text/css"/>
  ${coverManifest}
  ${manifestItems.join('\n  ')}
</manifest>
<spine toc="ncx">
  ${coverSpine}
  ${spineItems.join('\n  ')}
</spine>
</package>` });

    return MiniZip.createZip(files, 'application/epub+zip');
  }

  global.Epub = { build };
})(window);
