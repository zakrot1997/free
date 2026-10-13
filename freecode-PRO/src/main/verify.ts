// التحقق التلقائي بعد التعديلات: يكتشف أوامر الفحص المناسبة للمشروع (فحص أنواع، lint)
// ويشغّلها بعد كل تعديل، فيرى النموذج الأخطاء فوراً ويصلحها بدل أن يسلّم كوداً مكسوراً.
import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { runShell } from './shell';

export interface VerifyCommand {
  label: string;
  command: string;
  /** امتدادات الملفات التي تُفعّل هذا الفحص */
  exts: string[];
}

export interface VerifyOutcome {
  label: string;
  command: string;
  ok: boolean;
  output: string;
}

const NODE_EXTS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'];
const PY_EXTS = ['py'];

const exists = (p: string): boolean => fsSync.existsSync(p);

async function readJsonFile(file: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** هل الأمر متاح فعلاً؟ (لا نقترح npx tsc إن لم تكن typescript مثبَّتة، فالتشغيل سيفشل بلا معنى) */
function hasLocalBin(root: string, name: string): boolean {
  return exists(path.join(root, 'node_modules', '.bin', name)) || exists(path.join(root, 'node_modules', name, 'package.json'));
}

/**
 * يكتشف أوامر الفحص من بنية المشروع: سكربتات package.json أولاً (الأدق لأن المشروع يعرّفها)،
 * ثم أدوات معروفة موجودة فعلاً. لا يشغّل الاختبارات الكاملة تلقائياً (بطيئة) — تلك عبر /test.
 */
export async function detectVerify(root: string): Promise<VerifyCommand[]> {
  const out: VerifyCommand[] = [];
  const pkg = await readJsonFile(path.join(root, 'package.json'));
  const scripts: Record<string, string> = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};

  if (typeof scripts.typecheck === 'string') out.push({ label: 'فحص الأنواع', command: 'npm run --silent typecheck', exts: NODE_EXTS });
  else if (exists(path.join(root, 'tsconfig.json')) && hasLocalBin(root, 'tsc')) out.push({ label: 'فحص الأنواع', command: 'npx --no-install tsc --noEmit', exts: NODE_EXTS });

  if (typeof scripts.lint === 'string') out.push({ label: 'فحص الأسلوب', command: 'npm run --silent lint', exts: NODE_EXTS });

  // اختبار Node في الجذر (مشاريع صغيرة بلا package.json) — «شغّل الاختبار» يعني الفحص الحقيقي
  if (exists(path.join(root, 'test.js'))) out.push({ label: 'اختبار المشروع (Node)', command: 'node test.js', exts: [] });

  // بايثون: ruff إن كان مضبوطاً في المشروع ومتاحاً، وإلا فحص صياغة سريع للملفات المعدَّلة فقط
  const pyProject = exists(path.join(root, 'pyproject.toml')) || exists(path.join(root, 'ruff.toml')) || exists(path.join(root, '.ruff.toml'));
  if (pyProject && (hasLocalBin(root, 'ruff') || exists(path.join(root, '.venv', 'bin', 'ruff')))) {
    out.push({ label: 'فحص بايثون (ruff)', command: 'ruff check .', exts: PY_EXTS });
  } else if (exists(path.join(root, 'pyproject.toml')) || exists(path.join(root, 'setup.py')) || exists(path.join(root, 'requirements.txt'))) {
    out.push({ label: 'فحص صياغة بايثون', command: 'python3 -m py_compile', exts: PY_EXTS });
  }

  return out;
}

const extOf = (rel: string): string => {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i + 1).toLowerCase();
};

const MAX_OUTPUT = 3000;

/** يبقي أسطر الأخطاء المفيدة فقط (رسائل الفشل عادةً تحوي خطأ/error/✗) */
function trimOutput(text: string): string {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (clean.length <= MAX_OUTPUT) return clean;
  const lines = clean.split('\n');
  const keep = lines.filter((l) => /error|خطأ|✗|✘|failed|warning|TS\d{4}|E\d{3}/i.test(l));
  const picked = keep.length >= 3 ? keep : lines;
  const joined = picked.join('\n');
  return joined.length > MAX_OUTPUT ? joined.slice(0, MAX_OUTPUT) + '\n…[اقتُطعت بقية المخرجات]' : joined;
}

/**
 * يشغّل الفحوص المتعلقة بالملفات المعدَّلة. `override` (من الإعدادات) يستبدل الاكتشاف تماماً.
 * يُرجع null إن لم يوجد ما يستحق التشغيل.
 */
export async function runVerify(
  root: string,
  changed: string[],
  opts: { override?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<VerifyOutcome[]> {
  if (!changed.length) return [];
  const override = (opts.override ?? '').trim();
  let commands: VerifyCommand[];
  if (override) commands = [{ label: 'فحص مخصّص', command: override, exts: [] }];
  else commands = await detectVerify(root);

  const results: VerifyOutcome[] = [];
  for (const cmd of commands) {
    const relevant = cmd.exts.length === 0 || changed.some((f) => cmd.exts.includes(extOf(f)));
    if (!relevant) continue;
    const full = cmd.command === 'python3 -m py_compile' ? `${cmd.command} ${changed.filter((f) => f.endsWith('.py')).map((f) => `"${f}"`).join(' ')}` : cmd.command;
    const r = await runShell(full, { cwd: root, env: { ...process.env, FORCE_COLOR: '0', CI: '1' }, timeoutMs: opts.timeoutMs ?? 90_000, signal: opts.signal });
    if (r.aborted) return results;
    const ok = !r.timedOut && r.code === 0;
    const output = r.timedOut ? `تجاوز الفحص المهلة (${Math.round((opts.timeoutMs ?? 90_000) / 1000)}ث)` : trimOutput(r.output);
    results.push({ label: cmd.label, command: full, ok, output });
  }
  return results;
}

/** يصيغ نتائج الفحص كنص يُلحق بنتيجة الأداة ليقرأه النموذج */
export function formatVerify(results: VerifyOutcome[]): string {
  const bad = results.filter((r) => !r.ok);
  if (!bad.length) return '';
  const parts = bad.map((r) => `— ${r.label} (${r.command}) فشل:\n${r.output || '(بلا مخرجات)'}`);
  return `\n\n[تحقق تلقائي بعد التعديل: أصلح هذه الأخطاء قبل المتابعة]\n${parts.join('\n\n')}`;
}
