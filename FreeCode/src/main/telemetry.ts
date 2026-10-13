import { promises as fs } from 'node:fs';

/**
 * قياس الموثوقية: سجل محلي (JSONL) لأحداث الدورة + مُلخِّص عربي.
 *
 * الفكرة أن نعرف بالأرقام — لا بالانطباع — أين يفشل الوكيل فعلاً:
 * نسبة التعديلات التي احتاجت مطابقة متسامحة، نسبة دورات انتهت بخطأ تحقق،
 * أكثر الأدوات فشلاً، عدد الموافقات المطلوبة من المستخدم في الدورة، وأزمنة الدورات.
 * لا يُرسل أي شيء إلى أي مكان: الملف محلي في مجلد بيانات المستخدم فقط.
 */

export type TelemetryKind = 'turn' | 'edit' | 'tool_error' | 'verify' | 'approval' | 'limit' | 'retry';

export interface TelemetryEvent {
  t: number;
  kind: TelemetryKind;
  [key: string]: unknown;
}

export interface TelemetrySink {
  record(e: Omit<TelemetryEvent, 't'> & { t?: number }): void;
}

/** سجل في الذاكرة مع كتابة كسولة على القرص (لا يعطّل العمل أبداً) */
export class Telemetry implements TelemetrySink {
  events: TelemetryEvent[] = [];
  private queue: string[] = [];
  private flushing = false;

  constructor(
    private file?: string,
    private cap = 5000,
  ) {}

  record(e: Omit<TelemetryEvent, 't'> & { t?: number }): void {
    const ev: TelemetryEvent = { t: e.t ?? Date.now(), ...e } as TelemetryEvent;
    this.events.push(ev);
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
    if (this.file) {
      this.queue.push(JSON.stringify(ev));
      void this.flush();
    }
  }

  /** ينتهي عندما تُكتب كل الأحداث في الملف (للاختبارات والإغلاق النظيف) */
  async flushNow(): Promise<void> {
    while (this.queue.length || this.flushing) {
      await this.flush();
      if (!this.flushing && !this.queue.length) break;
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || !this.file || !this.queue.length) return;
    this.flushing = true;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      await fs.mkdir(this.file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
      await fs.appendFile(this.file, batch.join('\n') + '\n', 'utf8');
      await this.trim();
    } catch {
      /* القياس تحسين لا شرط: لا نُفشل العمل بسببه */
    } finally {
      this.flushing = false;
      if (this.queue.length) void this.flush();
    }
  }

  /** يبقي آخر `cap` سطراً فقط فلا ينمو الملف بلا حد */
  private async trim(): Promise<void> {
    const s = this;
    return s.trimInner();
  }

  private async trimInner(): Promise<void> {
    try {
      const st = await fs.stat(this.file!);
      if (st.size < 2_000_000) return;
      const all = (await fs.readFile(this.file!, 'utf8')).split('\n').filter(Boolean);
      await fs.writeFile(this.file!, all.slice(-this.cap).join('\n') + '\n', 'utf8');
    } catch {
      /* تجاهل */
    }
  }

  /** يقرأ سجلاً من القرص (يتجاهل الأسطر التالفة) */
  static async load(file: string, limit = 5000): Promise<TelemetryEvent[]> {
    try {
      const text = await fs.readFile(file, 'utf8');
      const out: TelemetryEvent[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e && typeof e.kind === 'string') out.push(e as TelemetryEvent);
        } catch {
          /* سطر تالف */
        }
      }
      return out.slice(-limit);
    } catch {
      return [];
    }
  }

  async clear(): Promise<void> {
    this.events = [];
    if (this.file) await fs.writeFile(this.file, '', 'utf8').catch(() => {});
  }
}

// ---------- تلخيص ----------

export interface ReliabilitySummary {
  turns: number;
  okTurns: number;
  failedTurns: number;
  /** دورات لم تُكمل (توقفت عند سقف الخطوات أو أُجهضت) */
  incompleteTurns: number;
  steps: number;
  tokens: number;
  /** متوسط التوكنات في الدورة */
  tokensPerTurn: number;
  edits: number;
  exactEdits: number;
  /** تعديلات احتاجت مطابقة متسامحة (نهايات أسطر/مسافات/إزاحة) */
  fuzzyEdits: number;
  verifyRuns: number;
  verifyFailed: number;
  approvalsAsked: number;
  approvalsDenied: number;
  /** موافقات مُنحت لمجلد/دورة كاملة بدل نقرة لكل أداة */
  approvalsBulk: number;
  toolErrors: number;
  topErrors: { name: string; count: number }[];
  retries: number;
  p50TurnMs: number;
  p95TurnMs: number;
  /** أول وآخر حدث في السجل */
  from: number;
  to: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

export function summarizeTelemetry(events: TelemetryEvent[]): ReliabilitySummary {
  const s: ReliabilitySummary = {
    turns: 0,
    okTurns: 0,
    failedTurns: 0,
    incompleteTurns: 0,
    steps: 0,
    tokens: 0,
    tokensPerTurn: 0,
    edits: 0,
    exactEdits: 0,
    fuzzyEdits: 0,
    verifyRuns: 0,
    verifyFailed: 0,
    approvalsAsked: 0,
    approvalsDenied: 0,
    approvalsBulk: 0,
    toolErrors: 0,
    topErrors: [],
    retries: 0,
    p50TurnMs: 0,
    p95TurnMs: 0,
    from: 0,
    to: 0,
  };
  const errCount = new Map<string, number>();
  const durations: number[] = [];
  for (const e of events) {
    if (!s.from || e.t < s.from) s.from = e.t;
    if (e.t > s.to) s.to = e.t;
    if (e.kind === 'turn') {
      s.turns++;
      const ok = e.ok === true;
      if (ok) s.okTurns++;
      else s.failedTurns++;
      if (e.outcome === 'limit' || e.outcome === 'aborted') s.incompleteTurns++;
      s.steps += Number(e.steps ?? 0);
      s.tokens += Number(e.tokens ?? 0);
      if (typeof e.durationMs === 'number') durations.push(e.durationMs);
    } else if (e.kind === 'edit') {
      s.edits++;
      if (e.strategy === 'exact') s.exactEdits++;
      else s.fuzzyEdits++;
    } else if (e.kind === 'verify') {
      s.verifyRuns++;
      if (e.ok !== true) s.verifyFailed++;
    } else if (e.kind === 'approval') {
      if (e.decision === 'deny') s.approvalsDenied++;
      else {
        s.approvalsAsked++;
        if (e.decision === 'turn' || e.decision === 'file') s.approvalsBulk++;
      }
    } else if (e.kind === 'tool_error') {
      s.toolErrors++;
      const n = String(e.name ?? 'غير معروف');
      errCount.set(n, (errCount.get(n) ?? 0) + 1);
    } else if (e.kind === 'retry') {
      s.retries++;
    }
  }
  s.topErrors = [...errCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
  durations.sort((a, b) => a - b);
  s.p50TurnMs = percentile(durations, 50);
  s.p95TurnMs = percentile(durations, 95);
  s.tokensPerTurn = s.turns ? Math.round(s.tokens / s.turns) : 0;
  return s;
}

function pct(a: number, b: number): string {
  if (!b) return '—';
  return `${Math.round((a / b) * 100)}%`;
}

/** تقرير عربي موجز يُعرض في `/reliability` */
export function formatReliability(s: ReliabilitySummary): string {
  if (!s.turns) {
    return 'لا قياسات بعد. نفّذ مهمة أو مهمتين ثم اطلب /reliability مرة أخرى (القياس محلي في جهازك فقط).';
  }
  const lines = [
    `قياس الموثوقية (آخر ${s.turns} دورة):`,
    `• الدورات: ${s.turns} — نجحت ${s.okTurns} (${pct(s.okTurns, s.turns)}) · فشلت ${s.failedTurns} · لم تكتمل (سقف الخطوات/إيقاف) ${s.incompleteTurns}`,
    `• التعديلات: ${s.edits} — مطابقة تامة ${pct(s.exactEdits, s.edits)} · مطابقة متسامحة ${pct(s.fuzzyEdits, s.edits)}`,
    `• التحقق التلقائي: ${s.verifyRuns} مرة، كشف مشاكل في ${s.verifyFailed} (${pct(s.verifyFailed, s.verifyRuns)})`,
    `• الموافقات: طُلبت ${s.approvalsAsked} · رُفضت ${s.approvalsDenied} · مُنحت دفعةً واحدة (دورة/ملف) ${s.approvalsBulk}`,
    `• أخطاء الأدوات: ${s.toolErrors} · إعادات محاولة المزود: ${s.retries}`,
    `• الزمن: وسيط الدورة ${(s.p50TurnMs / 1000).toFixed(1)}ث · الشريحة 95% ${(s.p95TurnMs / 1000).toFixed(1)}ث · متوسط ${s.tokensPerTurn} توكن/دورة`,
  ];
  if (s.topErrors.length) lines.push(`• أكثر الأدوات فشلاً: ${s.topErrors.map((e) => `${e.name} (${e.count})`).join(' · ')}`);
  lines.push('• التفسير: ارتفاع «المطابقة المتسامحة» يعني أن النموذج يخطئ في نسخ النص القديم — وهو مقبول ما لم يقترب من التطابق التام.');
  return lines.join('\n');
}

/** آخر الأعطال المفيدة للإصلاح: أخطاء أدوات + فشل تحقق، بلا ضجيج */
export function recentFailures(events: TelemetryEvent[], limit = 25): TelemetryEvent[] {
  const bad = events.filter((e) => (e.kind === 'tool_error' || (e.kind === 'verify' && e.ok !== true) || (e.kind === 'turn' && e.ok !== true)));
  return bad.slice(-limit);
}

/** صياغة الأعطال كمهمة للنموذج: يستخدمها `/diagnostics fix` */
/** أنماط الأعطال البيئية: عطل لا يُصلح بتعديل ملفات، بل بإصلاح البيئة نفسها */
const ENV_PATTERNS: Array<{ re: RegExp; why: string; fix: string }> = [
  { re: /command not found|not recognized as an internal|الأمر غير موجود/i, why: 'أداة مطلوبة غير مثبّتة على الجهاز', fix: 'ثبّت الأداة المذكورة في نص الخطأ (مثلًا npm install -g أو مدير حزم النظام) ثم أعد الأمر.' },
  { re: /spawn .* ENOENT|\bENOENT\b[^\n]*\b(spawn|executable|POSIX)\b/i, why: 'تنفيذ برنامج غير موجود في البيئة', fix: 'تأكد من وجود الملف التنفيذي في PATH أو صحّح مساره في إعدادات المشروع.' },
  { re: /\bEACCES\b|permission denied|صلاحيات غير كافية/i, why: 'صلاحيات ملفات أو تنفيذ غير كافية', fix: 'صحّح صلاحيات الملف/المجلد (chmod +x للسكربتات) أو شغّل من مستخدم يملك الصلاحية.' },
  { re: /\bEADDRINUSE\b|address already in use/i, why: 'منفذ مشغول بخدمة أخرى على الجهاز', fix: 'أوقف الخدمة التي تشغل المنفذ أو غيّر رقم المنفذ في إعداد المشروع.' },
  { re: /\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b|getaddrinfo/i, why: 'خدمة أو شبكة غير متاحة في البيئة', fix: 'شغّل الخدمة المطلوبة محليًا أو تحقق من الشبكة/الوكيل قبل إعادة الأمر.' },
  { re: /\bENOSPC\b|no space left on device|disk full/i, why: 'مساحة القرص ممتلئة', fix: 'فرّغ مساحة (حذف node_modules القديمة أو ملفات البناء) ثم أعد الأمر.' },
  { re: /Cannot connect to the Docker daemon|docker: not found|Is the docker daemon running/i, why: 'Docker غير متاح في البيئة', fix: 'شغّل Docker (أو خدمة الحاويات) أو نفّذ الفحص بلا حاويات.' },
  { re: /out of memory|heap out of memory|فشل تخصيص الذاكرة/i, why: 'ذاكرة الجهاز غير كافية لهذه العملية', fix: 'ارفع سقف ذاكرة Node (--max-old-space-size) أو أعد تشغيل الجهاز وأغلق البرامج الثقيلة.' },
];

/** خطوة إصلاح مقترحة لسبب بيئي معروف (تُعرض في اللوحة ولا تُنفَّذ تلقائياً) */
export function envFixHint(reason: string | null | undefined): string {
  if (!reason) return '';
  return ENV_PATTERNS.find((p) => p.why === reason)?.fix ?? '';
}

/** يعيد سبباً بيئياً إن كان نص العطل يشير إلى البيئة، وإلا null (لا تُخمَّن الأسباب) */
export function envFailureReason(text: string): string | null {
  for (const p of ENV_PATTERNS) if (p.re.test(text)) return p.why;
  return null;
}

export function failuresToTask(events: TelemetryEvent[], root: string): string {
  const bad = recentFailures(events, 20);
  if (!bad.length) return '';
  const lines = bad.map((e) => {
    const text = e.kind === 'tool_error'
      ? String(e.message ?? '')
      : e.kind === 'verify'
        ? String(e.summary ?? '')
        : String(e.error ?? e.outcome ?? '');
    // وسم بيئي صريح: لا نطلب من الموديل «إصلاح» ما لا يُصلح بالكود
    const env = envFailureReason(text);
    const mark = env ? `⚠️ بيئي (${env}): ` : '';
    if (e.kind === 'tool_error') return `- ${mark}[أداة ${String(e.name)}] ${String(e.message ?? '').slice(0, 300)}`;
    if (e.kind === 'verify') return `- ${mark}[تحقق فاشل: ${String(e.command ?? '')}] ${String(e.summary ?? '').slice(0, 200)}`;
    return `- ${mark}[دورة فاشلة] ${String(e.error ?? e.outcome ?? '').slice(0, 200)}`;
  });
  return [
    `هذه أعطال مسجّلة في سجل الموثوقية المحلي داخل المشروع (${root}):`,
    ...lines,
    '',
    'حلّلها: ابحث عن السبب الجذري المشترك (لا تعالج العَرَض)، وأصلح ما يمكن إصلاحه داخل المشروع، وأخبرني بما لا يمكن إصلاحه من الكود ولماذا. إن كان العطل ناتجاً عن إعداد أو قيد بيئة فاذكره صراحةً بلا تعديل ملفات.',
  ].join('\n');
}
