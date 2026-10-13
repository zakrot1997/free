// اختبار A/B لملف التعليمات (FREECODE.md وأشباهه): هل النسخة الجديدة أفضل فعلاً؟
// نفس المهام، نفس الموديل، نفس الظروف — والفرق الوحيد هو نص التعليمات.
//
// لماذا هذا مهم؟ لأن تعليمات المشروع (FREECODE.md/AGENTS.md) تُكتب عادة بالذوق
// والانطباع. هنا تُقاس: نجاح المهام، التوكنات، الخطوات، الزمن — مع تحذير صريح
// من ضجيج القياس حين تكون العيّنة صغيرة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentOptions } from './agent';
import type { EvalTask } from './evaltasks';
import { EVAL_TASKS, quickTasks } from './evaltasks';
import { runTaskForModel, type ModelTarget, type EvalOptions } from './modeleval';
import { detectVerify } from './verify';
import { projectCheckScript } from './projecteval';

export interface AbVariant {
  label: string;
  /** نص التعليمات · null = بلا تعليمات (خط الأساس) · undefined = أبقِ تعليمات المشروع كما هي */
  text?: string | null;
  /** تجاوزات على خيارات الوكيل (مثل repoMap/autoVerify) — لقياس أثر «السياق» نفسه */
  options?: Partial<AgentOptions>;
}


/** محاور سياق الوكيل القابلة للقياس — كل محور = نسختان تختلفان في خيار واحد فقط */
export type ContextAxis = 'repoMap' | 'autoVerify' | 'budget' | 'memory';

export interface ContextAxisInfo {
  axis: ContextAxis;
  title: string;
  /** ما يُقاس: السؤال الذي يجيب عنه الاختبار */
  question: string;
}

export const CONTEXT_AXES: ContextAxisInfo[] = [
  { axis: 'repoMap', title: 'خريطة المستودع (repoMap)', question: 'هل تستحق خريطة الرموز توكناتها؟' },
  { axis: 'autoVerify', title: 'التحقق التلقائي (autoVerify)', question: 'هل يعوّض التحقق التلقائي أخطاء الموديل؟' },
  { axis: 'budget', title: 'ميزانية السياق (tokenBudget)', question: 'هل تستحق الميزانية الواسعة كلفتها، أم تكفي الضيقة؟' },
  { axis: 'memory', title: 'ذاكرة المشروع (.freecode/memory.md)', question: 'هل تفيد ذاكرة المشروع أم تضخّم السياق بلا مقابل؟' },
];

/** عند وجود محاور ذات معنى خاص للعمودين «مفعّل/معطّل» نضيف حاشية صريحة */
export const AXIS_COLUMN_NOTES: Partial<Record<ContextAxis, string>> = {
  budget: 'في محور الميزانية: «مفعّل» = الميزانية الواسعة (32k)، و«معطّل» = الضيقة (8k) — و«أطفئها» هنا تعني اختر الضيقة.',
  memory: 'في محور الذاكرة: «مفعّل» = تُحمَّل ذاكرة المشروع، و«معطّل» = بلا ذاكرة — و«أطفئها» تعني أوقف تحميل الذاكرة.',
  autoVerify: 'في محور autoVerify: «مفعّل» = يفحص بعد كل تعديل بأمر فحص حقيقي (node test.js · npm run typecheck · …) و«معطّل» = بلا فحص — ولا يُقاس إلا على مهام فيها فحص فعلاً.',
};

/** يبني نسختي محور واحد: «مفعّل» مقابل «معطّل» — مع بقاء تعليمات المشروع نفسها */
export function contextVariants(axis: ContextAxis, opts: { verifyCommand?: string } = {}): AbVariant[] {
  if (axis === 'repoMap') {
    return [
      { label: 'repoMap مفعّلة', options: { repoMap: true } },
      { label: 'repoMap معطّلة', options: { repoMap: false } },
    ];
  }
  if (axis === 'budget') {
    return [
      { label: 'ميزانية واسعة', options: { tokenBudget: 32_000 } },
      { label: 'ميزانية ضيقة', options: { tokenBudget: 8_000 } },
    ];
  }
  if (axis === 'memory') {
    return [
      { label: 'الذاكرة مفعّلة', options: { memory: true } },
      { label: 'الذاكرة معطّلة', options: { memory: false } },
    ];
  }
  // فحص حقيقي: عند وجود أمر مشروع صريح يُمرَّر للمفعّل، وإلا يكتشف الوكيل داخل كل مهمة (test.js · typecheck · …)
  const vc = (opts.verifyCommand ?? '').trim();
  return [
    { label: 'autoVerify مفعّل', options: { autoVerify: true, ...(vc ? { verifyCommand: vc } : {}) } },
    { label: 'autoVerify معطّل', options: { autoVerify: false } },
  ];
}

/** هل يمكن لمحور autoVerify أن يقيس فحصاً حقيقياً على هذه المهام؟ (مهمة بلا فحص = صف صامت) */
export function sweepVerifyCoverage(tasks: EvalTask[]): { usable: number; total: number } {
  const hasCheck = (t: EvalTask): boolean => {
    if (t.copyFrom) return true; // مشروع حقيقي: الفحص يُكتشف داخله
    const files = t.files ?? {};
    const keys = Object.keys(files);
    if (keys.some((f) => /(^|\/)test\.js$/.test(f))) return true;
    if (keys.some((f) => /(^|\/)tsconfig\.json$/.test(f))) return true;
    if (keys.some((f) => f.endsWith('.py'))) return true;
    const pkg = files['package.json'];
    if (typeof pkg === 'string') {
      try {
        const j = JSON.parse(pkg) as { scripts?: Record<string, unknown> };
        if (j?.scripts && ['test', 'typecheck', 'lint'].some((k) => typeof j.scripts?.[k] === 'string')) return true;
      } catch {
        /* package.json غير صالح = لا فحص */
      }
    }
    return false;
  };
  return { usable: tasks.filter(hasCheck).length, total: tasks.length };
}


// ---------------- جرد محاور السياق: قياس جماعي جاهز للتوثيق ----------------
// الحاجة: قرار «أُبقي هذه الميزة أم أطفئها؟» يتكرر مع كل موديل جديد. هنا قياس
// واحد يمرّ على عدة موديلات × كل محاور السياق وينتج جدولاً بفرق النجاح وفرق
// التوكنات وقراءة صريحة — نفس المنهجية (فرق واحد فقط) بلا استثناء.

export interface AxisSweepRow {
  model: string;
  axis: ContextAxis;
  onPassed: number;
  onTotal: number;
  onTokens: number;
  offPassed: number;
  offTotal: number;
  offTokens: number;
  /** نجاح المفعّل − نجاح المعطّل (موجب = الميزة مفيدة) */
  deltaPassed: number;
  /** نسبة التوكنات الموفَّرة لصالح المفعّل (موجب = المفعّل أوفر) */
  tokenSavingPct: number;
  reading: string;
}

export interface AxisSweepOptions {
  repeats?: number;
  axes?: ContextAxis[];
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** أمر فحص المشروع الحقيقي لمحور autoVerify (فارغ = اكتشاف تلقائي داخل كل مهمة) */
  verifyCommand?: string;
}

/** قراءة صريحة بلا تجميل: الفرق في النجاح أولاً، ثم كلفة التوكنات */
export function axisReading(deltaPassed: number, tokenSavingPct: number): string {
  // tokenSavingPct موجب = المفعّل يستهلك توكنات أقل من المعطّل
  if (deltaPassed > 0) return tokenSavingPct <= -8 ? 'الميزة مفيدة: نجاح أعلى (وتكلّف توكنات أكثر)' : 'الميزة مفيدة: نجاح أعلى';
  if (deltaPassed < 0) return 'الميزة ضارة: نجاح أقل — أطفئها';
  if (tokenSavingPct <= -8) return 'لا مكسب في النجاح وتكلفتها توكنات أعلى — أطفئها';
  if (tokenSavingPct >= 8) return 'لا فرق في النجاح والمفعّل أوفر توكنات';
  return 'لا فرق يُذكر — القرار ذوقي';
}

/** يمرّ على (الموديلات × المحاور) بنفس المهام، ويعيد صفوفاً موحّدة */
export async function contextAxisSweep(
  targets: ModelTarget[],
  tasks: EvalTask[],
  opts: AxisSweepOptions = {},
): Promise<AxisSweepRow[]> {
  const axes = opts.axes ?? CONTEXT_AXES.map((a) => a.axis);
  const rows: AxisSweepRow[] = [];
  for (const target of targets) {
    for (const axis of axes) {
      const report = await runAbTest(target, tasks, {
        variants: contextVariants(axis, { verifyCommand: opts.verifyCommand }),
        repeats: Math.max(1, Math.min(3, opts.repeats ?? 1)),
        signal: opts.signal,
        onProgress: opts.onProgress,
      });
      // contextVariants يعيد دائماً [المفعّل, المعطّل] بهذا الترتيب
      const on = report.summary[0];
      const off = report.summary[1];
      const deltaPassed = on.passed - off.passed;
      const tokenSavingPct = off.tokens > 0 ? Math.round(((off.tokens - on.tokens) / off.tokens) * 100) : 0;
      rows.push({
        model: target.label,
        axis,
        onPassed: on.passed,
        onTotal: on.total,
        onTokens: on.tokens,
        offPassed: off.passed,
        offTotal: off.total,
        offTokens: off.tokens,
        deltaPassed,
        tokenSavingPct,
        reading: axisReading(deltaPassed, tokenSavingPct),
      });
    }
  }
  return rows;
}

/** جدول ماركداون جاهز للصق في README أو تقرير */
export function formatAxisSweep(rows: AxisSweepRow[], meta: { tasks: number; repeats: number }): string {
  const lines: string[] = [];
  lines.push(`### جرد محاور السياق (${rows.length} صفاً: موديلات × محاور)`);
  lines.push('');
  lines.push('| الموديل | المحور | مفعّل: نجاح | مفعّل: توكن | معطّل: نجاح | معطّل: توكن | فرق النجاح | فرق التوكنات | القراءة |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const save = r.tokenSavingPct > 0 ? `أوفر بـ${r.tokenSavingPct}%` : r.tokenSavingPct < 0 ? `أغلى بـ${-r.tokenSavingPct}%` : '=';
    lines.push(
      `| ${r.model} | ${r.axis} | ${r.onPassed}/${r.onTotal} | ${r.onTokens} | ${r.offPassed}/${r.offTotal} | ${r.offTokens} | ${r.deltaPassed > 0 ? '+' : ''}${r.deltaPassed} | ${save} | ${r.reading} |`,
    );
  }
  lines.push('');
  lines.push(summarizeAxisSweep(rows));
  lines.push('');
  lines.push(
    `> المنهجية: نفس المهام (${meta.tasks}) ونفس نص التعليمات في كل الصفوف؛ الفرق الوحيد خيار وكيل واحد (مفعّل مقابل معطّل)، وترتيب التشغيل يُعكس بين التكرارات (${meta.repeats}) إنصافاً. الحكم من محاسب مخفي لا من كلام الموديل.`,
  );
  lines.push('> اقرأ القراءة كما هي: «لا فرق يُذكر» يعني لا مكسب يبرّر الكلفة — أطفئ الميزة ووفّر التوكنات.');
  const notes = [...new Set(rows.map((r) => r.axis))].map((a) => AXIS_COLUMN_NOTES[a]).filter(Boolean) as string[];
  for (const n of notes) lines.push(`> ${n}`);
  return lines.join('\n');
}

/** كتلة ماركداون جاهزة للصق في README — بعلامات تمنع التعديل اليدوي وتذكر تاريخ القياس */
export function formatAxisSweepReadme(
  rows: AxisSweepRow[],
  meta: { tasks: number; repeats: number },
  opts: { at?: number; models?: string[]; tasksLabel?: string } = {},
): string {
  const at = new Date(opts.at ?? Date.now()).toISOString().slice(0, 10);
  const models = opts.models?.length ? opts.models.join(' · ') : `${new Set(rows.map((r) => r.model)).size} موديل`;
  const head = [
    '<!-- بداية جدول جرد المحاور — مولَّد آلياً بـ freecode-eval --ctx-sweep --table-out، لا تعدّله يدوياً -->',
    `_قياس بتاريخ ${at} · الموديلات: ${models} · المهمات: ${opts.tasksLabel ?? `${meta.tasks} مهمة`} × ${meta.repeats} تكرار_`,
    '',
  ].join('\n');
  const tail = '\n\n<!-- نهاية جدول جرد المحاور -->';
  return `${head}${formatAxisSweep(rows, meta)}${tail}\n`;
}

export function axisSweepJson(rows: AxisSweepRow[]): string {
  return JSON.stringify({ kind: 'context-axis-sweep', rows }, null, 2);
}

// ---------------- تصنيف الصفوف وخلاصة الجرد والمقارنة الزمنية ----------------

export type AxisKind = 'مفيد' | 'ضار' | 'يكلّف بلا مكسب' | 'يوفّر' | 'بلا فرق';

/** تصنيف واحد لكل صف — نفس منطق axisReading لكن بلا صياغة، لعدّ الخلاصة */
export function axisKind(r: Pick<AxisSweepRow, 'deltaPassed' | 'tokenSavingPct'>): AxisKind {
  if (r.deltaPassed > 0) return 'مفيد';
  if (r.deltaPassed < 0) return 'ضار';
  if (r.tokenSavingPct <= -8) return 'يكلّف بلا مكسب';
  if (r.tokenSavingPct >= 8) return 'يوفّر';
  return 'بلا فرق';
}

/** خلاصة عبر الموديلات لكل محور: عدّ التصنيفات + توصية واحدة صريحة */
export function summarizeAxisSweep(rows: AxisSweepRow[]): string {
  const lines: string[] = ['#### الخلاصة عبر الموديلات'];
  const byAxis = new Map<ContextAxis, AxisSweepRow[]>();
  for (const r of rows) {
    const list = byAxis.get(r.axis) ?? [];
    list.push(r);
    byAxis.set(r.axis, list);
  }
  if (!byAxis.size) {
    lines.push('', 'لا صفوف بعد.');
    return lines.join('\n');
  }
  for (const [axis, list] of byAxis) {
    const name = CONTEXT_AXES.find((a) => a.axis === axis)?.title ?? axis;
    const c = (k: AxisKind): number => list.filter((r) => axisKind(r) === k).length;
    const parts: string[] = [];
    for (const k of ['مفيد', 'ضار', 'يكلّف بلا مكسب', 'يوفّر', 'بلا فرق'] as AxisKind[]) {
      const n = c(k);
      if (n) parts.push(`${k} عند ${n}`);
    }
    const good = c('مفيد') + c('يوفّر');
    const bad = c('ضار') + c('يكلّف بلا مكسب');
    const rec = good > bad ? 'التوصية: أبقِه' : bad > good ? 'التوصية: أطفئه' : 'التوصية: قرّر لكل موديل (الجدول أعلاه)';
    lines.push(`- **${name}**: ${parts.join(' · ')} (من ${list.length} موديل) — ${rec}.`);
  }
  return lines.join('\n');
}

/** صف أرشيف جرد واحد (يُخزَّن JSONL في .freecode/ctx-sweep.jsonl) */
export interface AxisSweepArchive {
  at: number;
  tasks: number;
  repeats: number;
  rows: AxisSweepRow[];
  /** بصمة إعداد الجرد وقت التنفيذ (لكشف «قبل/بعد»: هل تغيّر الإعداد أم الموديل؟) */
  configHash?: string;
  /** وصف مقروء للإعداد الفعلي (موديلات × محاور × مهام × تكرار) */
  signature?: string;
}

export function axisSweepArchiveEntry(
  rows: AxisSweepRow[],
  meta: { tasks: number; repeats: number },
  extra: { configHash?: string; signature?: string } = {},
): AxisSweepArchive {
  return { at: Date.now(), tasks: meta.tasks, repeats: meta.repeats, rows, ...extra };
}

/** تُضاف إلى صف الأرشيف والملخص: هل تغيّر الإعداد بين الجردين؟ (وإلا فنسب التغيّر للموديل) */
export function sweepConfigAttribution(
  prev: { configHash?: string } | null | undefined,
  next: { configHash?: string } | null | undefined,
): 'same' | 'changed' | 'unknown' {
  if (!prev?.configHash || !next?.configHash) return 'unknown';
  return prev.configHash === next.configHash ? 'same' : 'changed';
}

/** «ما تغيّر منذ آخر جرد»: فرق النجاح وفرق نقاط التوكنات لكل (موديل × محور) */
export function compareAxisSweep(prev: AxisSweepArchive | null, rows: AxisSweepRow[], next?: { configHash?: string }): string {
  const lines: string[] = ['#### ما تغيّر منذ آخر جرد'];
  if (!prev || !prev.rows?.length) {
    lines.push('', 'لا يوجد جرد محفوظ للمقارنة بعد — شغّل الجرد مع `--save` ثم أعد التشغيل مع `--compare`.');
    return lines.join('\n');
  }
  const when = new Date(prev.at).toISOString().slice(0, 16).replace('T', ' ');
  lines.push('', `الأساس: جرد محفوظ بتاريخ ${when} (${prev.tasks} مهمة × ${prev.repeats} تكرار) — الفرق المباشر:`, '');
  lines.push('| الموديل | المحور | Δفرق النجاح | Δنقاط التوكنات | القراءة الجديدة |');
  lines.push('|---|---|---|---|---|');
  let regressions = 0;
  let improvements = 0;
  for (const r of rows) {
    const p = prev.rows.find((x) => x.model === r.model && x.axis === r.axis);
    if (!p) {
      lines.push(`| ${r.model} | ${r.axis} | جديد | جديد | ${r.reading} |`);
      continue;
    }
    const dp = r.deltaPassed - p.deltaPassed;
    const dt = r.tokenSavingPct - p.tokenSavingPct;
    if (dp < 0) regressions++;
    if (dp > 0) improvements++;
    lines.push(
      `| ${r.model} | ${r.axis} | ${dp > 0 ? '+' : ''}${dp} | ${dt > 0 ? '+' : ''}${dt} | ${r.reading} |`,
    );
  }
  const attr = sweepConfigAttribution(prev, next ?? null);
  if (regressions) lines.push('', `> ⚠️ انحدار في ${regressions} صفاً: فرق النجاح تراجع منذ الجرد المحفوظ — راجع الموديل أو الإعداد قبل الاعتماد.`);
  else if (improvements) lines.push('', `> ✅ تحسّن في ${improvements} صفاً — إن كان بعد ترقية موديل فالتحديث مفيد بهذا القياس.`);
  else lines.push('', '> لا تغيّر جوهري في فرق النجاح منذ الجرد المحفوظ.');
  if (attr === 'changed') {
    lines.push('', `> 🧩 إعداد الجرد تغيّر منذ الجرد السابق (${String(prev.configHash)} ← ${String(next?.configHash)}) — الصفوف التي تحرّكت تعكس الإعداد الجديد لا تغيّر الموديل بالضرورة.`);
  } else if (attr === 'same') {
    lines.push('', '> 🧩 إعداد الجرد نفسه منذ الجرد السابق — كل فرق في الأرقام يُنسب إلى الموديل/المهام لا إلى الإعداد.');
  }
  return lines.join('\n');
}

export interface AbRunResult {
  variant: string;
  ok: boolean;
  reason: string;
  steps: number;
  tokens: number;
  durationMs: number;
}

export interface AbTaskResult {
  taskId: string;
  title: string;
  runs: AbRunResult[];
}

export interface AbSummary {
  variant: string;
  passed: number;
  total: number;
  tokens: number;
  stepsPerPass: number;
  durationMs: number;
}

export interface AbReport {
  mode: 'bank' | 'project';
  /** instructions = مقارنة نصوص تعليمات · context = مقارنة خيارات وكيل (repoMap/autoVerify…) */
  kind: 'instructions' | 'context';
  taskLabel: string;
  variants: string[];
  repeats: number;
  tasks: AbTaskResult[];
  summary: AbSummary[];
  verdict: string;
}

export interface AbOptions extends Omit<EvalOptions, 'tasks'> {
  variants: AbVariant[];
  /** عدد التكرارات لكل (مهمة × نسخة) — التكرار يكشف التذبذب */
  repeats?: number;
  onProgress?: (line: string) => void;
}

/** يبني مهمة من نص حرّ على مشروع حقيقي؛ الحكم بأمر التحقق المكتشف في المشروع */
export async function taskFromPrompt(root: string, prompt: string, opts: { id?: string; maxSteps?: number } = {}): Promise<EvalTask | { error: string }> {
  const cmds = await detectVerify(root).catch(() => []);
  if (!cmds.length) {
    return { error: 'لا يوجد أمر فحص في هذا المشروع (لا سكربتات اختبار/أنواع)، وبلا فحص لا يمكن الحكم على نجاح المهمة.' };
  }
  const command = cmds[0].command;
  return {
    id: opts.id ?? 'ab-prompt',
    category: 'feature',
    title: prompt.slice(0, 70),
    acceptance: [`ينجح أمر المشروع \`${command}\` بعد التعديل`, 'لا تُعدَّل ملفات الإعداد لتعطيل الفحص'],
    prompt,
    files: {},
    copyFrom: root,
    linkNodeModules: true,
    configGuards: {},
    checkScript: projectCheckScript(command, {}),
    maxSteps: opts.maxSteps ?? 16,
  };
}

/**
 * يشغّل A/B: لكل مهمة، كل نسخة تعليمات، بعدد التكرارات المطلوب.
 * الترتيب يُعكس في التكرارات الفردية لأخذ إنصاف الموديل والخادم بعين الاعتبار.
 */
export async function runAbTest(target: ModelTarget, tasks: EvalTask[], opts: AbOptions): Promise<AbReport> {
  const variants = opts.variants.filter((v) => v && v.label);
  const repeats = Math.max(1, Math.min(3, opts.repeats ?? 1));
  const results: AbTaskResult[] = [];
  const prog = opts.onProgress ?? ((): void => {});

  for (let t = 0; t < tasks.length; t++) {
    const task = tasks[t];
    const runs: AbRunResult[] = [];
    prog(`مهمة ${t + 1}/${tasks.length}: ${task.title}`);
    for (let r = 0; r < repeats; r++) {
      const order = r % 2 === 0 ? variants : [...variants].reverse();
      for (const v of order) {
        const instrOverride =
          v.text === undefined
            ? {} // أبقِ تعليمات المشروع (اختبار سياق خالص)
            : { instructionsOverride: v.text === null ? null : { file: 'FREECODE.md (نسخة الاختبار)', text: v.text } };
        const outcome = await runTaskForModel(target, task, {
          ...opts,
          agentOptions: { ...(opts.agentOptions ?? {}), ...instrOverride, ...(v.options ?? {}) },
        });
        runs.push({ variant: v.label, ok: outcome.ok, reason: outcome.reason, steps: outcome.steps, tokens: outcome.tokens, durationMs: outcome.durationMs });
        prog(`  ${v.label}: ${outcome.ok ? '✅' : '❌'}${outcome.ok ? '' : ` — ${outcome.reason.slice(0, 70)}`}`);
      }
    }
    results.push({ taskId: task.id, title: task.title, runs });
  }

  const summary: AbSummary[] = variants.map((v) => {
    const all = results.flatMap((t) => t.runs.filter((r) => r.variant === v.label));
    const passed = all.filter((r) => r.ok).length;
    const tokens = all.reduce((a, r) => a + r.tokens, 0);
    const steps = all.filter((r) => r.ok).reduce((a, r) => a + r.steps, 0);
    return {
      variant: v.label,
      passed,
      total: all.length,
      tokens,
      stepsPerPass: passed ? Math.round((steps / passed) * 10) / 10 : 0,
      durationMs: all.reduce((a, r) => a + r.durationMs, 0),
    };
  });

  const variants_label = variants.map((v) => v.label);
  const isContext = variants.every((v) => v.text === undefined && !!v.options);
  return {
    mode: 'bank',
    kind: isContext ? ('context' as const) : ('instructions' as const),
    taskLabel: tasks.length === EVAL_TASKS.length ? 'البنك الكامل' : tasks.length === quickTasks().length ? 'المجموعة السريعة' : 'مهمة مخصّصة',
    variants: variants_label,
    repeats,
    tasks: results,
    summary,
    verdict: abVerdict(summary, repeats),
  };
}

/** حكم صريح: من الأفضل، وهل الفرق يُعتد به أم ضجيج */
export function abVerdict(summary: AbSummary[], repeats: number): string {
  if (summary.length < 2) return 'تحتاج نسختين على الأقل للمقارنة.';
  const byPass = [...summary].sort((a, b) => b.passed - a.passed || a.tokens - b.tokens);
  const [first, second] = byPass;
  const spread = first.passed - second.passed;
  const noiseNote = repeats === 1 ? ' (جولة واحدة لكل نسخة — الفرق قد يكون تذبذباً؛ أعد بـ--repeat 2 أو 3 لتأكيده)' : '';
  if (spread === 0) {
    const tokensDiff = first.tokens && second.tokens ? (first.tokens - second.tokens) / Math.max(first.tokens, second.tokens) : 0;
    if (tokensDiff <= -0.1) return `لا فرق في النجاح (${first.passed}/${first.total} لكلتيهما)، لكن «${first.variant}» استهلك توكنات أقل بـ${Math.round(Math.abs(tokensDiff) * 100)}% — الاقتصاد يرجّحها لنصوص طويلة${noiseNote}.`;
    return `نتيجة متعادلة: ${first.passed}/${first.total} لكل نسخة، وبفارق توكنات لا يُعتد به — لا دليل على أن إحداهما أفضل${noiseNote}.`;
  }
  return `«${first.variant}» تتفوق: ${first.passed}/${first.total} مقابل ${second.passed}/${second.total} («${second.variant}»)، بمتوسط ${first.stepsPerPass} خطوة للمهمة الناجحة${noiseNote}.`;
}

const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function formatAbReport(r: AbReport): string {
  const lines: string[] = [];
  const title = r.kind === 'context' ? 'مقارنة A/B لسياق الوكيل' : 'مقارنة A/B لملف التعليمات';
  lines.push(`### ${title} (${r.taskLabel} · ${r.tasks.length} مهمة)`);
  lines.push('');
  lines.push('| النسخة | النجاح | النسبة | توكنات | متوسط الخطوات (ناجحة) | الزمن |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of r.summary) lines.push(`| ${s.variant} | ${s.passed}/${s.total} | ${pct(s.passed, s.total)} | ${s.tokens} | ${s.stepsPerPass || '—'} | ${(s.durationMs / 1000).toFixed(1)}ث |`);
  lines.push('');
  lines.push('**تفصيل المهام:**');
  lines.push('');
  lines.push(`| المهمة | ${r.variants.join(' | ')} |`);
  lines.push(`|---|${r.variants.map(() => '---').join('|')}|`);
  for (const t of r.tasks) {
    const cells = r.variants.map((v) => {
      const runs = t.runs.filter((x) => x.variant === v);
      return runs.map((x) => (x.ok ? '✅' : '❌')).join(' ');
    });
    lines.push(`| ${t.taskId} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push(`**الحكم:** ${r.verdict}`);
  const fails = r.tasks.flatMap((t) => t.runs.filter((x) => !x.ok).map((x) => ({ t, x })));
  if (fails.length) {
    lines.push('');
    lines.push('**أسباب الفشل:**');
    for (const { t, x } of fails.slice(0, 10)) lines.push(`- «${x.variant}» × \`${t.taskId}\`: ${x.reason.replace(/\n/g, ' ').slice(0, 160)}`);
  }
  lines.push('');
  lines.push(
    r.kind === 'context'
      ? '> الطريقة: نفس المهام ونفس الموديل ونفس نص التعليمات؛ الفرق الوحيد خيار وكيل واحد (مفعّل/معطّل). الحكم من محاسب مخفي لا من كلام الموديل — وافحص فرق التوكنات: الميزة التي لا تعوّض تكلفتها تُطفأ.'
      : '> الطريقة: نفس المهام ونفس الموديل ونفس الظروف؛ الفرق الوحيد نص التعليمات. الحكم من محاسب مخفي لا من كلام الموديل، والنتيجة بين نسختين قد تتذبذب — كرّر للموثوقية.',
  );
  return lines.join('\n');
}

export function abReportJson(r: AbReport): string {
  return JSON.stringify({ mode: r.mode, kind: r.kind, taskLabel: r.taskLabel, variants: r.variants, repeats: r.repeats, summary: r.summary, tasks: r.tasks, verdict: r.verdict }, null, 2);
}

/** قراءة نسخة تعليمات من ملف (أو نص مباشر) للاستخدام في A/B */
export async function readVariant(root: string, spec: string): Promise<AbVariant> {
  const clean = spec.trim();
  if (!clean) throw new Error('اكتب مسار ملف النسخة أو نصاً');
  const abs = path.isAbsolute(clean) ? clean : path.join(root, clean);
  try {
    const text = await fs.readFile(abs, 'utf8');
    return { label: path.basename(abs), text };
  } catch {
    // ليس ملفاً: نعتبره نصاً مباشراً (يُفيد في التجارب السريعة)
    return { label: clean.length > 24 ? `${clean.slice(0, 24)}…` : clean, text: clean };
  }
}
