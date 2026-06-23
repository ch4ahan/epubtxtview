// AndroidManifest.xml에 'TXT 파일 열기/공유' 인텐트 필터를 주입한다.
// (Capacitor가 cap add android 때 새로 생성하므로 빌드마다 패치한다)
// → 파일탐색기에서 .txt를 '열기/공유'할 때 '책갈피'가 후보로 뜨게 함.
import { readFile, writeFile } from 'node:fs/promises';

const path = 'android/app/src/main/AndroidManifest.xml';
let xml = await readFile(path, 'utf8');

const FILTERS = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="content" android:mimeType="text/plain" />
                <data android:scheme="file" android:mimeType="text/plain" />
                <data android:scheme="content" android:mimeType="application/octet-stream" />
            </intent-filter>
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
            </intent-filter>`;

if (xml.includes('android.intent.action.SEND')) {
  console.log('이미 패치됨 — 건너뜀');
} else {
  // MainActivity의 기존 LAUNCHER intent-filter 닫힘 태그 뒤에 추가
  const marker = '</intent-filter>';
  const idx = xml.indexOf(marker);
  if (idx === -1) { console.error('intent-filter를 찾지 못함'); process.exit(0); }
  const insertAt = idx + marker.length;
  xml = xml.slice(0, insertAt) + '\n' + FILTERS + xml.slice(insertAt);
  await writeFile(path, xml, 'utf8');
  console.log('AndroidManifest.xml 인텐트 필터 주입 완료');
}
