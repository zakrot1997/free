// منسّق الوكلاء المتوازيين الكاتبين: كل وكيل يعمل في نسخة عمل (git worktree) على فرعه الخاص،
// فلا يتعارضان ولا يلمسان مجلد المستخدم. عند الانتهاء يظهر للعميل بطاقة فيها ملخّص وتغييراته
// وأزرار الدمج أو التجاهل. الحالة تُحفظ في agents.json فتبقى بعد إغلاق التطبيق.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Agent, DEFAULT_OPTIONS, type AgentEvents, type AgentOptions } from './agent';
import { isDangerousCommand } from './tools';
import type { LLMConfig } from './llm';
import { emptyRules, type RulesConfig } from './rules';
import type { ChangedFile } from './checkpoints';
import { git } from './git';
import {
  commitAll,
  createWorktree,
  diffStat,
  listWorktrees,
  mergeBranch,
  removeWorktree,
  uncommittedStat,
  type FileStat,
} from './worktrees';

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'stopped' | 'merged' | 'discarded';

export interface ParallelTask {
  label: string;
  task: string;
}

export interface ParallelAgent {
  id: string;
  label: string;
  task: string;
  branch: string;
  dir: string;
  base: string;
  status: AgentRunStatus;
  startedAt: number;
  endedAt?: number;
  mergedAt?: number;
  toolCalls: number;
  tokens: number;
  files: FileStat[];
  summary: string;
  error?: string;
  /** أوامر خطرة رفضها الوكيل تلقائياً */
  denied: string[];
}

export interface PoolEvents {
  onUpdate(agent: ParallelAgent): void;
  onLog(id: string, chunk: string): void;
  onNotice(message: string): void;
}

export const MAX_PARALLEL = 4;

export class AgentPool {
  readonly agents = new Map<string, ParallelAgent>();
  private controllers = new Map<string, AbortController>();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor(
    public cfg: LLMConfig,
    public readonly root: string,
    private userData: string,
    private base: AgentOptions = DEFAULT_OPTIONS,
    private ev: PoolEvents = { onUpdate: () => {}, onLog: () => {}, onNotice: () => {} },
    private rules?: RulesConfig,
  ) {}

  private file(): string {
    return path.join(this.userData, 'agents.json');
  }

  get running(): ParallelAgent[] {
    return this.list().filter((a) => a.status === 'running');
  }

  list(): ParallelAgent[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** يستعيد الحالة من القرص ويصحّح ما مات أثناء الإغلاق */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file(), 'utf8'));
      this.agents.clear();
      for (const a of Array.isArray(raw) ? raw : []) {
        const agent = a as ParallelAgent;
        // نسخ معلّقة من جلسة سابقة: لم تعد تعمل
        if (agent.status === 'running') agent.status = 'stopped';
        this.agents.set(agent.id, agent);
      }
    } catch {
      /* لا ملف بعد */
    }
    await this.reconcile();
  }

  /** يُسقط النسخ التي حُذفت من القرص أو حُذف فرعها يدوياً */
  async reconcile(): Promise<void> {
    const live = await listWorktrees(this.root).catch(() => []);
    const dirs = new Set(live.map((w) => w.path));
    for (const a of this.agents.values()) {
      if (a.dir && (a.status === 'done' || a.status === 'failed' || a.status === 'stopped') && !dirs.has(a.dir)) {
        a.status = 'discarded';
      }
    }
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.save();
    }, 250);
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(this.userData, { recursive: true });
      await fs.writeFile(this.file(), JSON.stringify(this.list(), null, 2), 'utf8');
    } catch {
      /* لا نُفشل العمل بسبب الحفظ */
    }
  }

  /** يشغّل مجموعة مهام بالتوازي ويعيد الحالة النهائية لكل وكيل */
  async run(tasks: ParallelTask[], opts: { allowCommands?: boolean; maxSteps?: number } = {}): Promise<ParallelAgent[]> {
    const batch = tasks.filter((t) => String(t?.task ?? '').trim()).slice(0, MAX_PARALLEL);
    if (!batch.length) throw new Error('لا مهام صالحة للتفويض');
    const created: ParallelAgent[] = [];

    for (const t of batch) {
      const wt = await createWorktree(this.root, this.userData, t.label);
      if ('error' in wt) {
        const failed: ParallelAgent = {
          id: `fail-${Date.now().toString(36)}`,
          label: t.label,
          task: t.task,
          branch: '',
          dir: '',
          base: '',
          status: 'failed',
          startedAt: Date.now(),
          endedAt: Date.now(),
          toolCalls: 0,
          tokens: 0,
          files: [],
          summary: '',
          error: wt.error,
          denied: [],
        };
        this.agents.set(failed.id, failed);
        this.ev.onUpdate(failed);
        created.push(failed);
      } else {
        const a: ParallelAgent = {
          id: wt.id,
          label: t.label || wt.id,
          task: t.task,
          branch: wt.branch,
          dir: wt.dir,
          base: wt.base,
          status: 'running',
          startedAt: Date.now(),
          toolCalls: 0,
          tokens: 0,
          files: [],
          summary: '',
          denied: [],
        };
        this.agents.set(a.id, a);
        created.push(a);
        this.ev.onUpdate(a);
      }
    }
    this.scheduleSave();

    await Promise.all(created.filter((a) => a.status === 'running').map((a) => this.runOne(a, opts)));
    this.scheduleSave();
    return created;
  }

  private async runOne(a: ParallelAgent, opts: { allowCommands?: boolean; maxSteps?: number }): Promise<void> {
    const ac = new AbortController();
    this.controllers.set(a.id, ac);
    const allowCommands = opts.allowCommands ?? true;
    const options: AgentOptions = {
      ...this.base,
      mode: 'act',
      isSub: false,
      maxSteps: opts.maxSteps ?? this.base.maxSteps,
      autoApproveEdits: true,
      autoApproveCommands: false,
      // التحقق التلقائي مكلف مع 4 وكلاء متزامنين: نتركه للوكيل الرئيسي بعد الدمج
      autoVerify: false,
    };
    const agent = new Agent(this.cfg, a.dir, options);
    if (this.rules) {
      const r = emptyRules();
      r.permissions = { allow: [], ask: [], deny: this.rules.permissions.deny };
      agent.rules = r;
    }

    let lastText = '';
    const ev: AgentEvents = {
      onText: (d) => {
        lastText += d;
        this.ev.onLog(a.id, d);
      },
      onToolCall: (_id, name, args) => {
        a.toolCalls++;
        this.ev.onLog(a.id, `\n› ${name} ${JSON.stringify(args ?? {}).slice(0, 100)}\n`);
        this.ev.onUpdate(a);
      },
      onToolOutput: (_id, chunk) => this.ev.onLog(a.id, chunk),
      onToolResult: (_id, _name, result, isError) => {
        if (isError) this.ev.onLog(a.id, `\n[خطأ] ${String(result).slice(0, 300)}\n`);
      },
      approve: async (_id, name, args) => {
        // الأدوات النصية (كتابة/قراءة) مسموحة تلقائياً داخل النسخة المعزولة
        if (name !== 'run_command' && name !== 'start_process' && name !== 'stop_process') return true;
        const cmd = String((args as any)?.command ?? (args as any)?.id ?? '');
        if (isDangerousCommand(cmd)) {
          a.denied.push(cmd);
          this.ev.onLog(a.id, `\n[رُفض أمر خطر] ${cmd}\n`);
          this.ev.onUpdate(a);
          return false;
        }
        return allowCommands;
      },
      onTodos: () => {},
      onUsage: (u) => {
        a.tokens = u.tokens;
        this.ev.onUpdate(a);
      },
      onRetry: (info) => this.ev.onLog(a.id, `\n[إعادة محاولة ${info.attempt}/${info.maxAttempts}] ${info.reason}\n`),
      onChanges: (changes: ChangedFile[]) => {
        a.files = changes.map((c) => ({ path: c.path, add: 0, del: 0 }));
        this.ev.onUpdate(a);
      },
      onNotice: (m) => this.ev.onLog(a.id, `\n[${m}]\n`),
    };

    try {
      await agent.run(a.task, ev, ac.signal);
      const commit = await commitAll(a.dir, `FreeCode: ${a.label}`);
      if (!commit.ok) {
        a.status = 'failed';
        a.error = `تعذّر تثبيت التغييرات: ${commit.message}`;
      } else {
        a.status = ac.signal.aborted ? 'stopped' : 'done';
        // فروق الفرع مقابل الأساس (بعد الالتزام) — تُقرأ من المستودع لا من ذاكرة الوكيل
        const stat = await diffStat(this.root, a.branch, a.base);
        if (stat.length) a.files = stat;
        else {
          const pend = await uncommittedStat(a.dir);
          if (pend.length) a.files = pend;
        }
      }
      a.summary = lastText.trim().slice(0, 4000) || '(انتهى بلا نص)';
    } catch (e: any) {
      a.status = ac.signal.aborted ? 'stopped' : 'failed';
      a.error = String(e?.message ?? e).slice(0, 400);
      // نحفظ ما أنجزه قبل الفشل حتى لا يضيع
      await commitAll(a.dir, `FreeCode (جزئي): ${a.label}`).catch(() => {});
    } finally {
      a.endedAt = Date.now();
      this.controllers.delete(a.id);
      this.ev.onUpdate(a);
      this.scheduleSave();
    }
  }

  stop(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    this.ev.onNotice(`أُوقف الوكيل ${id}.`);
    return true;
  }

  stopAll(): void {
    for (const id of [...this.controllers.keys()]) this.stop(id);
  }

  /** يلتزم أي عمل غير ملتزم في نسخة الوكيل (لو توقف فجأة) */
  async ensureCommitted(a: ParallelAgent): Promise<void> {
    if (a.dir) await commitAll(a.dir, `FreeCode: ${a.label}`).catch(() => {});
  }

  /** يدمج عمل الوكيل في الفرع الحالي، ثم يزيل النسخة والفرع */
  async merge(id: string, squash = false): Promise<{ ok: boolean; message: string; conflicts: string[] }> {
    const a = this.agents.get(id);
    if (!a) return { ok: false, message: 'وكيل غير معروف', conflicts: [] };
    if (a.status === 'merged' || a.status === 'discarded') return { ok: false, message: 'هذا الوكيل أُغلق سابقاً', conflicts: [] };
    if (a.status === 'running') return { ok: false, message: 'الوكيل ما زال يعمل — أوقفه ثم ادمج', conflicts: [] };
    if (!a.branch) return { ok: false, message: a.error ?? 'لا فرع لهذا الوكيل', conflicts: [] };

    await this.ensureCommitted(a);
    const r = await mergeBranch(this.root, a.branch, a.label, squash);
    if (r.ok) {
      a.status = 'merged';
      a.mergedAt = Date.now();
      await removeWorktree(this.root, a.dir, a.branch);
      a.dir = '';
      this.ev.onUpdate(a);
      this.ev.onNotice(`دُمج عمل «${a.label}» (${a.files.length} ملف).`);
      this.scheduleSave();
    } else {
      this.ev.onNotice(`تعذّر دمج «${a.label}»: ${r.message}`);
    }
    return r;
  }

  /** يحذف النسخة والفرع بلا دمج */
  async discard(id: string): Promise<{ ok: boolean; message: string }> {
    const a = this.agents.get(id);
    if (!a) return { ok: false, message: 'وكيل غير معروف' };
    if (a.status === 'running') this.stop(id);
    // مهلة قصيرة ليخرج الوكيل من مجلده قبل حذفه
    for (let i = 0; i < 20 && this.controllers.has(id); i++) await new Promise((r) => setTimeout(r, 100));
    await removeWorktree(this.root, a.dir, a.branch);
    a.status = 'discarded';
    a.dir = '';
    this.ev.onUpdate(a);
    this.scheduleSave();
    return { ok: true, message: `حُذفت نسخة «${a.label}» بلا دمج.` };
  }

  /** فرق الوكيل مقابل الأساس */
  async diff(id: string): Promise<string> {
    const a = this.agents.get(id);
    if (!a) return '';
    if (!a.dir || !a.branch) return '';
    await this.ensureCommitted(a);
    const r = await git(this.root, ['diff', `${a.base}...${a.branch}`], 60_000);
    return r.stdout;
  }

  /** إزالة بطاقات الوكلاء المنتهين (المدمجين أو المتجاهَلين) من اللوحة */
  async clearFinished(): Promise<number> {
    let n = 0;
    for (const [id, a] of this.agents) {
      if (a.status === 'merged' || a.status === 'discarded') {
        this.agents.delete(id);
        n++;
      }
    }
    if (n) {
      this.ev.onUpdate({} as ParallelAgent);
      this.scheduleSave();
    }
    return n;
  }
}

/** نص التقرير الذي يعود للنموذج بعد التفويض */
export function formatPoolReport(agents: ParallelAgent[]): string {
  if (!agents.length) return 'لم يبدأ أي وكيل.';
  const lines = agents.map((a) => {
    const head = `• ${a.label} — ${statusAr(a.status)}${a.branch ? ` · فرع ${a.branch}` : ''}`;
    const files = a.files.length ? `\n   ملفات (${a.files.length}): ${a.files.slice(0, 12).map((f) => f.path).join(', ')}${a.files.length > 12 ? '…' : ''}` : '';
    const work = a.toolCalls ? `\n   ${a.toolCalls} استدعاء أداة${a.tokens ? ` · ~${a.tokens} توكن سياق` : ''}` : '';
    const err = a.error ? `\n   خطأ: ${a.error}` : '';
    const sum = a.summary ? `\n   ملخّص: ${a.summary.replace(/\s+/g, ' ').slice(0, 320)}` : '';
    const deny = a.denied.length ? `\n   رُفضت أوامر خطرة: ${a.denied.slice(0, 3).join(' | ')}` : '';
    return head + sum + files + work + err + deny;
  });
  return [
    `انتهى ${agents.length} وكيل متوازٍ. عملهم في نسخ معزولة ولم يُدمج بعد — المستخدم يدمج ما يشاء من لوحة «الوكلاء» أو بأمر /agents merge.`,
    ...lines,
  ].join('\n');
}

export function statusAr(s: AgentRunStatus): string {
  return (
    {
      running: 'يعمل الآن',
      done: 'انتهى ✅',
      failed: 'فشل ⚠️',
      stopped: 'أُوقف',
      merged: 'دُمج ✔',
      discarded: 'تُجوهل',
    } as Record<AgentRunStatus, string>
  )[s];
}

/** يقرأ قيمة التسلسل لاستخدامها في الاختبارات بلا FS */
export function serialize(agents: ParallelAgent[]): string {
  return JSON.stringify(agents, null, 2);
}
