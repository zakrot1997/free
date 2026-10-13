import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { streamChat, estimateTokens, type ChatMessage, type LLMConfig, type RetryInfo, type ToolCall } from './llm';
import { specsForMode, lookupTool, isDangerousCommand, type Preview, type TodoItem, type ToolDef } from './tools';
import { CheckpointStore, type ChangedFile } from './checkpoints';
import { compactMessages, environmentBlock, loadProjectInstructions, summarizeHistory } from './context';
import { loadMemory } from './memory';
import { repoMap, type RepoMapCache } from './map';
import { formatVerify, runVerify } from './verify';
import { skillsPromptSection, type Skill } from './skills';
import { findTextDefinitions } from './lsp';
import type { SearchProvider } from './search';
import { decide, emptyRules, runHooks, subjectOf, type RulesConfig } from './rules';
import type { TelemetrySink } from './telemetry';

export type Mode = 'plan' | 'act';

export interface AgentOptions {
  mode: Mode;
  autoApproveEdits: boolean;
  autoApproveCommands: boolean;
  /** ميزانية السياق بالتوكنات قبل الضغط ثم التلخيص */
  tokenBudget: number;
  maxSteps: number;
  /** تشغيل فحص الأنواع/lint تلقائياً بعد كل تعديل وإرجاع الأخطاء للنموذج */
  autoVerify: boolean;
  /** أمر فحص مخصّص يستبدل الاكتشاف التلقائي (فارغ = اكتشاف تلقائي) */
  verifyCommand: string;
  /** إضافة خريطة المستودع (الرموز والاعتماديات) إلى رسالة النظام */
  repoMap: boolean;
  /** إعدادات بحث الويب */
  searchProvider: SearchProvider;
  searchApiKey: string;
  /** وكيل فرعي: للقراءة فقط، بلا task ولا todo_write */
  isSub?: boolean;
  /**
   * استبدال ملف تعليمات المشروع بنص آخر (يُستخدم في اختبار A/B لقياس أثر التعليمات).
   * null = لا تعليمات إطلاقاً (للمقارنة مع «بلا تعليمات»).
   */
  instructionsOverride?: { file: string; text: string } | null;
  /** تحميل `.freecode/memory.md` في رسالة النظام — false = بلا ذاكرة (لقياس أثرها في A/B) */
  memory?: boolean;
}

export const DEFAULT_OPTIONS: AgentOptions = {
  mode: 'act',
  autoApproveEdits: false,
  autoApproveCommands: false,
  tokenBudget: 28_000,
  maxSteps: 30,
  autoVerify: true,
  verifyCommand: '',
  repoMap: true,
  searchProvider: 'auto',
  searchApiKey: '',
};

export interface AgentEvents {
  onText(delta: string): void;
  onToolCall(id: string, name: string, args: unknown): void;
  onToolOutput(id: string, chunk: string): void;
  onToolResult(id: string, name: string, result: string, isError: boolean): void;
  /**
   * يُستدعى قبل أي أداة تحتاج موافقة. النتيجة:
   * false رفض · true موافقة مرة واحدة · 'turn' موافقة على باقي هذه الدورة ·
   * 'file' موافقة على بقية تعديلات **هذا الملف** في هذه الدورة (تقليل النقرات)
   */
  approve(id: string, name: string, args: unknown, preview: Preview | null): Promise<boolean | 'turn' | 'file'>;
  onTodos(todos: TodoItem[]): void;
  onUsage(u: { tokens: number; budget: number; saved: number }): void;
  onRetry(info: RetryInfo): void;
  onChanges(changes: ChangedFile[], undoDepth: number): void;
  onNotice(message: string): void;
}

const BASE_PROMPT = `You are FreeCode, an expert AI coding agent working inside the user's project folder.
You have tools to list, read, search (grep/glob), write and edit files, run shell commands, fetch web pages, keep a todo list, and delegate research to read-only subagents (task).
When a language server is configured you also have code intelligence (code_definition, code_references, code_hover, code_diagnostics) — prefer it over guessing symbol locations, and it is a cheap way to catch type errors in one file.

How to work:
- Explore before changing: use list_dir, glob, search and read_file to understand the code first. For broad questions ("where is X handled?"), delegate to the task tool; you may launch several task calls in one turn and they run in parallel.
- You may call several read-only tools in one turn; they run in parallel.
- For work that splits into independent parts (different files or modules), use the delegate tool: it runs up to 4 writer agents in parallel, each in an isolated git worktree on its own branch, and the user merges what they like from the "الوكلاء" panel. Independent tasks only — never parallelize edits to the same files; do the sequential or shared work yourself.
- For multi-step tasks, call todo_write with a short plan first, then update statuses as you progress.
- Prefer edit_file for small, precise changes (copy old_text exactly); use write_file for new files or full rewrites.
- After making changes, verify them: run the build, tests, or linter when possible, and fix what breaks.
- Never invent file contents or paths; read first. Keep changes minimal and consistent with the existing code style.
- Keep replies concise. Reply in the same language the user writes in (Arabic or English).
- All paths are relative to the project root. If the user rejected an operation, do not retry it; ask what they prefer.
- If a message starts with "[ملخص المحادثة السابقة]", it is a summary of earlier conversation that was shortened to save context; rely on it.`;

const PLAN_PROMPT = `\n\nMODE: PLAN (read-only). You cannot modify files or run commands in this mode.
Investigate the code using the read-only tools, then present a clear, numbered implementation plan listing exactly which files you would change and why.
End by telling the user to switch to Act mode when they are happy with the plan.`;

const SUB_PROMPT = `You are a read-only research subagent working inside the user's project folder, delegated a self-contained task by a lead agent.
You cannot modify anything. Investigate thoroughly using list_dir, glob, search, read_file and web_fetch, then finish with a concise final report:
exact file paths (with line numbers when useful), what you found, and direct answers to the question. Do not ask questions; make reasonable assumptions and state them.`;

function errorLike(result: string): boolean {
  return /^(خطأ|أداة غير|تعذّر)/.test(result);
}

const noop = () => {};

export class Agent {
  messages: ChatMessage[] = [{ role: 'system', content: BASE_PROMPT }];
  checkpoints = new CheckpointStore();
  todos: TodoItem[] = [];
  options: AgentOptions;
  /** أدوات إضافية ديناميكية (MCP) */
  extraTools: () => ToolDef[] = () => [];
  /** قواعد الصلاحيات والـ hooks (تُحمَّل من الملفات قبل كل رسالة) */
  rules: RulesConfig = emptyRules();
  /** المهارات المتاحة (تُحمَّل قبل كل رسالة) */
  skills: Skill[] = [];
  /** المستخدم وافق على باقي هذه الدورة (عدا الخطر وMCP) */
  private turnAuto = false;
  /** أهداف وافق المستخدم على تعديلها كلها في هذه الدورة: "أداة:مسار" */
  private turnApprovedTargets = new Set<string>();
  /** إحصاء الدورة الجارية (للقياس) */
  private turnSteps = 0;
  private turnOutcome: 'answer' | 'limit' | 'aborted' | 'error' = 'answer';
  private lastSig = '';
  private repeats = 0;
  /** تخزين مؤقت لخريطة المستودع (تُحسب مرة كل 30 ثانية كحد أقصى) */
  private mapCache: RepoMapCache | null = null;
  /** تنظيم تشغيل التحقق التلقائي: لا أكثر من مرة كل ثانيتين وبسقف لكل دورة */
  private lastVerifyAt = 0;
  private verifiesThisTurn = 0;
  /** فشل التحقق في هذه الدورة (يُستخدم لفحص الإغلاق قبل التسليم) */
  private verifyFailsThisTurn = 0;
  /** كم مرة أعدنا النموذج للإصلاح بعد فشل تحقق عند نهاية الدورة */
  private closingVerifies = 0;

  constructor(
    public cfg: LLMConfig,
    public root: string,
    options: Partial<AgentOptions> = {},
    history: ChatMessage[] = [],
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.messages.push(...history);
  }

  /** الرسائل بدون رسالة النظام (للحفظ في الجلسة) */
  history(): ChatMessage[] {
    return this.messages.slice(1);
  }

  reset(): void {
    this.messages = [{ role: 'system', content: BASE_PROMPT }];
    this.todos = [];
    this.checkpoints.clear();
  }

  private lookup(name: string): ToolDef | undefined {
    return lookupTool(name, this.options.isSub ? [] : this.extraTools());
  }

  private async refreshSystem(): Promise<void> {
    let sys: string;
    if (this.options.isSub) sys = SUB_PROMPT;
    else sys = BASE_PROMPT + (this.options.mode === 'plan' ? PLAN_PROMPT : '');
    const instr = this.options.instructionsOverride === null ? null : (this.options.instructionsOverride ?? (await loadProjectInstructions(this.root)));
    if (instr) sys += `\n\nProject instructions (${instr.file}) — follow them:\n${instr.text}`;
    if (this.options.memory !== false) {
      const memory = await loadMemory(this.root);
      if (memory) sys += `\n\nProject memory (.freecode/memory.md) — user preferences and settled decisions; honor them:\n${memory}`;
    }
    if (!this.options.isSub) sys += skillsPromptSection(this.skills);
    sys += `\n\nEnvironment:\n${await environmentBlock(this.root)}`;
    if (this.options.repoMap && !this.options.isSub) {
      try {
        const m = await repoMap(this.root, this.mapCache);
        this.mapCache = m.cache;
        if (m.text) sys += `\n\nRepository map (most relevant files and their top-level symbols):\n${m.text}`;
      } catch {
        /* الخريطة تحسين لا شرط */
      }
    }
    this.messages[0] = { role: 'system', content: sys };
  }

  /** التراجع عن آخر دورة عدّل فيها الوكيل ملفات */
  async undo(): Promise<ChangedFile[]> {
    const restored = await this.checkpoints.undoLast();
    if (restored.length) {
      this.messages.push({
        role: 'user',
        content: `[ملاحظة آلية] تراجع المستخدم عن التعديلات الأخيرة في: ${restored.map((r) => r.path).join(', ')}. الملفات عادت لحالتها السابقة.`,
      });
    }
    return restored;
  }

  /** جذور قراءة إضافية (مجلدات الإضافات ومهارات المستخدم) تُتاح لأدوات القراءة فقط */
  readRoots: string[] = [];

  /** مدير خوادم اللغة (يُضبط من main.ts عند توفّره) */
  lsp?: import('./lsp').LspManager;

  /** قياس الموثوقية: يُستدعى لكل حدث (تعديل، فشل أداة، تحقق، موافقة، دورة) */
  telemetry?: TelemetrySink;

  /** يحوّل الأوامر للتنفيذ داخل حاوية عند تفعيل وضع الحماية */
  sandbox?: (command: string) => { command: string; sandboxed: boolean; note: string; fatal: boolean };

  /** يشغّل وكلاء كاتبين بالتوازي في نسخ عمل معزولة (يُضبط من main.ts عند توفّر مستودع git) */
  delegate?: (tasks: { label: string; task: string }[]) => Promise<string>;

  /** تلخيص المحادثة يدوياً (/compact) أو تلقائياً عند تجاوز الميزانية. يعيد عدد الرسائل الملخّصة. */
  async compact(signal?: AbortSignal, budget = Math.floor(this.options.tokenBudget / 2)): Promise<number> {
    const r = await summarizeHistory(this.cfg, this.messages, budget, signal);
    if (!r) return 0;
    this.messages = r.messages;
    return r.count;
  }

  private async runSubagent(prompt: string, onProgress: (line: string) => void, ev: AgentEvents, signal?: AbortSignal): Promise<string> {
    const sub = new Agent(this.cfg, this.root, { mode: 'plan', isSub: true, maxSteps: 14, tokenBudget: this.options.tokenBudget });
    // الوكيل الفرعي يلتزم بقواعد المنع والسؤال، ولا يشغّل hooks
    sub.rules = { permissions: { allow: [], ask: this.rules.permissions.ask, deny: this.rules.permissions.deny }, hooks: emptyRules().hooks };
    const subEv: AgentEvents = {
      onText: noop,
      onToolCall: (_id, name, args) => onProgress(`↳ ${name} ${JSON.stringify(args ?? {}).slice(0, 90)}\n`),
      onToolOutput: noop,
      onToolResult: noop,
      approve: async () => false,
      onTodos: noop,
      onUsage: noop,
      onRetry: ev.onRetry,
      onChanges: noop,
      onNotice: noop,
    };
    await sub.run(prompt, subEv, signal);
    const last = [...sub.messages].reverse().find((m) => m.role === 'assistant' && m.content);
    return (last?.content ?? '').slice(0, 12_000) || '(لم يُرجع الوكيل الفرعي أي نتيجة)';
  }

  /** ينفّذ استدعاء أداة واحداً (مع الأحداث والموافقة) ويعيد النص الذي يُرسل للنموذج */
  private async execTool(call: ToolCall, ev: AgentEvents, signal?: AbortSignal): Promise<string> {
    const name = call.function.name;
    let args: any = {};
    let result: string;
    let isError = false;

    try {
      args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      args = null;
    }

    ev.onToolCall(call.id, name, args);
    const tool = this.lookup(name);
    const ctx = {
      root: this.root,
      readRoots: this.readRoots,
      signal,
      checkpoints: this.checkpoints,
      onOutput: (chunk: string) => ev.onToolOutput(call.id, chunk),
      setTodos: (t: TodoItem[]) => {
        this.todos = t;
        ev.onTodos(t);
      },
      runSubagent: (p: string, progress: (l: string) => void) => this.runSubagent(p, progress, ev, signal),
      runDelegates: this.delegate ? (tasks: { label: string; task: string }[]) => this.delegate!(tasks) : undefined,
      sandbox: this.sandbox,
      reportEdit: (file: string, strategy: string, replacements: number) =>
        this.telemetry?.record({ kind: 'edit', file, strategy, replacements }),
      lsp: this.lsp
        ? {
            definition: (f: string, l: number, c: number) => this.lsp!.definition(f, l, c),
            references: (f: string, l: number, c: number) => this.lsp!.references(f, l, c),
            hover: (f: string, l: number, c: number) => this.lsp!.hover(f, l, c),
            diagnostics: (f: string) => this.lsp!.diagnostics(f),
            symbolFallback: async (name: string) => {
              // بلا خادم: فهرسة نصية على المشروع كبديل عملي
              const hits = await findTextDefinitions(this.root, name);
              if (!hits.length) return `لم أجد تعريفاً نصياً لـ«${name}». جرّب أداة search (grep) أو اقرأ الملفات المرشّحة.`;
              return hits.slice(0, 12).map((h: { file: string; line: number; text: string }) => `• ${h.file}:${h.line}  ${h.text}`).join('\n');
            },
          }
        : undefined,
      search: { provider: this.options.searchProvider, apiKey: this.options.searchApiKey },
    };

    if (!tool) {
      result = `أداة غير معروفة: ${name}`;
      isError = true;
    } else if (args === null) {
      result = 'تعذّر تحليل وسائط الأداة كـ JSON. أعد الاستدعاء بـ JSON صالح.';
      isError = true;
    } else if (this.options.mode === 'plan' && tool.kind !== 'read') {
      result = 'خطأ: هذه الأداة غير متاحة في وضع Plan (للقراءة فقط). اعرض خطتك على المستخدم.';
      isError = true;
    } else {
      try {
        const dec = decide(this.rules.permissions, name, args, this.root);
        if (dec.action === 'deny') {
          result = `ممنوع بقاعدة صلاحيات (${dec.rule}). لا تحاول الالتفاف حولها؛ اشرح للمستخدم ما تحتاجه واسأله.`;
          isError = true;
        } else {
          const pre = this.options.isSub ? null : await runHooks('PreToolUse', this.rules.hooks.PreToolUse, { root: this.root, name, args }, signal);
          pre?.notices.forEach((n) => ev.onNotice(n));
          if (pre?.blocked) {
            result = `منعت هذه العملية قاعدة (hook): ${pre.message}`;
            isError = true;
          } else {
            let allowed = true;
            if (tool.kind !== 'read' || dec.action === 'ask') {
              // المعاينة تكشف الأخطاء مبكراً (مثل old_text غير موجود) بدون إزعاج المستخدم بطلب موافقة
              const preview: Preview = tool.preview ? await tool.preview(args, ctx) : { kind: 'generic', text: `${name} ${JSON.stringify(args).slice(0, 600)}` };
              const dangerous = tool.kind === 'command' && !tool.mcp && isDangerousCommand(String(args.command ?? ''));
              // قاعدة ask تفرض السؤال حتى مع الموافقة التلقائية؛ والأمر الخطر يُسأل عنه دائماً حتى مع قاعدة allow
              let auto = false;
              if (!dangerous && dec.action !== 'ask') {
                if (dec.action === 'allow') auto = true;
                else if (!tool.mcp) {
                  auto =
                    (tool.kind === 'edit' && this.options.autoApproveEdits) ||
                    (tool.kind === 'command' && this.options.autoApproveCommands) ||
                    (this.turnAuto && (tool.kind === 'edit' || tool.kind === 'command'));
                }
              }
              // موافقة سابقة على نفس الملف/الأمر في هذه الدورة تُغني عن السؤال مرة أخرى
              const targetKey = `${name}:${subjectOf(name, args, this.root).text ?? ''}`;
              if (!auto && !tool.mcp && dec.action !== 'ask' && this.turnApprovedTargets.has(targetKey)) {
                auto = true;
                ev.onNotice(`وافقت مسبقاً على ${targetKey.startsWith('run_command') ? 'هذا الأمر' : 'هذا الملف'} في هذه الدورة — أكملت بلا سؤال.`);
              }
              if (!auto) {
                const r = await ev.approve(call.id, name, args, preview);
                this.telemetry?.record({ kind: 'approval', name, target: subjectOf(name, args, this.root).text ?? '', decision: r === false ? 'deny' : r === true ? 'once' : String(r) });
                if (r === 'turn') {
                  this.turnAuto = true;
                  ev.onNotice('فُعّلت الموافقة التلقائية لباقي هذه الدورة (الأوامر الخطرة وأدوات MCP وقواعد ask ما زالت تُسأل).');
                } else if (r === 'file') {
                  this.turnApprovedTargets.add(targetKey);
                  ev.onNotice(`لن أسأل مرة أخرى عن «${targetKey.split(':').slice(1).join(':') || name}» في هذه الدورة.`);
                }
                allowed = r !== false;
              }
            }
            if (!allowed) {
              result = 'رفض المستخدم تنفيذ هذه العملية. لا تعد المحاولة؛ اسأله عمّا يفضله.';
              isError = true;
            } else {
              result = await tool.run(args, ctx);
              if (!this.options.isSub && this.rules.hooks.PostToolUse.length) {
                const subj = subjectOf(name, args, this.root);
                const abs = subj.kind === 'path' && tool.kind === 'edit' && subj.text ? path.resolve(this.root, subj.text) : null;
                const before = abs ? await fs.readFile(abs, 'utf8').catch(() => null) : null;
                const post = await runHooks('PostToolUse', this.rules.hooks.PostToolUse, { root: this.root, name, args, result, isError: false }, signal);
                post.notices.forEach((n) => ev.onNotice(n));
                if (post.appended) result += post.appended;
                if (abs && post.ran) {
                  const after = await fs.readFile(abs, 'utf8').catch(() => null);
                  if (before !== null && after !== null && before !== after) result += '\n[تنبيه: عدّل hook الملف بعد الكتابة (مثل التنسيق). أعد قراءته قبل أي edit_file لاحق.]';
                }
              }
              // التحقق التلقائي: بعد أي تعديل ناجح نشغّل فحص الأنواع/lint ونرجّع الأخطاء
              // للنموذج في نفس الخطوة، فيصلحها بدل أن يسلّم كوداً مكسوراً.
              if (tool.kind === 'edit' && !this.options.isSub && this.options.autoVerify && this.verifiesThisTurn < 8) {
                const subj = subjectOf(name, args, this.root);
                const now = Date.now();
                if (subj.kind === 'path' && subj.text && now - this.lastVerifyAt > 2000) {
                  this.lastVerifyAt = now;
                  this.verifiesThisTurn++;
                  try {
                    const results = await runVerify(this.root, [subj.text], { override: this.options.verifyCommand, signal });
                    const failed = results.filter((r) => !r.ok);
                    const block = formatVerify(results);
                    if (block) {
                      result += block;
                      ev.onNotice(`تحقق تلقائي: فشل «${failed.map((f) => f.label).join('، ')}» بعد تعديل ${subj.text} — أُعيدت الأخطاء للنموذج.`);
                      this.verifyFailsThisTurn++;
                      this.telemetry?.record({ kind: 'verify', ok: false, file: subj.text, command: failed.map((f) => f.label).join('/'), summary: block.replace(/\s+/g, ' ').slice(0, 300) });
                    } else if (results.length) {
                      ev.onNotice(`تحقق تلقائي: نجح (${results.map((r) => r.label).join('، ')})`);
                      this.telemetry?.record({ kind: 'verify', ok: true, file: subj.text, command: results.map((r) => r.label).join('/') });
                    }
                  } catch {
                    /* فشل الفحص نفسه لا يعطّل التعديل */
                  }
                }
              }

              // نعرض كل ما عدّله الوكيل في المحادثة (لا آخر دورة فقط) حتى تبقى اللوحة صحيحة بعد التراجع
              if (tool.kind === 'edit') ev.onChanges(this.checkpoints.allChanges(), this.checkpoints.depth);
            }
          }
        }
      } catch (e: any) {
        result = `خطأ: ${e?.message ?? e}`;
        isError = true;
      }
    }

    // كشف الحلقات: نفس الاستدعاء بنفس النتيجة مرتين متتاليتين = لا تقدّم، فننبّه مبكراً
    // (كان التنبيه يُرسل بعد ثلاث تكرارات، وهو استهلاك توكنات بلا فائدة).
    const sig = `${name}|${call.function.arguments}|${result.slice(0, 200)}`;
    this.repeats = sig === this.lastSig ? this.repeats + 1 : 0;
    this.lastSig = sig;
    if (this.repeats >= 1) {
      result +=
        this.repeats >= 3
          ? '\n[تنبيه قوي: تكرر نفس الاستدعاء بنفس النتيجة عدة مرات. توقف عن التكرار واشرح للمستخدم ما يعترض طريقك واطلب توجيهاً.]'
          : '\n[تنبيه: كررت نفس الاستدعاء بنفس النتيجة. جرّب نهجاً مختلفاً أو اطلب مساعدة المستخدم.]';
    }

    const failed = isError || errorLike(result);
    if (failed) this.telemetry?.record({ kind: 'tool_error', name, message: String(result).slice(0, 400) });
    ev.onToolResult(call.id, name, result, failed);
    return result;
  }

  /** الغلاف العام: يقيس الدورة (زمن، خطوات، توكنات، نتيجة) ثم يفوّض للدورة نفسها */
  async run(userText: string, ev: AgentEvents, signal?: AbortSignal, images: string[] = []): Promise<void> {
    this.turnSteps = 0;
    this.turnOutcome = 'answer';
    const started = Date.now();
    const tokensBefore = estimateTokens(this.messages);
    try {
      await this.runTurn(userText, ev, signal, images);
    } catch (e: any) {
      this.turnOutcome = 'error';
      this.telemetry?.record({ kind: 'turn', ok: false, outcome: 'error', error: String(e?.message ?? e).slice(0, 300), steps: this.turnSteps, durationMs: Date.now() - started, tokens: Math.max(0, estimateTokens(this.messages) - tokensBefore), model: this.cfg.model, mode: this.options.mode });
      throw e;
    }
    this.telemetry?.record({
      kind: 'turn',
      ok: this.turnOutcome === 'answer',
      outcome: this.turnOutcome,
      steps: this.turnSteps,
      durationMs: Date.now() - started,
      tokens: Math.max(0, estimateTokens(this.messages) - tokensBefore),
      toolCalls: 0,
      model: this.cfg.model,
      mode: this.options.mode,
      edits: this.checkpoints.depth,
    });
  }

  private async runTurn(userText: string, ev: AgentEvents, signal?: AbortSignal, images: string[] = []): Promise<void> {
    await this.refreshSystem();
    this.messages.push({ role: 'user', content: userText, ...(images.length ? { images } : {}) });
    this.checkpoints.beginTurn();
    this.lastSig = '';
    this.repeats = 0;
    this.turnAuto = false;
    this.turnApprovedTargets.clear();
    this.lastVerifyAt = 0;
    this.verifiesThisTurn = 0;
    this.verifyFailsThisTurn = 0;
    this.closingVerifies = 0;
    const turnStart = Date.now();

    const exclude: ReadonlySet<string> = this.options.isSub ? new Set(['task', 'todo_write', 'delegate']) : new Set();

    for (let step = 0; step < this.options.maxSteps; step++) {
      if (signal?.aborted) {
        this.turnOutcome = 'aborted';
        return;
      }
      this.turnSteps = step + 1;

      // 1) ضغط مخرجات الأدوات القديمة، 2) إن بقي السياق كبيراً: تلخيص ذكي
      const c = compactMessages(this.messages, this.options.tokenBudget);
      if (c.saved > 0) {
        this.messages = c.messages;
        ev.onNotice(`تم اختصار مخرجات الأدوات القديمة لتوفير ~${c.saved} توكن من السياق.`);
      }
      if (!this.options.isSub && estimateTokens(this.messages) > this.options.tokenBudget) {
        try {
          const n = await this.compact(signal, this.options.tokenBudget);
          if (n > 0) ev.onNotice(`لُخّصت ${n} رسالة قديمة لتوفير السياق، والعمل يستمر.`);
        } catch (e: any) {
          if (signal?.aborted) return;
          ev.onNotice(`تعذّر تلخيص المحادثة (${String(e?.message ?? e).slice(0, 80)}). سأتابع بالسياق الحالي.`);
        }
      }
      ev.onUsage({ tokens: estimateTokens(this.messages), budget: this.options.tokenBudget, saved: c.saved });

      const specs = specsForMode(this.options.mode, this.options.isSub ? [] : this.extraTools(), exclude);
      const res = await streamChat(this.cfg, this.messages, specs, signal, ev.onText, { onRetry: ev.onRetry });
      this.messages.push({
        role: 'assistant',
        content: res.content || null,
        tool_calls: res.toolCalls.length ? res.toolCalls : undefined,
      });

      if (res.toolCalls.length === 0) {
        // فحص الإغلاق: لا نسلّم عملاً فشل فيه التحقق بعد آخر تعديل.
        // نشغّله مرة أو مرتين كحد أقصى، ثم نُكمل حتى لا نُدخل الوكيل في حلقة لا تنتهي.
        if (
          this.options.autoVerify &&
          !this.options.isSub &&
          this.verifyFailsThisTurn > 0 &&
          this.closingVerifies < 2 &&
          this.checkpoints.currentChanges().length > 0
        ) {
          this.closingVerifies++;
          const files = this.checkpoints.currentChanges().map((c) => c.path).slice(0, 4);
          try {
            const results = await runVerify(this.root, files, { override: this.options.verifyCommand, signal });
            const block = formatVerify(results);
            const failed = results.filter((r) => !r.ok);
            this.telemetry?.record({ kind: 'verify', ok: !failed.length, file: files.join(','), command: 'فحص الإغلاق', summary: block.replace(/\s+/g, ' ').slice(0, 300) });
            if (failed.length && block) {
              this.verifyFailsThisTurn++;
              this.messages.push({
                role: 'user',
                content: `[فحص إغلاق آلي] قبل التسليم شغّلت التحقق على ما عدّلتَه ولم ينجح:\n${block}\nأصلح الأخطاء الآن ثم أنهِ. إن كان الفشل من إعداد المشروع أو البيئة لا من تعديلك فاذكر ذلك بوضوح واذكر السبب.`,
              });
              ev.onNotice('فحص الإغلاق فشل — أعيد الأخطاء للنموذج قبل التسليم.');
              continue;
            }
            ev.onNotice(`فحص الإغلاق: نجح (${results.map((r) => r.label).join('، ') || 'بلا فحوص'})`);
          } catch {
            /* تعذّر تشغيل الفحص: لا نمنع التسليم بسببه */
          }
        }
        ev.onUsage({ tokens: estimateTokens(this.messages), budget: this.options.tokenBudget, saved: 0 });
        return; // الإجابة النهائية
      }

      // أدوات القراءة وحدها تعمل بالتوازي؛ وإلا نكمل بالتتابع حفاظاً على ترتيب الموافقات
      const calls = res.toolCalls;
      const outs: string[] = [];
      const allRead = calls.length > 1 && calls.every((cl) => this.lookup(cl.function.name)?.kind === 'read');
      if (allRead) {
        outs.push(...(await Promise.all(calls.map((cl) => this.execTool(cl, ev, signal)))));
      } else {
        for (const cl of calls) outs.push(signal?.aborted ? 'تم إيقاف العملية قبل تنفيذها.' : await this.execTool(cl, ev, signal));
      }
      // كل tool_call يجب أن يحصل على رد حتى لو أُوقف الوكيل، وإلا يرفض الخادم الطلب التالي
      calls.forEach((cl, i) => this.messages.push({ role: 'tool', tool_call_id: cl.id, content: outs[i] }));
      if (signal?.aborted) return;
    }

    this.turnOutcome = 'limit';
    ev.onNotice(`توقف الوكيل بعد ${this.options.maxSteps} خطوة. أرسل "تابع" للمتابعة.`);
  }
}
