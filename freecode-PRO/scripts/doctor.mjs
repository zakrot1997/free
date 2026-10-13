#!/usr/bin/env node
// `npm run doctor` — فحص بيئة المشروع قبل أن تكتشفها بمحاولة فاشلة.
// تسعة فحوص مستقلة، كل واحد يطبع ✅ أو ⚠️ أو ❌ أو ➖ ومعه خطوة الإصلاح إن لزم.
// منهج: لا يصلح شيئاً بنفسه (إلا ما هو آمن ومحلي صراحةً)، ولا يلمس الشبكة،
// ولا يكتب خارج المجلدات المؤقتة، ولا يحتاج أي اعتمادية خارجية.
//
// الاستخدام:
//   npm run doctor          الفحص كاملاً (يشمل بوابة الأنواع — قد تأخذ ثوانيَ)
//   node scripts/doctor.mjs --fast    تجاهل بوابة الأنواع (فحص سريع)
//   node scripts/doctor.mjs --json    أخرج النتيجة JSON (للأتمتة)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const fast = argv.includes('--fast');
const asJson = argv.includes('--json');

const results = [];
const add = (id, title, status, detail, fix = '') => results.push({ id, title, status, detail, fix });
const exists = (rel) => fs.existsSync(path.join(root, rel));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const readText = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ---------- 1) البيئة: Node ----------
{
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 20;
  add(
    'env',
    'بيئة Node',
    ok ? 'ok' : 'bad',
    `Node ${process.versions.node} · النظام ${process.platform}/${process.arch}`,
    ok ? '' : 'ثبّت Node 20 LTS أو أحدث (nvm install 20) — المشروع يستهدف ES2022.',
  );
}

// ---------- 2) الاعتماديات ----------
{
  const need = ['electron', 'typescript', 'tsx', 'esbuild'];
  const missing = need.filter((d) => !fs.existsSync(path.join(root, 'node_modules', d)));
  add(
    'deps',
    'الاعتماديات مثبتة',
    missing.length === 0 ? 'ok' : 'bad',
    missing.length === 0 ? `${need.length} حزمة تطوير موجودة · صفر اعتماديات تشغيل` : `ناقص: ${missing.join(', ')}`,
    missing.length ? 'شغّل: npm install' : '',
  );
}

// ---------- 3) بوابة الأنواع ----------
{
  const tsc = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fast) add('types', 'بوابة الأنواع (tsc)', 'skip', 'تُخطّيت بـ --fast', 'شغّل npm run doctor بلا --fast لفحصها');
  else if (!fs.existsSync(tsc)) add('types', 'بوابة الأنواع (tsc)', 'bad', 'tsc غير موجود', 'شغّل: npm install');
  else {
    const run = (proj) => spawnSync(tsc, ['-p', proj, '--noEmit'], { cwd: root, encoding: 'utf8' });
    const a = run('tsconfig.main.json');
    const b = run('tsconfig.renderer.json');
    const bad = [
      a.status !== 0 ? `main: ${String(a.stdout || a.stderr).trim().split('\n').slice(0, 3).join(' | ')}` : '',
      b.status !== 0 ? `renderer: ${String(b.stdout || b.stderr).trim().split('\n').slice(0, 3).join(' | ')}` : '',
    ].filter(Boolean);
    add(
      'types',
      'بوابة الأنواع (tsc)',
      bad.length ? 'bad' : 'ok',
      bad.length ? bad.join(' · ') : 'العملية الرئيسية والواجهة نظيفتان (strict + noUnusedLocals + noUnusedParameters)',
      bad.length ? 'أصلح الأخطاء أعلاه ثم أعد: npm run typecheck' : '',
    );
  }
}

// ---------- 4) البناء: موجود وأحدث من المصادر؟ ----------
{
  const artifacts = ['dist/main/main.js', 'dist/renderer/renderer.js'];
  const missing = artifacts.filter((a) => !exists(a));
  if (missing.length) {
    add('build', 'بناء dist', 'bad', `ناقص: ${missing.join(', ')}`, 'شغّل: npm run build');
  } else {
    const newest = (dir, exts) => {
      let t = 0;
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (exts.some((x) => e.name.endsWith(x))) t = Math.max(t, fs.statSync(p).mtimeMs);
        }
      };
      if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
      return t;
    };
    const srcT = Math.max(newest('src/main', ['.ts']), newest('src/renderer', ['.ts', '.html', '.css']));
    const distT = Math.min(...artifacts.map((a) => fs.statSync(path.join(root, a)).mtimeMs));
    const stale = srcT > distT;
    add(
      'build',
      'بناء dist',
      stale ? 'warn' : 'ok',
      stale ? 'المصادر أحدث من آخر بناء — ما تراه في dist ليس آخر كودك' : 'البناء أحدث من المصادر (لا كود قديم مخفي)',
      stale ? 'شغّل: npm run build' : '',
    );
  }
}

// ---------- 5) بوابات الجودة في tsconfig ----------
{
  const gates = ['tsconfig.main.json', 'tsconfig.renderer.json'].map((f) => {
    if (!exists(f)) return `${f} مفقود`;
    const j = readJson(f);
    const o = j.compilerOptions ?? {};
    const lack = ['strict', 'noUnusedLocals', 'noUnusedParameters'].filter((k) => o[k] !== true);
    return lack.length ? `${f}: معطّل ${lack.join(', ')}` : '';
  });
  const bad = gates.filter(Boolean);
  add(
    'gates',
    'بوابات الجودة في tsconfig',
    bad.length ? 'bad' : 'ok',
    bad.length ? bad.join(' · ') : 'strict + noUnusedLocals + noUnusedParameters فعّالة في الملفين',
    bad.length ? 'أعد البوابات في ملفات tsconfig (راجع آخر إصدار من المشروع)' : '',
  );
}

// ---------- 6) حارس .freecode (سجلات الجسر/القياس لا تُرفع إلى git) ----------
{
  const dir = path.join(root, '.freecode');
  if (!fs.existsSync(dir)) {
    add('guard', 'حارس .freecode/.gitignore', 'skip', 'لا مجلد .freecode بعد — يُنشأ مع أول استعمال (لا خطر تسرّب)', '');
  } else {
    const file = path.join(dir, '.gitignore');
    if (!fs.existsSync(file)) {
      add('guard', 'حارس .freecode/.gitignore', 'bad', 'مجلد .freecode موجود بلا حارس: git add . قد يرفع سجلك', `أنشئه: printf '*\\n!.gitignore\\n' > .freecode/.gitignore`);
    } else {
      const body = fs.readFileSync(file, 'utf8');
      const guarded = body.includes('*') && body.includes('!.gitignore');
      let ignoredByGit = null;
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', '.freecode/bridge-log.jsonl'], { cwd: root, stdio: 'ignore' });
        ignoredByGit = true;
      } catch (e) {
        ignoredByGit = e?.status === 1 ? false : null; // 1 = غير متجاهَل · غير ذلك = لا مستودع git
      }
      const status = guarded && ignoredByGit !== false ? 'ok' : 'warn';
      add(
        'guard',
        'حارس .freecode/.gitignore',
        status,
        guarded
          ? `الحارس موجود${ignoredByGit === true ? ' و git يتجاهل ملفاته فعلاً' : ignoredByGit === false ? ' لكن git لا يراه (المشروع مستودع آخر؟)' : ' (لا مستودع git هنا)'}`
          : 'الحارس موجود لكنه لا يتجاهل مجلد الحالة',
        status === 'ok' ? '' : "اكتب في .freecode/.gitignore: سطر «*» ثم «!.gitignore»",
      );
    }
  }
}

// ---------- 7) أمر التحقق (verify) ----------
{
  let pkg = null;
  try {
    pkg = readJson('package.json');
  } catch {
    /* لا package.json — نبلّغ أدناه */
  }
  if (!pkg) add('verify', 'أمر التحقق', 'bad', 'لا package.json في هذا المجلد', 'شغّل doctor من جذر المشروع');
  else {
    const scripts = pkg.scripts ?? {};
    const candidates = ['typecheck', 'test', 'lint', 'build'].filter((s) => scripts[s]);
    add(
      'verify',
      'أمر التحقق',
      candidates.length ? 'ok' : 'warn',
      candidates.length ? `متاح: ${candidates.map((c) => `npm run ${c}`).join(' · ')} — الوكيل يستخدمه للتحقق التلقائي` : 'لا أوامر فحص في package.json',
      candidates.length ? '' : 'أضف "typecheck" أو "test" في scripts كي يتحقق الوكيل تلقائياً بعد كل تعديل',
    );
  }
}

// ---------- 8) تطابق الإصدار ----------
{
  try {
    const pkg = readJson('package.json');
    const lock = exists('package-lock.json') ? readJson('package-lock.json') : null;
    const lockV = lock?.version ?? '';
    const lockRootV = lock?.packages?.['']?.version ?? '';
    const same = lock && lockV === pkg.version && lockRootV === pkg.version;
    add(
      'version',
      'تطابق الإصدار',
      same ? 'ok' : lock ? 'bad' : 'warn',
      lock ? `package.json ${pkg.version} · package-lock ${lockV}${lockRootV && lockRootV !== lockV ? ` · الجذر ${lockRootV}` : ''}` : `package.json ${pkg.version} بلا package-lock.json`,
      same ? '' : 'حدّث النسخة في الملفين معاً، أو شغّل: npm install --package-lock-only',
    );
  } catch (e) {
    add('version', 'تطابق الإصدار', 'bad', String(e?.message ?? e).slice(0, 120), 'تأكد أن package.json وpackage-lock.json صالحان');
  }
}

// ---------- 9) خادم MCP: يُبنى ويعمل ويعرض أدواته ----------
{
  if (!exists('dist/main/mcpserver.js')) {
    add('mcp', 'خادم MCP (أدوات FreeCode لعملاء MCP)', fast || !exists('dist/main/main.js') ? 'skip' : 'bad', 'الملف dist/main/mcpserver.js غير موجود', 'شغّل: npm run build ثم أعد الفحص');
  } else {
    try {
      const r = spawnSync(process.execPath, [path.join(root, 'dist', 'main', 'mcpserver.js'), '--help'], { cwd: root, timeout: 20_000, encoding: 'utf8' });
      const help = String(r.stdout ?? '');
      const ok = r.status === 0 && help.includes('--allow-writes') && help.includes('claude_desktop_config.json');
      add(
        'mcp',
        'خادم MCP (أدوات FreeCode لعملاء MCP)',
        ok ? 'ok' : 'bad',
        ok ? 'يعمل ويطبع دليل الربط (npm run mcp -- --root <مشروع>)' : `فشل التشغيل (exit ${r.status}): ${String(r.stderr ?? '').slice(0, 120)}`,
        ok ? '' : 'أعد البناء: npm run build — وتأكد أن src/main/mcpserver.ts سليم',
      );
    } catch (e) {
      add('mcp', 'خادم MCP (أدوات FreeCode لعملاء MCP)', 'bad', String(e?.message ?? e).slice(0, 120), 'أعد البناء: npm run build');
    }
  }
}

// ---------- العرض ----------
const mark = { ok: '✅', warn: '⚠️ ', bad: '❌', skip: '➖' };
const bad = results.filter((r) => r.status === 'bad');
const warn = results.filter((r) => r.status === 'warn');

if (asJson) {
  console.log(JSON.stringify({ ok: bad.length === 0, bad: bad.length, warn: warn.length, checks: results }, null, 1));
} else {
  console.log(`\nفحص البيئة — FreeCode (${root})\n`);
  for (const r of results) {
    console.log(`${mark[r.status]} ${r.title}: ${r.detail}`);
    if (r.fix && r.status !== 'ok') console.log(`    الإصلاح: ${r.fix}`);
  }
  console.log('');
  const skipped = results.filter((r) => r.status === 'skip').length;
  const pass = results.filter((r) => r.status === 'ok').length;
  console.log(
    bad.length
      ? `النتيجة: ${bad.length} عطل يمنع العمل السليم · ${pass} سليم · ${warn.length} تحذير${skipped ? ` · ${skipped} تخطٍّ` : ''}`
      : warn.length || skipped
        ? `النتيجة: لا أعطال · ${pass} فحص سليم${warn.length ? ` · ${warn.length} تحذير (تفقّد الأسطر ⚠️)` : ''}${skipped ? ` · ${skipped} تخطٍّ (➖)` : ''}`
        : `النتيجة: كل الفحوص سليمة (${pass}/${results.length}) — ابدأ العمل`,
  );
}

process.exit(bad.length ? 1 : 0);
