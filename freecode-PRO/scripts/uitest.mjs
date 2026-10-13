// مُشغّل اختبار واجهة المصيّر (ح10):
//   • يتأكد من وجود البناء (dist/main/uitest.js + dist/renderer/renderer.js) وإلا يبنيه.
//   • على Linux بلا شاشة (CI/حاويات): يلفّ التشغيل بـxvfb-run تلقائياً إن وُجد.
//   • على Windows/macOS (شاشة موجودة): يشغّل electron مباشرةً.
//
// الاستخدام: node scripts/uitest.mjs [--shots <ملف.png>] [--json] [--timeout <ثوانٍ>]
import { spawnSync, spawnSync as _spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });

const need = ['dist/main/uitest.js', 'dist/renderer/renderer.js', 'dist/main/preload.js', 'dist/renderer/index.html'];
if (need.some((f) => !existsSync(path.join(root, f)))) {
  console.log('البناء ناقص — يشغّل npm run build أولاً…');
  const b = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const extra = process.argv.slice(2);
let electron;
try {
  electron = require('electron');
} catch {
  console.error('تعذّر إيجاد electron — شغّل npm install أولاً.');
  process.exit(2);
}

const headless = process.platform === 'linux' && !process.env.DISPLAY;
let cmd = electron;
let args = [path.join(root, 'dist', 'main', 'uitest.js'), ...extra];
if (headless) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' });
  if (probe.error) {
    console.error('لا شاشة (DISPLAY غير معرّف) وxvfb-run غير مثبّت.\nثبّته: sudo apt-get install -y xvfb — أو شغّل على جهاز فيه شاشة.');
    process.exit(2);
  }
  cmd = 'xvfb-run';
  args = ['-a', electron, ...args];
  console.log('بلا شاشة: يشغّل تحت xvfb-run.');
}

const child = run(cmd, args);
process.exit(child.status ?? 1);
