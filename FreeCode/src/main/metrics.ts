// لوحة القياس: تجمع «الموثوقية» و«تقييم الموديلات» في مكان واحد داخل التطبيق،
// مع اتجاه زمني بالأرقام وقراءة عملية («ما العمل؟») لا مجرد رسوم.
//
// كل البيانات محلية: سجل telemetry.jsonl + سجل تقييمات eval-history.jsonl في مجلد
// بيانات المستخدم. لا يُرسل أي شيء إلى أي جهة، ولا يحتاج الملف أي اتصال شبكي.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { envFailureReason, envFixHint, summarizeTelemetry, type ReliabilitySummary, type TelemetryEvent } from './telemetry';
import type { AxisSweepArchive } from './abtest';
import { formatSweepTimeline, sweepDigest, sweepTimeline, type SweepTimeline } from './sweepconfig';

export interface EvalHistoryModel {
  label: string;
  passed: number;
  total: number;
  tokens: number;
  stepsPerPass: number;
}

export interface EvalHistoryEntry {
  /** زمن التنفيذ (ms) */
  at: number;
  /** عدد المهام التي جُرّبت */
  tasks: number;
  /** هل كانت المجموعة السريعة */
  quick: boolean;
  models: EvalHistoryModel[];
  /** الموديل الأفضل في هذه الجولة (فارغ إن لم ينجح أحد) */
  best: string;
  bestRate: number;
}

export interface FailedTool {
  name: string;
  count: number;
}

export interface DashboardData {
  reliability: ReliabilitySummary;
  /** آخر N دورة: 1 نجحت · 0 فشلت/لم تكتمل — لرسم الاتجاه */
  trend: number[];
  failedTools: FailedTool[];
  history: EvalHistoryEntry[];
  /** إحصاءات سريعة عن سجل التقييم */
  evalRuns: number;
  /** أعطال موسومة بيئية (لا تُصلح بالكود) مع خطوة الإصلاح المقترحة */
  envFailures: { reason: string; fix: string; count: number; sample: string }[];
  insights: string[];
  /** آخر جرد محاور سياق محفوظ (اختياري — يُقرأ من .freecode/ctx-sweep.jsonl) */
  sweep?: { line: string; regressions: number; improvements: number; runs: number } | null;
  /** السلسلة الزمنية لكل (موديل × محور) عبر كل الجردات المحفوظة (اختياري) */
  sweepTimeline?: SweepTimeline | null;
}

// ---------- سجل تقييم الموديلات (JSONL) ----------

export function evalHistoryFile(dir: string): string {
  return path.join(dir, 'eval-history.jsonl');
}

/** يضيف جولة تقييم إلى السجل المحلي (يُستدعى بعد كل /models-eval) */
export async function appendEvalHistory(dir: string, entry: EvalHistoryEntry): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(evalHistoryFile(dir), JSON.stringify(entry) + '\n', 'utf8');
    await trimEvalHistory(dir);
  } catch {
    /* السجل كمالي: لا نُفشل التقييم بسببه */
  }
}

async function trimEvalHistory(dir: string, cap = 60): Promise<void> {
  try {
    const file = evalHistoryFile(dir);
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n').filter((l) => l.trim());
    if (lines.length <= cap) return;
    await fs.writeFile(file, lines.slice(-cap).join('\n') + '\n', 'utf8');
  } catch {
    /* تجاهل */
  }
}

export async function readEvalHistory(dir: string, limit = 20): Promise<EvalHistoryEntry[]> {
  let text = '';
  try {
    text = await fs.readFile(evalHistoryFile(dir), 'utf8');
  } catch {
    return [];
  }
  const out: EvalHistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as EvalHistoryEntry;
      if (!e || typeof e.at !== 'number' || !Array.isArray(e.models)) continue;
      out.push(e);
    } catch {
      /* سطر تالف يُتجاهل */
    }
  }
  return out.slice(-limit);
}

/** يجمع الأعطال الموسومة بيئياً من السجل (نفس وسم telemetry) */
function envFailuresFromEvents(events: TelemetryEvent[]): { reason: string; fix: string; count: number; sample: string }[] {
  const map = new Map<string, { reason: string; fix: string; count: number; sample: string }>();
  for (const e of events) {
    const text = e.kind === 'tool_error'
      ? String((e as any).message ?? '')
      : e.kind === 'verify'
        ? String((e as any).summary ?? '')
        : '';
    if (!text) continue;
    const reason = envFailureReason(text);
    if (!reason) continue;
    const cur = map.get(reason) ?? { reason, fix: envFixHint(reason), count: 0, sample: text.split('\n')[0].slice(0, 120) };
    cur.count++;
    map.set(reason, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

// ---------- بناء اللوحة ----------

/** عدد الأشرطة في الاتجاه الزمني */
export const TREND_WIDTH = 24;

export function buildDashboard(opts: { events: TelemetryEvent[]; history: EvalHistoryEntry[]; sweeps?: AxisSweepArchive[] }): DashboardData {
  const reliability = summarizeTelemetry(opts.events);
  const turns = opts.events.filter((e) => e.kind === 'turn');
  const trend = turns
    .slice(-TREND_WIDTH)
    .map((t) => (t.ok === true ? 1 : 0));
  const failedTools = reliability.topErrors.map((e) => ({ name: e.name, count: e.count }));
  const data: DashboardData = {
    reliability,
    trend,
    failedTools,
    history: opts.history,
    evalRuns: opts.history.length,
    envFailures: envFailuresFromEvents(opts.events),
    insights: [],
    sweep: null,
  };
  const sw = opts.sweeps ?? [];
  if (sw.length) {
    const last = sw[sw.length - 1];
    const prev = sw.length > 1 ? sw[sw.length - 2] : null;
    const d = sweepDigest(prev, last);
    data.sweep = { ...d, runs: sw.length };
    data.sweepTimeline = sweepTimeline(sw);
  }
  data.insights = dashboardInsights(data);
  return data;
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** خط اتجاه نصي من قيم ثنائية/نِسَب (يعمل في الطرفية وفي الواجهة بلا رسوم خارجية) */
export function sparkline(values: number[], level = BLOCKS): string {
  if (!values.length) return '(لا بيانات بعد)';
  const max = Math.max(...values, 1);
  return values.map((v) => level[Math.min(level.length - 1, Math.max(0, Math.round((v / max) * (level.length - 1))))]).join('');
}

function pct(a: number, b: number): string {
  if (!b) return '—';
  return `${Math.round((a / b) * 100)}%`;
}

function when(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** قراءة الأرقام: كل سطر يربط رقماً بإجراء عملي */
export function dashboardInsights(d: DashboardData): string[] {
  const s = d.reliability;
  const out: string[] = [];
  if (!s.turns) {
    out.push('لا دورات مسجّلة بعد — نفّذ مهمة واحدة على الأقل ليبدأ القياس.');
    return out;
  }
  const okRate = s.okTurns / s.turns;
  if (okRate >= 0.8) out.push(`معدل نجاح الدورات ${pct(s.okTurns, s.turns)} — مستوى جيد، المشكلة إن وُجدت فهي في التفاصيل لا في الأساس.`);
  else if (okRate >= 0.5) out.push(`معدل نجاح الدورات ${pct(s.okTurns, s.turns)} — متوسط: راجع «أكثر الأدوات فشلاً» فالإصلاح هناك يرفعه سريعاً.`);
  else out.push(`معدل نجاح الدورات ${pct(s.okTurns, s.turns)} — منخفض: جرّب موديلاً أقوى بـ/models-eval، وفعّل /diagnostics fix لتحليل الأعطال.`);

  if (s.incompleteTurns > 0) out.push(`${s.incompleteTurns} دورة لم تكتمل (سقف الخطوات أو إيقاف) — ارفع سقف الخطوات أو قسّم المهمة إلى أصغر.`);
  if (s.edits) {
    const fuzzy = s.fuzzyEdits / s.edits;
    if (fuzzy > 0.4) out.push(`المطابقة المتسامحة ${pct(s.fuzzyEdits, s.edits)} من التعديلات — النموذج يخطئ في نسخ «النص القديم»؛ اطلب منه قراءة الملف قبل التعديل (أو استخدم ملفات أصغر).`);
    else if (fuzzy > 0) out.push(`المطابقة المتسامحة ${pct(s.fuzzyEdits, s.edits)} — معدل مقبول.`);
  }
  if (s.verifyRuns) {
    const vf = s.verifyFailed / s.verifyRuns;
    if (vf > 0.3) out.push(`الفحص التلقائي كشف مشاكل في ${pct(s.verifyFailed, s.verifyRuns)} من المرات — إن كان السبب ملفات مشروعك فاضبط أمر الفحص، وإلا فالنموذج يحتاج خطوات تحقق أكثر.`);
  }
  const asked = s.approvalsAsked;
  if (asked >= 10) out.push(`طُلبت منك ${asked} موافقة — قلّل النقرات بزر «كل تعديلات هذا الملف» أو بقاعدة allow لأمر تثق به.`);
  if (s.retries > 0) out.push(`${s.retries} إعادة محاولة للمزوّد — ضغط على الخادم أو انقطاعات؛ إن تكرّرت قلّل الموديلات المتوازية.`);
  if (d.failedTools.length) out.push(`أكثر أداة تفشل: ${d.failedTools[0].name} (${d.failedTools[0].count} مرة) — راجع «أسباب الفشل» في /diagnostics.`);
  if (d.evalRuns >= 2) {
    const latest = d.history[d.history.length - 1];
    const prev = d.history[d.history.length - 2];
    if (latest.best && prev.best && latest.best !== prev.best) out.push(`تغيّر المتصدّر بين الجولتين: «${prev.best}» ← «${latest.best}» — الفرق قد يكون داخل هامش التذبذب، أعِد التقييم لتأكيده.`);
    else if (latest.best) out.push(`المتصدّر في آخر جولة تقييم: «${latest.best}» (${latest.bestRate}% نجاح) — والأرقام الكاملة في جدول التقييم أدناه.`);
  } else if (!d.evalRuns) {
    out.push('لم تُجرِّب تقييم الموديلات بعد — /models-eval يقيس موديلاتك على 14 مهمة كود حقيقية ويعطيك توصية بالأرقام.');
  }
  out.push(`زمن الدورة: وسيط ${(s.p50TurnMs / 1000).toFixed(1)}ث · الشريحة 95% ${(s.p95TurnMs / 1000).toFixed(1)}ث · متوسط ${s.tokensPerTurn} توكن/دورة.`);
  return out;
}

/** تقرير اللوحة (Markdown عربي) — يُعرض في المحادثة أو يُصدَّر لملف */
export function formatDashboard(d: DashboardData, opts: { workspace?: string } = {}): string {
  const s = d.reliability;
  const lines: string[] = [];
  lines.push(`### لوحة القياس — الموثوقية والتقييم معاً`);
  if (opts.workspace) lines.push(`_المشروع: ${opts.workspace}_`);
  lines.push('');

  let sec = 0;
  const nextSec = (): string => `#### ${['١', '٢', '٣', '٤', '٥', '٦', '٧', '٨'][sec++] ?? String(sec)})`;

  // قسم الجرد المحفوظ مستقل عن سجل دورات الوكيل: يُعرض حتى في مشروع لم يُشغَّل فيه الوكيل بعد
  const sweepBlock = (): string[] => {
    if (!d.sweep) return [];
    const out: string[] = [];
    out.push(`${nextSec()} جرد محاور السياق (المحفوظ)`);
    out.push('');
    out.push(`- ${d.sweep.line}`);
    out.push(`- الجردات المحفوظة: ${d.sweep.runs} · لقياس جديد: \`freecode-eval --ctx-sweep --save\` ثم \`--compare\``);
    if (d.sweep.regressions) out.push('- ⚠️ يوجد انحدار منذ الجرد السابق — راجع الموديل/الإعداد قبل الاعتماد على أرقامه.');
    out.push('');
    if (d.sweepTimeline) {
      out.push(`${nextSec()} سلسلة الانحدارات عبر الجردات`);
      out.push('');
      out.push(formatSweepTimeline(d.sweepTimeline, { limit: 6, omitHeading: true }));
      out.push('');
    }
    return out;
  };

  if (!s.turns) {
    lines.push('لا دورات مسجّلة بعد في هذا الجهاز. نفّذ مهمة واحدة ثم افتح اللوحة مرة أخرى.');
    lines.push('');
    lines.push(...sweepBlock());
    lines.push('> كل الأرقام محلية من سجلك أنت. لا يُرسل شيء لأي جهة.');
    return lines.join('\n');
  }
  lines.push(`${nextSec()} الدورات (آخر ${s.turns})`);
  lines.push('');
  lines.push('| المؤشر | القيمة | قراءة سريعة |');
  lines.push('|---|---|---|');
  lines.push(`| الدورات الناجحة | ${s.okTurns}/${s.turns} (${pct(s.okTurns, s.turns)}) | ${s.failedTurns ? `${s.failedTurns} فاشلة` : 'بلا فشل'} |`);
  lines.push(`| دورات لم تكتمل | ${s.incompleteTurns} | ${s.incompleteTurns ? 'سقف خطوات أو إيقاف' : 'لا شيء'} |`);
  lines.push(`| التعديلات | ${s.edits} | مطابقة تامة ${pct(s.exactEdits, s.edits)} · متسامحة ${pct(s.fuzzyEdits, s.edits)} |`);
  lines.push(`| التحقق التلقائي | ${s.verifyRuns} | كشف مشاكل ${s.verifyFailed} (${pct(s.verifyFailed, s.verifyRuns)}) |`);
  lines.push(`| الموافقات | طُلبت ${s.approvalsAsked} | رُفضت ${s.approvalsDenied} · دفعةً واحدة ${s.approvalsBulk} |`);
  lines.push(`| أخطاء الأدوات | ${s.toolErrors} | إعادات مزوّد ${s.retries} |`);
  lines.push(`| الزمن | وسيط ${(s.p50TurnMs / 1000).toFixed(1)}ث | شريحة 95% ${(s.p95TurnMs / 1000).toFixed(1)}ث |`);
  lines.push('');

  lines.push(`${nextSec()} اتجاه الدورات (الأقدم ← الأحدث)`);
  lines.push('');
  lines.push('```');
  lines.push(sparkline(d.trend));
  lines.push('```');
  lines.push(`كل مربع دورة واحدة: الأعلى = نجحت، الأدنى = لم تنجح. (آخر ${d.trend.length} دورة)`);
  lines.push('');

  if (d.failedTools.length) {
    lines.push(`${nextSec()} أكثر الأدوات فشلاً`);
    lines.push('');
    lines.push('| الأداة | مرات الفشل |');
    lines.push('|---|---|');
    for (const t of d.failedTools) lines.push(`| ${t.name} | ${t.count} |`);
    lines.push('');
  }

  const hasEnv = d.envFailures.length > 0;
  if (hasEnv) {
    lines.push(`${nextSec()} 🌐 أعطال بيئية (لا تُصلح بالكود)`);
    lines.push('');
    lines.push('| السبب | مرات | خطوة الإصلاح المقترحة |');
    lines.push('|---|---|---|');
    for (const f of d.envFailures) lines.push(`| ${f.reason} | ${f.count} | ${f.fix} |`);
    lines.push('');
    lines.push('> هذه أعطال سببها بيئة الجهاز (أداة ناقصة/صلاحية/منفذ/شبكة) لا ملفات المشروع — تُعالَج على الجهاز نفسه، ولا تُدرَج في قائمة «أصلح بالكود».');
    lines.push('');
  }

  lines.push(`${nextSec()} تاريخ تقييم الموديلات`);
  lines.push('');
  if (!d.history.length) {
    lines.push('لم تُسجَّل جولة تقييم بعد. شغّل `/models-eval` (أو `freecode-eval`) وستظهر النتائج هنا للمقارنة عبر الزمن.');
  } else {
    lines.push('| متى | المهام | الموديلات | المتصدّر | نسبة المتصدّر |');
    lines.push('|---|---|---|---|---|');
    for (const h of d.history.slice(-8)) {
      const labels = h.models.map((m) => `${m.label} (${m.passed}/${m.total})`).join(' · ');
      lines.push(`| ${when(h.at)} | ${h.tasks}${h.quick ? ' (سريعة)' : ''} | ${labels} | ${h.best || '—'} | ${h.best ? `${h.bestRate}%` : '—'} |`);
    }
    const bestRuns = d.history.filter((h) => h.best).map((h) => h.bestRate);
    if (bestRuns.length >= 2) {
      lines.push('');
      lines.push('```');
      lines.push(sparkline(bestRuns));
      lines.push('```');
      lines.push('اتجاه نسبة نجاح المتصدّر عبر الجولات (الأقدم ← الأحدث) — يظهر أثر تحسين نص المهام أو تغيير الموديل.');
    }
  }
  lines.push('');

  lines.push(...sweepBlock());

  lines.push(`${nextSec()} قراءة الأرقام — ما العمل؟`);
  lines.push('');
  for (const tip of d.insights) lines.push(`- ${tip}`);
  lines.push('');
  lines.push('> هذه اللوحة تُبنى من سجلين محليين: `telemetry.jsonl` و`eval-history.jsonl` في مجلد بيانات FreeCode. لا شبكة ولا إرسال.');
  return lines.join('\n');
}

/** ما يُقال ويُبلَّغ بعد «جرد الآن» — الإشعار لا يُرسل إلا عند انحدار حقيقي */
export function sweepRunNotice(d: { line: string; regressions: number; improvements: number }): {
  notify: boolean;
  kind: 'regression' | 'improvement' | 'flat';
  title: string;
  body: string;
} {
  if (d.regressions > 0)
    return { notify: true, kind: 'regression', title: `⚠️ انحدار في ${d.regressions} صفاً — جرد محاور السياق`, body: d.line };
  if (d.improvements > 0)
    return { notify: false, kind: 'improvement', title: `✅ تحسّن في ${d.improvements} صفاً — جرد محاور السياق`, body: d.line };
  return { notify: false, kind: 'flat', title: 'جرد محاور السياق', body: d.line };
}

export function dashboardJson(d: DashboardData): string {
  return JSON.stringify(
    {
      reliability: d.reliability,
      trend: d.trend,
      failedTools: d.failedTools,
      envFailures: d.envFailures,
      sweep: d.sweep,
      sweepTimeline: d.sweepTimeline
        ? {
            runs: d.sweepTimeline.runs,
            from: d.sweepTimeline.from,
            to: d.sweepTimeline.to,
            regressions: d.sweepTimeline.events.length,
            improvements: d.sweepTimeline.improvements,
            configChanges: d.sweepTimeline.configChanges.length,
            rows: d.sweepTimeline.rows.map((r) => ({
              model: r.model,
              axis: r.axis,
              series: r.points.map((p) => p.deltaPassed),
              trend: r.trend,
              worstDrop: r.worstDrop,
            })),
          }
        : null,
      evalRuns: d.evalRuns,
      history: d.history,
      insights: d.insights,
    },
    null,
    2,
  );
}

/** وصف عربي مختصر لسطر حالة واحد (يُستخدم في شريط الحالة) */
export function dashboardLine(d: DashboardData): string {
  const s = d.reliability;
  if (!s.turns) return 'لا قياسات بعد — نفّذ مهمة ثم /dashboard';
  const env = d.envFailures.reduce((a, f) => a + f.count, 0);
  return `دورات ${s.okTurns}/${s.turns} · تعديلات متسامحة ${pct(s.fuzzyEdits, s.edits)} · موافقات ${s.approvalsAsked} · جولات تقييم ${d.evalRuns}${env ? ` · أعطال بيئية ${env}` : ''}`;
}
