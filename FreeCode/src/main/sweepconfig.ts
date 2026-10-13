// إعداد الجرد الدوري: ملف `.freecode/sweep.json` يصف الموديلات والمحاور مرة واحدة،
// فتصبح المهمة المجدولة أمراً واحداً بلا أعلام طويلة. وحدة مستقلة (بلا شبكة) لتُختبر.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { axisKind, axisReading, CONTEXT_AXES, type AxisSweepArchive, type ContextAxis } from './abtest';

export interface SweepConfig {
  /** أسماء موديلات، ويمكن لكل موديل أن يحمل عنوان خادمه: "model@http://host/v1" */
  models: string[];
  /** عنوان افتراضي لموديل بلا @ */
  baseUrl?: string;
  /** محاور الجرد (افتراضي: كل المحاور) */
  axes?: ContextAxis[];
  /** حجم المهمات: المجموعة السريعة أو البنك الكامل */
  tasks?: 'quick' | 'full';
  /** تكرارات لكل (موديل × محور): 1..3 */
  repeat?: number;
  /** مسار مشروع تُبنى منه المهام (اختياري — يقيس الخريطة على مشروعك) */
  fromProject?: string;
  /** أمر الفحص الحقيقي لمحور autoVerify (فارغ/غائب = اكتشاف تلقائي داخل كل مهمة) */
  verifyCommand?: string;
}

export const SWEEP_CONFIG_REL = ['.freecode', 'sweep.json'] as const;

export function sweepConfigPath(dir: string): string {
  return path.join(dir, ...SWEEP_CONFIG_REL);
}

/** قالب جاهز للكتابة بـ`--init-sweep` (يُكتب مرة واحدة ثم يُعدَّل يدوياً) */
export function sweepConfigTemplate(): string {
  return (
    JSON.stringify(
      {
        models: ['qwen2.5-coder:7b', 'llama3.1:8b'],
        baseUrl: 'http://127.0.0.1:31415/v1',
        axes: ['repoMap', 'autoVerify'],
        verifyCommand: '',
        tasks: 'quick',
        repeat: 1,
      },
      null,
      2,
    ) + '\n'
  );
}

/** يفحص كائن الإعداد ويعيد أخطاء عربية دقيقة (لا تخمين ولا تجاهل صامت) */
export function parseSweepConfig(raw: unknown): { config: SweepConfig | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, errors: ['ملف الإعداد ليس كائن JSON'] };
  }
  const o = raw as Record<string, unknown>;
  const models = Array.isArray(o.models) ? o.models.filter((m) => typeof m === 'string' && m.trim()).map((m) => String(m).trim()) : [];
  if (!models.length) errors.push('«models» مطلوب: قائمة بأسماء موديل واحد على الأقل');
  let axes: ContextAxis[] | undefined;
  if (o.axes !== undefined) {
    if (!Array.isArray(o.axes)) errors.push('«axes» يجب أن يكون قائمة');
    else {
      const known = CONTEXT_AXES.map((a) => a.axis);
      const bad = o.axes.filter((a) => !known.includes(a as ContextAxis));
      if (bad.length) errors.push(`محاور غير معروفة: ${bad.join(', ')} — المتاح: ${known.join(', ')}`);
      else axes = o.axes as ContextAxis[];
    }
  }
  let tasks: 'quick' | 'full' | undefined;
  if (o.tasks !== undefined) {
    if (o.tasks === 'quick' || o.tasks === 'full') tasks = o.tasks;
    else errors.push('«tasks» يقبل «quick» أو «full» فقط');
  }
  let repeat: number | undefined;
  if (o.repeat !== undefined) {
    const n = Number(o.repeat);
    if (!Number.isFinite(n) || n < 1 || n > 3) errors.push('«repeat» بين 1 و3');
    else repeat = Math.floor(n);
  }
  let baseUrl: string | undefined;
  if (o.baseUrl !== undefined) {
    if (typeof o.baseUrl !== 'string' || !o.baseUrl.trim()) errors.push('«baseUrl» يجب أن يكون نصاً غير فارغ');
    else baseUrl = o.baseUrl.trim();
  }
  let fromProject: string | undefined;
  if (o.fromProject !== undefined) {
    if (typeof o.fromProject !== 'string' || !o.fromProject.trim()) errors.push('«fromProject» يجب أن يكون مساراً نصياً');
    else fromProject = o.fromProject.trim();
  }
  let verifyCommand: string | undefined;
  if (o.verifyCommand !== undefined) {
    if (typeof o.verifyCommand !== 'string') errors.push('«verifyCommand» يجب أن يكون نصاً (اتركه فارغاً للاكتشاف التلقائي)');
    else if (o.verifyCommand.trim()) verifyCommand = o.verifyCommand.trim();
  }
  if (errors.length) return { config: null, errors };
  return { config: { models, baseUrl, axes, tasks, repeat, fromProject, verifyCommand }, errors };
}

/**
 * أولوية أمر الفحص لمحور autoVerify: عَلَم صريح ← إعداد الجرد ← المكتشف في المشروع.
 * `null` تعني «لا فحص متاح» — وهي إجابة صادقة تُستبعد بها المقارنة بدل قياس وهمي.
 */
export function pickVerifyCommand(
  explicit: string | undefined,
  fromConfig: string | undefined,
  detected: string[],
): { command: string | null; source: 'flag' | 'config' | 'detected' | null } {
  const pick = (v: string | undefined): string => (v ?? '').trim();
  if (pick(explicit)) return { command: pick(explicit), source: 'flag' };
  if (pick(fromConfig)) return { command: pick(fromConfig), source: 'config' };
  const det = detected.map(pick).find(Boolean);
  if (det) return { command: det, source: 'detected' };
  return { command: null, source: null };
}

/** وصف مقروء للإعداد الفعلي كما نُفِّذ (لا كما كُتب) — يُخزَّن مع كل جرد */
export function sweepSignature(parts: { models: string[]; axes: string[]; tasks: number; repeats: number }): string {
  return `${parts.models.length} موديل [${parts.models.join(', ')}] × ${parts.axes.join(',')} × ${parts.tasks} مهمة × ${parts.repeats} تكرار`;
}

/** بصمة قصيرة للإعداد الفعلي — تُقارن بين جردين لكشف «قبل/بعد» */
export function sweepConfigHash(parts: { models: string[]; axes: string[]; tasks: number; repeats: number }): string {
  return createHash('sha256').update(sweepSignature(parts)).digest('hex').slice(0, 12);
}

/** وصف عربي لمصدر أمر الفحص — يُطبع في مخرجات الجرد */
export function verifySourceLabel(source: 'flag' | 'config' | 'detected' | null): string {
  if (source === 'flag') return 'من --verify-cmd';
  if (source === 'config') return 'من إعداد الجرد (verifyCommand)';
  if (source === 'detected') return 'مكتشف من المشروع';
  return 'بلا أمر فحص';
}

/** يقرأ الإعداد من `.freecode/sweep.json` في مجلد المشروع */
export async function loadSweepConfig(dir: string): Promise<{ config: SweepConfig | null; file: string; errors: string[] }> {
  const file = sweepConfigPath(dir);
  let text = '';
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return { config: null, file, errors: [`لا يوجد ملف إعداد: ${file}`] };
  }
  try {
    const parsed = parseSweepConfig(JSON.parse(text));
    return { ...parsed, file };
  } catch (e: any) {
    return { config: null, file, errors: [`ملف الإعداد ليس JSON صالحاً: ${String(e?.message ?? e).slice(0, 120)}`] };
  }
}

/** مسار أرشيف الجرد المحفوظ داخل المشروع */
export function sweepArchivePath(dir: string): string {
  return path.join(dir, '.freecode', 'ctx-sweep.jsonl');
}

/** يقرأ جردات الأرشيف (الأقدم ← الأحدث) — الأسطر التالفة تُتجاهل بلا ضجيج */
export async function readSweepArchive(dir: string, limit = 20): Promise<AxisSweepArchive[]> {
  let text = '';
  try {
    text = await fs.readFile(sweepArchivePath(dir), 'utf8');
  } catch {
    return [];
  }
  const out: AxisSweepArchive[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AxisSweepArchive;
      if (e && typeof e.at === 'number' && Array.isArray(e.rows)) out.push(e);
    } catch {
      /* سطر تالف يُتجاهل */
    }
  }
  return out.slice(-limit);
}

/** سطر ملخص لجرد محفوظ — يُعرض في اللوحة وسجل الجرد (بلا جداول) */
export function sweepDigest(prev: AxisSweepArchive | null, last: AxisSweepArchive): { line: string; regressions: number; improvements: number } {
  const models = new Set(last.rows.map((r) => r.model)).size;
  const axes = [...new Set(last.rows.map((r) => r.axis))];
  const counts = new Map<string, number>();
  for (const r of last.rows) {
    const k = axisKind(r);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const k of ['مفيد', 'ضار', 'يكلّف بلا مكسب', 'يوفّر', 'بلا فرق']) {
    const n = counts.get(k);
    if (n) parts.push(`${k} ${n}`);
  }
  const when = new Date(last.at).toISOString().slice(0, 16).replace('T', ' ');
  let regressions = 0;
  let improvements = 0;
  if (prev) {
    for (const r of last.rows) {
      const p = prev.rows.find((x) => x.model === r.model && x.axis === r.axis);
      if (!p) continue;
      const dp = r.deltaPassed - p.deltaPassed;
      if (dp < 0) regressions++;
      if (dp > 0) improvements++;
    }
  }
  const hashChanged = !!prev && !!prev.configHash && !!last.configHash && prev.configHash !== last.configHash;
  const cmp = !prev
    ? ' · بلا جرد سابق للمقارنة'
    : regressions
      ? ` · ⚠️ انحدار في ${regressions} صفاً منذ الجرد السابق`
      : improvements
        ? ` · ✅ تحسّن في ${improvements} صفاً منذ الجرد السابق`
        : ' · لا تغيّر جوهري منذ الجرد السابق';
  return {
    line: `آخر جرد ${when} · ${models} موديل × ${axes.length} محور · ${last.rows.length} صفاً: ${parts.join(' · ')}${cmp}${hashChanged ? ' · 🧩 تغيّر الإعداد' : ''}`,
    regressions,
    improvements,
  };
}

// ---------------- السلسلة الزمنية: كل الجردات المحفوظة لا آخر جرد فقط ----------------
// الحاجة: «هل هذا الموديل يتراجع عبر الزمن أم تذبذبة واحدة؟» سؤال لا يجيب عنه آخر
// جرد. هنا نُجمِّع كل الأرشيف في سلسلة لكل (موديل × محور): نقاط الفرق الزمنية،
// أسوأ تراجع، تصنيف الاتجاه، وأحداث الانحدار مع نسبة كل حدث إلى تغيّر الإعداد أو الموديل.

export interface SweepTimelinePoint {
  at: number;
  deltaPassed: number;
  tokenSavingPct: number;
}

export interface SweepTimelineRow {
  model: string;
  axis: string;
  points: SweepTimelinePoint[];
  first: number;
  last: number;
  /** أكبر تراجع بين جردين متتاليين (سالب أو صفر) */
  worstDrop: number;
  worstDropAt: number;
  trend: 'تحسّن' | 'تراجع' | 'متذبذب' | 'ثابت';
}

export interface SweepRegressionEvent {
  at: number;
  model: string;
  axis: string;
  from: number;
  to: number;
  drop: number;
  tokensDelta: number;
  /** هل تزامن الحدث مع تغيّر إعداد الجرد؟ (نسبة السبب لا تخمينه) */
  configChanged: boolean;
}

export interface SweepTimeline {
  runs: number;
  from: number;
  to: number;
  rows: SweepTimelineRow[];
  events: SweepRegressionEvent[];
  improvements: number;
  configChanges: number[];
}

const trendOf = (points: number[]): SweepTimelineRow['trend'] => {
  if (points.length < 2) return 'ثابت';
  const min = Math.min(...points);
  const max = Math.max(...points);
  if (min === max) return 'ثابت';
  const nonDecreasing = points.every((p, i) => i === 0 || p >= points[i - 1]);
  const nonIncreasing = points.every((p, i) => i === 0 || p <= points[i - 1]);
  if (nonDecreasing) return 'تحسّن';
  if (nonIncreasing) return 'تراجع';
  return 'متذبذب';
};

/** يبني السلسلة الزمنية من كل الجردات المحفوظة (الأقدم ← الأحدث) */
export function sweepTimeline(archive: AxisSweepArchive[]): SweepTimeline | null {
  const runs = (archive ?? []).filter((a) => a && typeof a.at === 'number' && Array.isArray(a.rows));
  if (!runs.length) return null;
  const rows = new Map<string, SweepTimelineRow>();
  const events: SweepRegressionEvent[] = [];
  const configChanges: number[] = [];
  let improvements = 0;
  let prevHash: string | undefined;
  for (const entry of runs) {
    const changed = prevHash !== undefined && !!entry.configHash && prevHash !== entry.configHash;
    if (changed) configChanges.push(entry.at);
    for (const r of entry.rows) {
      const key = `${r.model}::${r.axis}`;
      let row = rows.get(key);
      if (!row) {
        row = { model: r.model, axis: r.axis, points: [], first: r.deltaPassed, last: r.deltaPassed, worstDrop: 0, worstDropAt: 0, trend: 'ثابت' };
        rows.set(key, row);
      }
      const before = row.points[row.points.length - 1];
      row.points.push({ at: entry.at, deltaPassed: r.deltaPassed, tokenSavingPct: r.tokenSavingPct });
      if (before) {
        const drop = r.deltaPassed - before.deltaPassed;
        if (drop < 0) {
          events.push({
            at: entry.at,
            model: r.model,
            axis: r.axis,
            from: before.deltaPassed,
            to: r.deltaPassed,
            drop,
            tokensDelta: r.tokenSavingPct - before.tokenSavingPct,
            configChanged: changed,
          });
          if (drop < row.worstDrop) {
            row.worstDrop = drop;
            row.worstDropAt = entry.at;
          }
        } else if (drop > 0) improvements++;
      }
      row.last = r.deltaPassed;
    }
    if (entry.configHash) prevHash = entry.configHash;
  }
  for (const row of rows.values()) row.trend = trendOf(row.points.map((p) => p.deltaPassed));
  const list = [...rows.values()].sort((a, b) => a.worstDrop - b.worstDrop || b.points.length - a.points.length || a.model.localeCompare(b.model));
  return {
    runs: runs.length,
    from: runs[0].at,
    to: runs[runs.length - 1].at,
    rows: list,
    events,
    improvements,
    configChanges,
  };
}

const stampOf = (at: number): string => new Date(at).toISOString().slice(0, 16).replace('T', ' ');

/** قسم ماركداون للسلسلة الزمنية — يُطبع في الطرفية وفي اللوحة وفي التقرير الدوري */
export function formatSweepTimeline(tl: SweepTimeline, opts: { limit?: number; omitHeading?: boolean } = {}): string {
  const lines: string[] = [];
  const limit = Math.max(1, opts.limit ?? 8);
  if (opts.omitHeading) {
    lines.push(`_${tl.runs} جردات محفوظة · ${stampOf(tl.from)} ← ${stampOf(tl.to)} · انحدارات مرصودة: ${tl.events.length}${tl.configChanges.length ? ` · تغيّر الإعداد ${tl.configChanges.length}` : ''}_`);
  } else {
    lines.push(`#### سلسلة الانحدارات (${tl.runs} جردات · ${stampOf(tl.from)} ← ${stampOf(tl.to)})`);
  }
  lines.push('');
  if (tl.runs < 2) {
    lines.push('جرد واحد محفوظ فقط — لا سلسلة بعد (تبدأ السلسلة من الجرد الثاني فصاعداً).');
    lines.push('');
  }
  lines.push('| الموديل | المحور | السلسلة (الأقدم ← الأحدث) | الاتجاه | أسوأ تراجع | آخر قراءة |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of tl.rows.slice(0, limit)) {
    const series = r.points.map((p) => `${p.deltaPassed > 0 ? '+' : ''}${p.deltaPassed}`).join(' → ');
    const drop = r.worstDrop < 0 ? `−${Math.abs(r.worstDrop)} (${stampOf(r.worstDropAt)})` : '—';
    const lastPoint = r.points[r.points.length - 1];
    lines.push(`| ${r.model} | ${r.axis} | ${series} | ${r.trend} | ${drop} | ${axisReading(lastPoint.deltaPassed, lastPoint.tokenSavingPct)} |`);
  }
  if (tl.rows.length > limit) lines.push(`| … | … | (${tl.rows.length - limit} صفاً آخر) | | | |`);
  lines.push('');
  if (tl.events.length) {
    lines.push(`**انحدارات مرصودة (${tl.events.length}):**`);
    lines.push('');
    for (const e of tl.events.slice(-limit)) {
      const tk = e.tokensDelta ? ` · Δتوكنات ${e.tokensDelta > 0 ? '+' : ''}${e.tokensDelta}` : '';
      lines.push(`- ⚠️ ${stampOf(e.at)} · ${e.model}/${e.axis}: ${e.from > 0 ? '+' : ''}${e.from} ← ${e.to} (تراجع ${Math.abs(e.drop)})${tk}${e.configChanged ? ' — 🧩 تزامن مع تغيّر إعداد الجرد' : ''}`);
    }
  } else {
    lines.push('> لا انحدار في السلسلة المحفوظة — كل الفروق ثابتة أو متحسّنة.');
  }
  if (tl.improvements) lines.push('', `> ✅ ${tl.improvements} تحسّن مسجّل في السلسلة.`);
  if (tl.configChanges.length) {
    lines.push('', `> 🧩 تغيّر إعداد الجرد ${tl.configChanges.length} مرة داخل السلسلة — الصفوف التي تحرّكت عندها قد تعكس الإعداد لا الموديل.`);
  }
  return lines.join('\n');
}
