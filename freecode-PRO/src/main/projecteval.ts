// «مهام من عطل المشروع»: نحوّل أعطال مشروعك الحقيقية (من سجل الموثوقية) إلى مهام
// تقييم قابلة للتحقق — فيُقاس الموديل على كودك أنت لا على بنك عام فقط.
//
// القاعدة الصارمة: لا نولّد مهمة إلا إن كان لدينا **فحص موضوعي** لها. العطل قابل
// للتحويل إذا عرفنا أمراً فاشلاً يمكن إعادة تشغيله (فشل تحقق، أو أمر فشل). ما لا
// يقبل التحقق (مثل «لم أجد النص القديم» في تعديل) يُذكر مع سبب استبعاده بدل تمريره.
//
// وميض الغش مسدود: نحفظ بصمات ملفات الإعداد (package.json, tsconfig*, ...) قبل
// المهمة، والمحاسب يقارنها بعدها — فمن يعدّل سكربت الفحص بدل إصلاح الخطأ يُكشف.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { envFailureReason, type TelemetryEvent } from './telemetry';
export { envFailureReason };
import type { EvalTask } from './evaltasks';

export interface ProjectFailure {
  kind: 'verify' | 'tool_error' | 'turn';
  /** أمر قابل لإعادة التشغيل (فارغ إن لم يكن العطل قابلاً للتحقق) */
  command: string;
  /** وصف العطل كما سُجّل */
  summary: string;
  /** أول ظهور للملفات المتعلقة (إن عُرفت) */
  file?: string;
  at: number;
  /** كم مرة ظهر هذا العطل في السجل (التكرار = أولوية أعلى؛ يُملأ عند الدمج) */
  count?: number;
  /** سبب بيئي إن كشفه نص العطل (نقص أداة/صلاحية/منفذ/شبكة…) — مهمة «لا تُصلح بالكود» */
  env?: string | null;
}

export interface SkippedFailure {
  summary: string;
  reason: string;
}

/** أنماط أوامر لا نولّد مهام منها (تُشغّل خوادم/عمليات طويلة أو تدمّر شيئاً) */
const UNSAFE_COMMAND = /\b(start|serve|watch|nodemon|vite|webpack|http-server|tail\s+-f|rm\b|kill\b|shutdown|reboot|sudo)\b/i;
const MAX_COMMAND_LEN = 300;

function lastLines(text: string, n = 6, max = 600): string {
  const lines = text.split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n').slice(0, max);
}

/**
 * يستخرج من أحداث القياس الأعطال القابلة للتحويل إلى مهام.
 * كل عطل تحقق (`verify` فاشل) أصبح مهمة «أصلح حتى يمرّ هذا الأمر».
 */
export function failuresFromEvents(events: TelemetryEvent[], opts: { limit?: number } = {}): { failures: ProjectFailure[]; skipped: SkippedFailure[] } {
  const failures: ProjectFailure[] = [];
  const skipped: SkippedFailure[] = [];
  const byKey = new Map<string, ProjectFailure>();

  // الدمج بالتكرار: العطل نفسه يظهر عدة مرات في الجولات ⇒ عدّه ولا تُسقطه،
  // ثم رتّب بالأهمية (الأكثر تكراراً أولاً، ثم الأحدث) — عطل تكرّر 3 مرات أهم من عطل ظهر مرة.
  const push = (f: ProjectFailure): void => {
    const key = `${f.kind}:${f.command || f.summary.slice(0, 80)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.count = (existing.count ?? 1) + 1;
      if (f.at > existing.at) {
        existing.at = f.at;
        existing.summary = f.summary; // أحدث نص خطأ هو الأصدق
      }
      return;
    }
    const rec = { ...f, count: 1, env: f.env ?? envFailureReason(String(f.summary ?? '')) };
    byKey.set(key, rec);
    failures.push(rec);
  };

  for (const e of events) {
    if (e.kind === 'verify' && e.ok !== true) {
      const command = String(e.command ?? '').trim();
      const summary = lastLines(String(e.summary ?? '')) || 'فشل تحقق';
      if (!command) {
        skipped.push({ summary, reason: 'لا يوجد أمر محفوظ لحالة التحقق هذه' });
        continue;
      }
      if (command.length > MAX_COMMAND_LEN) {
        skipped.push({ summary, reason: 'الأمر طويل جداً ليُعاد تشغيله بأمان' });
        continue;
      }
      if (UNSAFE_COMMAND.test(command)) {
        skipped.push({ summary, reason: `الأمر غير آمن لإعادة التشغيل تلقائياً (${command.slice(0, 40)})` });
        continue;
      }
      push({ kind: 'verify', command, summary, at: Number(e.t ?? 0) });
      continue;
    }
    if (e.kind === 'tool_error') {
      const name = String(e.name ?? '');
      const message = String(e.message ?? '');
      // أوامر فاشلة تحمل نص الأمر داخل الرسالة: "الأمر: npm test" — نستخرجها إن وُجدت
      const m = /(?:الأمر|command)\s*[:：]\s*([^\n]{3,200})/i.exec(message);
      if (name === 'run_command' && m) {
        const command = m[1].trim();
        if (!UNSAFE_COMMAND.test(command) && command.length <= MAX_COMMAND_LEN) {
          push({ kind: 'tool_error', command, summary: lastLines(message), at: Number(e.t ?? 0) });
          continue;
        }
      }
      if (/بناء|typecheck|نوع|lint|اختبار|test|build|فحص/i.test(message) && name === 'run_command') {
        skipped.push({ summary: lastLines(message), reason: 'أمر فاشل بلا نص أمر قابل للاستخراج' });
        continue;
      }
      // أخطاء أدوات التعديل/القراءة: لا فحص موضوعي لها
      if (name && ['edit_file', 'write_file', 'read_file', 'search', 'list_dir'].includes(name)) {
        skipped.push({ summary: `${name}: ${lastLines(message, 3, 200)}`, reason: 'خطأ في أداة تعديل/قراءة — لا يقبل فحصاً موضوعياً مستقلاً' });
      }
      continue;
    }
  }

  // الترتيب: الأكثر تكراراً، ثم ما يُصلح بالكود قبل ما هو بيئي، ثم الأحدث
  failures.sort((a, b) => (b.count ?? 1) - (a.count ?? 1) || Number(!!a.env) - Number(!!b.env) || b.at - a.at);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  return { failures: failures.slice(0, limit), skipped };
}

/** ملفات الإعداد التي لا يجوز للوكيل تغييرها لتخدع الفحص */
const GUARD_FILES = [
  'package.json',
  'tsconfig.json',
  'tsconfig.main.json',
  'tsconfig.renderer.json',
  'jest.config.js',
  'jest.config.cjs',
  'vitest.config.ts',
  'pytest.ini',
  'setup.cfg',
  'pyproject.toml',
  'Cargo.toml',
  'Makefile',
  'go.mod',
  '.eslintrc',
  '.eslintrc.json',
  '.eslintrc.cjs',
];

/** بصمات ملفات الإعداد الموجودة فعلاً في المشروع */
export async function configGuards(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const rel of GUARD_FILES) {
    try {
      const text = await fs.readFile(path.join(root, rel), 'utf8');
      out[rel] = createHash('sha256').update(text).digest('hex').slice(0, 16);
    } catch {
      /* غير موجود */
    }
  }
  return out;
}

/** سكربت المحاسب لمهمة مشروع: يعيد تشغيل الأمر الفاشل ويتأكد أن ملفات الإعداد لم تُغشّ */
export function projectCheckScript(command: string, guards: Record<string, string>, timeoutMs = 120_000): string {
  const guardJson = JSON.stringify(guards);
  const cmdJson = JSON.stringify(command);
  return `// محاسب مهمة مشروع: تشغيل الأمر نفسه الذي فشل، مع حماية ملفات الإعداد من الغش
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { execFileSync } = require('child_process');

const command = ${cmdJson};
const guards = ${guardJson};

try {
  execFileSync('/bin/sh', ['-c', command], { cwd: process.cwd(), timeout: ${timeoutMs}, stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  const out = String((e && (e.stdout || e.stderr)) || (e && e.message) || e).split('\\n').filter((l) => l.trim()).slice(-8).join('\\n');
  console.error('ما زال الأمر الفاشل يفشل: ' + command + '\\n' + out.slice(0, 800));
  process.exit(1);
}

const changed = [];
for (const rel of Object.keys(guards)) {
  const abs = path.join(process.cwd(), rel);
  if (!fs.existsSync(abs)) { changed.push(rel + ' (حُذف)'); continue; }
  const h = createHash('sha256').update(fs.readFileSync(abs, 'utf8')).digest('hex').slice(0, 16);
  if (h !== guards[rel]) changed.push(rel + ' (تغيّر)');
}
assert.deepStrictEqual(changed, [], 'غيّرت ملفات الإعداد (' + changed.join(' · ') + ') بدل إصلاح الخطأ — هذا غش لا إصلاح');
console.log('OK');
`;
}

/** يبني مهمة تقييم واحدة من عطل قابل للتحقق */
export async function projectTaskFromFailure(root: string, failure: ProjectFailure, index: number): Promise<EvalTask | { error: string }> {
  if (!failure.command) return { error: 'لا أمر قابل لإعادة التشغيل لهذا العطل' };
  const isVerify = failure.kind === 'verify';
  const guards = await configGuards(root);
  const count = failure.count ?? 1;
  const repeat = count > 1 ? ` (تكرّر ${count} مرات — أولوية عالية)` : '';
  const envMark = failure.env ? ' 🌐بيئي' : '';
  const title = (isVerify
    ? `إصلاح فحص فاشل: ${failure.command.slice(0, 60)}`
    : `إصلاح أمر فاشل: ${failure.command.slice(0, 60)}`) + repeat + envMark;
  const prompt = [
    isVerify
      ? `في هذا المشروع كان فحص \`${failure.command}\` يفشل، وهذا نص الخطأ كما سُجّل:`
      : `في هذا المشروع فشل الأمر \`${failure.command}\`، وهذا نص الفشل كما سُجّل:`,
    '',
    '```',
    failure.summary.slice(0, 1200) || '(بلا نص محفوظ)',
    '```',
    count > 1 ? `\nملاحظة أولوية: هذا العطل تكرّر ${count} مرات في سجل الموثوقية — إصلاحه يستحق أن يكون الأول.\n` : '',
    failure.env
      ? `\n⚠️ تشخيص بيئي مبدئي: نص الفشل يشير إلى **بيئة الجهاز** لا إلى الكود — (${failure.env}). لا تُعدّل ملفات لمحاكاة إصلاح: شغّل الأمر، تحقّق من التشخيص، ثم اشرح للمستخدم بالدقة الخطوة المطلوبة على جهازه (تثبيت أداة، صلاحية، تحرير منفذ، أو اتصال). إن تبيّن أن التشخيص خاطئ والسبب في الكود فأصلحه في الكود.\n`
      : '',
    `شغّل الأمر \`${failure.command}\` بنفسك واقرأ الخطأ الفعلي، ثم أصلح السبب الجذري في الكود.`,
    'قواعد: لا تعدّل ملفات الإعداد (package.json/tsconfig وأشباهها) ولا تُعطّل الفحص أو تُخفّض صرامته، ولا تحذف الكود الذي يجعل الفحص يفشل. المطلوب إصلاح حقيقي يمكّن الأمر من النجاح.',
  ].join('\n');
  return {
    id: `project-${failure.kind}-${index + 1}`,
    category: 'fix',
    title,
    acceptance: [
      `ينجح الأمر \`${failure.command}\` فعلاً بعد الإصلاح`,
      'لم تُعدَّل ملفات الإعداد لتعطيل الفحص (تُمحَص بالبصمة)',
      failure.env ? 'إن كان العطل بيئياً حقاً: يُذكر ذلك صراحةً بلا تعديل ملفات لمحاكاة إصلاح' : 'الإصلاح في الكود نفسه لا في اختبار/سكربت الفحص',
    ],
    prompt,
    files: {},
    copyFrom: root,
    linkNodeModules: true,
    configGuards: guards,
    checkScript: projectCheckScript(failure.command, guards),
    maxSteps: 16,
  };
}

export interface ProjectTaskSet {
  tasks: EvalTask[];
  skipped: SkippedFailure[];
}

/**
 * يبني مجموعة مهام من سجل الأعطال: يجمع الأعطال القابلة للتحقق، ويسقط المكرر
 * (نفس الأمر عدة مرات)، ويعيد أسباب استبعاد ما تبقّى بشفافية.
 */
export async function projectTasksFromEvents(root: string, events: TelemetryEvent[], opts: { limit?: number } = {}): Promise<ProjectTaskSet> {
  const { failures, skipped } = failuresFromEvents(events, { limit: opts.limit ?? 5 });
  const tasks: EvalTask[] = [];
  const skippedAll = [...skipped];
  for (let i = 0; i < failures.length; i++) {
    const t = await projectTaskFromFailure(root, failures[i], i);
    if ('error' in t) {
      skippedAll.push({ summary: failures[i].summary.slice(0, 120), reason: t.error });
      continue;
    }
    tasks.push(t);
  }
  return { tasks, skipped: skippedAll };
}

export function formatProjectTaskSet(set: ProjectTaskSet): string {
  const lines: string[] = [];
  if (!set.tasks.length) {
    lines.push('لم أستخرج أي عطل قابل للتحقق من سجل المراقبة.');
  } else {
    lines.push(`### مهام مُستخرجة من أعطال مشروعك (${set.tasks.length})`);
    lines.push('');
    lines.push('| # | المهمة | ما يجب أن ينجح بعد الإصلاح |');
    lines.push('|---|---|---|');
    set.tasks.forEach((t, i) => {
      const rep = /تكرّر (\d+) مرات/.exec(t.title);
      const env = /🌐بيئي/.test(t.title) ? ' 🌐' : '';
      lines.push(`| ${i + 1}${rep ? ` ⚠️×${rep[1]}` : ''}${env} | ${t.title} | \`${(t.acceptance?.[0] ?? '').replace(/`/g, '')}\` |`);
    });
    lines.push('');
    lines.push('> الترتيب بالأهمية: الأعطال المتكررة أولاً (⚠️×N = ظهر N مرات)، ثم ما يُصلح بالكود قبل ما هو بيئي (🌐بيئي = السبب في بيئة الجهاز لا في الملفات)، ثم الأحدث.');
    if (set.tasks.some((t) => /🌐بيئي/.test(t.title))) {
      lines.push('> 🌐 المهام البيئية لا يُطلب فيها «إصلاح كود»: المطلوب التحقق من التشخيص وشرح الخطوة المطلوبة على الجهاز — ومحاكاة إصلاح بالتعديل تُعدّ فشلاً في المعيار.');
    }
    lines.push('');
    lines.push('> الحكم: إعادة تشغيل الأمر الذي فشل — مع بصمة على ملفات الإعداد تمنع «الإصلاح» بتعطيل الفحص.');
  }
  if (set.skipped.length) {
    lines.push('');
    lines.push(`**أعطال استُبعدت (${set.skipped.length}) — بشفافية:**`);
    for (const s of set.skipped.slice(0, 8)) lines.push(`- ${s.summary.replace(/\n/g, ' ').slice(0, 100)} — ${s.reason}`);
  }
  return lines.join('\n');
}
