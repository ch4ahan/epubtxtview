// 웹앱 자산을 Capacitor가 감쌀 www/ 폴더로 모은다.
// (node_modules·android 등은 제외하고 실제 앱 파일만 복사)
import { rm, mkdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const www = path.join(root, 'www');

const FILES = ['index.html', 'manifest.json', 'sw.js', 'icon.svg'];
const DIRS = ['css', 'js'];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

for (const f of FILES) {
  if (existsSync(path.join(root, f))) {
    await cp(path.join(root, f), path.join(www, f));
  }
}
for (const d of DIRS) {
  if (existsSync(path.join(root, d))) {
    await cp(path.join(root, d), path.join(www, d), { recursive: true });
  }
}

console.log('www/ 준비 완료:', [...FILES, ...DIRS].join(', '));
