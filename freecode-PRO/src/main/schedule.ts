// الجدولة داخل التطبيق: تشغيل الجرد الدوري (مقياس محاور السياق) من الواجهة بلا cron.
//
// الفكرة: طبقة رقيقة فوق نفس مسار «جرد الآن» (`metrics:sweep-now`) — مؤقّت يفحص كل دقيقة
// هل انقضت المدة، وإن انقضت والتطبيق غير مشغول بالوكيل شغّل الجرد ثم سجّل النتيجة.
//
// قرارات مقصودة:
//   • أول جرد مجدول يقع بعد انقضاء المدة من لحظة التفعيل (لا فوراً) — «جرد الآن» للمتابعة اليدوية.
//   • الجرد الفاشل يُسجَّل أيضاً (lastRun يتقدّم) حتى لا يعيد المحاولة كل دقيقة على خطأ ثابت.
//   • إن كان الوكيل يعمل على مهمة، نؤجّل الجرد (busy) ونعيد الفحص في الدقيقة التالية.
//   • المؤقّت `unref()` فلا يمنع إغلاق التطبيق.
//
// الوحدة بلا أي اعتماد على Electron حتى تُختبر مباشرة.

export const MIN_SWEEP_HOURS = 1;
export const MAX_SWEEP_HOURS = 24 * 30; // شهر
export const DEFAULT_SWEEP_HOURS = 24 * 7; // أسبوعي — نفس إيقاع sweep:week

export function clampSweepHours(h: unknown): number {
  const n = Math.round(Number(h));
  if (!Number.isFinite(n)) return DEFAULT_SWEEP_HOURS;
  return Math.max(MIN_SWEEP_HOURS, Math.min(MAX_SWEEP_HOURS, n));
}

export interface SweepScheduleState {
  enabled: boolean;
  everyHours: number;
  /** آخر جرد (مجدول أو يدوي) — بالمللي ثانية، أو null */
  lastRun: number | null;
  /** الوقت المتوقّع للجرد القادم (قد يكون ماضياً إن فات موعده والتطبيق مغلق) */
  nextRun: number | null;
  running: boolean;
  /** آخر نتيجة جرد مجدول */
  lastResult: { at: number; ok: boolean; note: string } | null;
}

export interface SweepSchedulerDeps {
  enabled: () => boolean;
  everyHours: () => number;
  /** آخر جرد فعلي (يُحفظ في الإعدادات) — يستخدمه الجدول لحساب الاستحقاق */
  lastRun: () => number | null;
  /** هل الوكيل مشغول الآن؟ (نؤجّل الجرد حينها) */
  busy?: () => boolean;
  /** ينفّذ الجرد فعلياً (نفس مسار metrics:sweep-now) */
  run: () => Promise<{ ok: boolean; error?: string; digestLine?: string }>;
  /** بعد كل جرد: احفظ lastRun والنتيجة */
  report?: (at: number, outcome: { ok: boolean; note: string }) => void;
  now?: () => number;
  tickMs?: number;
}

/** وصف النتيجة بسطر عربي مختصر (يظهر في الإعدادات وسجل التطبيق) */
export function scheduleNote(r: { ok: boolean; error?: string; digestLine?: string }): string {
  if (!r.ok) return r.error ? r.error.split('\n')[0]!.slice(0, 160) : 'فشل الجرد';
  return r.digestLine ?? 'تم الجرد';
}

export class SweepScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private since: number;
  private last: { at: number; ok: boolean; note: string } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SweepSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.since = this.now();
  }

  /** الوقت الذي يصبح فيه الجرد مستحقاً (مرجع: آخر جرد، أو لحظة التفعيل) */
  dueAt(): number | null {
    if (!this.deps.enabled()) return null;
    const base = this.deps.lastRun() ?? this.since;
    return base + clampSweepHours(this.deps.everyHours()) * 3_600_000;
  }

  state(): SweepScheduleState {
    return {
      enabled: this.deps.enabled(),
      everyHours: clampSweepHours(this.deps.everyHours()),
      lastRun: this.deps.lastRun(),
      nextRun: this.dueAt(),
      running: this.running,
      lastResult: this.last,
    };
  }

  /** يُستدعى عند تغيّر الإعدادات حتى يُعاد ضبط مرجع «لحظة التفعيل» */
  rearm(): void {
    this.since = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.rearm();
    const ms = Math.max(5_000, this.deps.tickMs ?? 60_000);
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get started(): boolean {
    return this.timer !== null;
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * فحص واحد. force=true يتجاهل الإعداد والاستحقاق (يستخدمه «جرد الآن» المجدول يدوياً؟ لا — يبقى للاختبار).
   * القيم: ran | not-due | disabled | busy | skipped (جرد جارٍ)
   */
  async tick(force = false): Promise<'ran' | 'not-due' | 'disabled' | 'busy' | 'skipped'> {
    if (this.running) return 'skipped';
    if (!force) {
      if (!this.deps.enabled()) return 'disabled';
      const due = this.dueAt();
      if (due === null || this.now() < due) return 'not-due';
      if (this.deps.busy?.()) return 'busy';
    }
    this.running = true;
    try {
      const r = await this.deps.run();
      const at = this.now();
      const note = scheduleNote(r);
      this.last = { at, ok: r.ok, note };
      // نسجّل الاستحقاق دائماً (نجاحاً أو فشلاً) فلا نعيد المحاولة كل دقيقة على خطأ ثابت
      this.deps.report?.(at, { ok: r.ok, note });
      return 'ran';
    } finally {
      this.running = false;
    }
  }
}
