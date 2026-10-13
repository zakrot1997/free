#!/usr/bin/env node
// «إصدار ببصمة»: يبني حزمة الإصدار من مصادر المشروع نفسها بلا أي أداة نظام:
//   freecode-v<النسخة>-features.zip  +  .sha256  +  .files.txt
// يستخدم مولّد ZIP الداخلي (src/main/zipstore.ts عبر dist) — نفس ما تختبره §78.
// التشغيل: npm run release  (يبني dist أولاً إن لم يكن موجوداً)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipstorePath = path.join(root, 'dist', 'main', 'zipstore.js');
if (!fs.existsSync(zipstorePath)) {
  console.error('dist/main/zipstore.js غير موجود — شغّل: npm run build');
  process.exit(1);
}
const { collectFiles, zipFiles, listZipEntries } = await import(zipstorePath);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '0.0.0');
const outDir = process.env.RELEASE_DIR ? path.resolve(process.env.RELEASE_DIR) : root;
fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `freecode-v${version}-features`);

const files = await collectFiles(root);
const { zip } = await zipFiles(root, files);
fs.writeFileSync(`${base}.zip`, zip);
const sha256 = createHash('sha256').update(zip).digest('hex');
fs.writeFileSync(`${base}.zip.sha256`, `${sha256}  freecode-v${version}-features.zip\n`, 'utf8');
fs.writeFileSync(`${base}.files.txt`, files.map((f) => f.rel).join('\n') + '\n', 'utf8');

// فحص ذاتي للحزمة: أسماء المدخلات تطابق قائمة الملفات
const names = listZipEntries(zip).sort();
const expected = files.map((f) => f.rel).sort();
const ok = names.length === expected.length && names.every((n, i) => n === expected[i]);

console.log(`حزمة الإصدار: ${base}.zip`);
console.log(`  الملفات: ${files.length} · البايتات: ${zip.length}`);
console.log(`  sha256: ${sha256}`);
console.log(`  sha16:  ${sha256.slice(0, 16)}`);
console.log(`  قائمة الملفات: ${base}.files.txt`);
console.log(`  فحص المحتوى: ${ok ? 'مطابق ✅' : 'غير مطابق ❌'}`);
process.exit(ok ? 0 : 1);
