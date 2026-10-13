// جسر «العقل الخارجي»: موقع ذكاء اصطناعي في صفحة داخل FreeCode يكتب أوامر،
// وFreeCode هو «اليد» التي تنفّذها على جهازك بعد موافقتك.
//
// وحدة نقية (بلا electron وبلا شبكة) ليمكن اختبارها بالكامل: بروتوكول التخاطب،
// سجل الأدوات وتنفيذها، حصر المسارات، قائمة النطاقات المسموحة، وسكربت الصفحة.
// أما ربط Electron (WebContentsView + IPC) ففي extbridgehost.ts.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveInside, isDangerousCommand } from './tools';
import { listDir, searchFiles } from './files';
import { decide, type Decision, type Permissions } from './rules';

// ---------------- البروتوكول ----------------
// الموقع يعرض الردود ماركداون منسّقاً فتضيع أسوار الكود، لذلك علامات نصية عادية.
// ونتقبّل كذلك كتل الكود وصيغة JSON المجرّدة حتى لا نعتمد على مزاج الموقع.

export const BRIDGE_START = '@@FC_START@@';
export const BRIDGE_END = '@@FC_END@@';
export const BRIDGE_RESULT_START = '@@FC_RESULT@@';

export interface BridgeCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface BridgeToolSpec {
  name: string;
  title: string;
  /** أسماء الوسائط كما تُكتب في الأمر */
  args: string[];
  /** يكتب على القرص أو ينفّذ أمراً ⇒ يحتاج موافقة/يُرفض في وضع القراءة فقط */
  mutates: boolean;
}

/** سجل الأدوات المتاحة للجسر — واحد فقط لكل رد، والنتيجة تُعاد للموقع */
export const BRIDGE_TOOLS: BridgeToolSpec[] = [
  { name: 'read_file', title: 'قراءة ملف', args: ['path', 'maxChars?'], mutates: false },
  { name: 'list_dir', title: 'عرض مجلد', args: ['path?'], mutates: false },
  { name: 'search_files', title: 'بحث عن ملفات بالاسم', args: ['query', 'max?'], mutates: false },
  { name: 'write_file', title: 'كتابة ملف كامل', args: ['path', 'content'], mutates: true },
  { name: 'run_command', title: 'تشغيل أمر', args: ['cmd', 'timeoutMs?'], mutates: true },
  { name: 'task_done', title: 'إعلان انتهاء المهمة', args: ['summary'], mutates: false },
];

export const bridgeToolNames = (): string[] => BRIDGE_TOOLS.map((t) => t.name);
const findTool = (name: string): BridgeToolSpec | undefined => BRIDGE_TOOLS.find((t) => t.name === name);

/** بصمة قصيرة للاستدعاء — لمنع تكرار نفس الأمر مرتين (الموقع قد يعيد طبعه) */
export function bridgeCallKey(call: BridgeCall): string {
  const args = call.args ?? {};
  // ترتيب ثابت للمفاتيح، والوسائط كما هي — فيتساوى استدعاءان متطابقان ويختلفان عند أي فرق
  const canon = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
  return createHash('sha256').update(`${call.tool}:${canon}`).digest('hex').slice(0, 16);
}

const asCall = (value: unknown): BridgeCall | string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'الكتلة ليست كائن JSON';
  const o = value as Record<string, unknown>;
  const tool = typeof o.tool === 'string' ? o.tool.trim() : '';
  if (!tool) return 'لا يوجد حقل «tool»';
  if (!findTool(tool)) return `أداة غير معروفة: «${tool}» — المتاح: ${bridgeToolNames().join(', ')}`;
  const args = o.args === undefined ? {} : o.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'حقل «args» يجب أن يكون كائناً';
  return { tool, args: args as Record<string, unknown> };
};

/**
 * يستخرج استدعاءات الأدوات من رد الموقع. الصيغ المقبولة بالأولوية:
 *   1) @@FC_START@@ {json} @@FC_END@@        (الأساسية — تنجو من تنسيق الماركداون)
 *   2) كتلة كود فيها {"tool": …}            (```json / ```freecode / ``` )
 *   3) سطر مجرّد يبدأ بـ {"tool":           (حين يُسقط الموقع العلامات)
 * يُرجع كل الكتل وبالأخطاء العربية، ولا ينفّذ شيئاً بذاته.
 */
export function parseBridgeCalls(text: string): { calls: BridgeCall[]; errors: string[]; blocks: number } {
  const src = String(text ?? '');
  const raw: string[] = [];
  let blocks = 0;

  // 1) العلامات الصريحة (قد تكون على عدة أسطر)
  const marked = new RegExp(`${BRIDGE_START.replace(/[@]/g, '@')}\\s*([\\s\\S]*?)\\s*${BRIDGE_END.replace(/[@]/g, '@')}`, 'g');
  for (const m of src.matchAll(marked)) {
    blocks++;
    raw.push(m[1]);
  }

  // 2) كتل الكود (سطر افتتاحي ```json أو ```freecode أو ``` ثم جسم)
  if (!raw.length) {
    for (const m of src.matchAll(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/g)) {
      const body = m[1].trim();
      if (/[{[]/.test(body) && /"?(tool|args)"?\s*:/.test(body)) {
        blocks++;
        raw.push(body);
      }
    }
  }

  // 3) سطر مجرّد يبدأ بكائن فيه tool (سطر واحد فقط)
  if (!raw.length) {
    for (const line of src.split('\n')) {
      const t = line.trim();
      if (t.startsWith('{') && /"tool"\s*:/.test(t)) {
        blocks++;
        raw.push(t);
      }
    }
  }

  const calls: BridgeCall[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const one of raw) {
    const body = one.trim();
    if (!body) {
      errors.push('كتلة فارغة');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e: any) {
      const hint = /[\u0600-\u06FF]/.test(body) ? ' — تأكد أن النصوص العربية داخل علامات اقتباس مزدوجة صحيحة' : '';
      errors.push(`JSON غير صالح: ${String(e?.message ?? e).slice(0, 90)}${hint}`);
      continue;
    }
    const call = asCall(parsed);
    if (typeof call === 'string') {
      errors.push(call);
      continue;
    }
    const key = bridgeCallKey(call);
    if (seen.has(key)) {
      errors.push(`استدعاء مكرّر أُهمل: ${call.tool}`);
      continue;
    }
    seen.add(key);
    calls.push(call);
  }
  // التعليمات: استدعاء واحد لكل رد ⇒ نُنفّذ الأخير فقط ونخبر بالباقي
  return { calls, errors, blocks };
}

/** نص التعليمات الذي يُلصق في الموقع مرة واحدة (أول رسالة) */
export function bridgeInstructions(opts: { root: string; siteUrl?: string } = { root: '.' }): string {
  const tools = BRIDGE_TOOLS.map((t) => `  • ${t.name}(${t.args.join(', ')}) — ${t.title}${t.mutates ? ' [يحتاج موافقة المستخدم]' : ''}`).join('\n');
  return [
    'أنت تبرمج على جهاز المستخدم عبر برنامج FreeCode. أنت «العقل» وFreeCode هو «اليد» التي تنفّذ فعلياً.',
    `مجلد المشروع: ${opts.root}`,
    '',
    'قواعد إلزامية:',
    `1) لتنفيذ أي إجراء اكتب سطراً واحداً فقط في آخر ردك بهذه الصيغة ثم توقف وانتظر النتيجة:`,
    `${BRIDGE_START} {"tool":"اسم_الأداة","args":{...}} ${BRIDGE_END}`,
    '2) استدعاء واحد فقط في كل رد. لا تكتب كتلتين.',
    '3) لا تفترض نجاح أي أمر قبل أن تصلك رسالة النتيجة.',
    '4) المسارات نسبية لمجلد المشروع، ولا يمكن الخروج منه.',
    '5) وإن احتجت معلومة فاكتب الشرح المختصر ثم الاستدعاء. وإن انتهت المهمة استخدم أداة task_done.',
    '',
    'الأدوات المتاحة:',
    tools,
    '',
    `تُعاد إليك النتيجة بين ${BRIDGE_RESULT_START} و ${BRIDGE_END} — اقرأها ثم تابع أو أنهِ.`,
  ].join('\n');
}

/** نص النتيجة الذي يُلصق في خانة الإدخال في الموقع (يعود للعقل) */
export function formatBridgeAck(seq: number, call: BridgeCall, outcome: { ok: boolean; text: string; truncated?: boolean }): string {
  const head = outcome.ok ? `✅ نتيجة #${seq} — ${call.tool}` : `❌ فشل #${seq} — ${call.tool}`;
  const payload = { call: seq, tool: call.tool, ok: outcome.ok, result: outcome.text, ...(outcome.truncated ? { truncated: true } : {}) };
  return `${head}\n${BRIDGE_RESULT_START} ${JSON.stringify(payload)} ${BRIDGE_END}\nتابع الخطوة التالية، أو استخدم task_done إن انتهيت.`;
}

// ---------------- قائمة النطاقات المسموحة ----------------
export const BRIDGE_DEFAULT_HOSTS = ['arena.ai', 'lmarena.ai', 'claude.ai', 'chatgpt.com', 'chat.mistral.ai', 'gemini.google.com'];

/** هل يُسمح بفتح هذا العنوان داخل لوحة الجسر؟ (منع التنقل خارج النطاقات المسموحة) */
export function bridgeHostAllowed(url: string, allow: string[] = BRIDGE_DEFAULT_HOSTS): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return allow.some((a) => {
    const want = String(a ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (!want) return false;
    return host === want || host.endsWith(`.${want}`);
  });
}

// ---------------- التنفيذ ----------------
export interface ShellLike {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted?: boolean;
}

export interface BridgeApproveRequest {
  tool: string;
  title: string;
  summary: string;
  args: Record<string, unknown>;
}

export interface BridgeAuditEntry {
  at: number;
  seq: number;
  tool: string;
  argsSummary: string;
  decision: 'auto' | 'approved' | 'denied' | 'readonly' | 'blocked-dangerous' | 'blocked-rule' | 'error';
  ok: boolean;
  ms: number;
  note?: string;
}

export interface BridgeDeps {
  root: string;
  /** ask = موافقة لكل كتابة/أمر · readonly = لا كتابة ولا أوامر إطلاقاً */
  mode: 'ask' | 'readonly';
  approve: (req: BridgeApproveRequest) => Promise<boolean>;
  shell: (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<ShellLike>;
  /**
   * قواعد allow/ask/deny الخاصة بالمستخدم — تُطبَّق على أدوات الجسر مثل الوكيل نفسه:
   * deny يمنع الاستدعاء مهما كان الوضع، وallow يتجاوز نافذة الموافقة، وask يفرضها
   * حتى على القراءة. تُمرَّر دالةً (لا كائناً) لأن المستخدم قد يعدّل قواعده واللوحة مفتوحة،
   * فنقرأها حيّة عند كل استدعاء بدل تجميد نسخة قديمة.
   */
  permissions?: Permissions | (() => Permissions | undefined);
  audit?: (entry: BridgeAuditEntry) => void | Promise<void>;
  /** حدّ الاستدعاءات في الدقيقة (حماية من حلقة لا نهائية في الموقع) */
  maxCallsPerMinute?: number;
  now?: () => number;
  onEvent?: (line: string) => void;
}

export interface BridgeOutcome {
  ok: boolean;
  /** النص الذي يُعاد إلى الموقع */
  text: string;
  truncated?: boolean;
  decision: BridgeAuditEntry['decision'];
  done?: boolean;
}

const MAX_TEXT = 20_000;
const MAX_CMD_OUTPUT = 6_000;

const clip = (s: string, max = MAX_TEXT): { text: string; truncated: boolean } =>
  s.length <= max ? { text: s, truncated: false } : { text: s.slice(0, max) + '\n…[اقتُطع الباقي]', truncated: true };

const argStr = (call: BridgeCall, name: string): string => {
  const v = call.args?.[name];
  return typeof v === 'string' ? v : '';
};

/**
 * ينفّذ استدعاءً واحداً من الموقع عبر أدوات FreeCode نفسها:
 * حصر المسارات بـresolveInside، وقواعد allow/ask/deny، وكشف الأوامر المدمّرة،
 * وسجل تدقيق JSONL. كل شيء يحتاج موافقة صريحة إلا القراءة.
 */
export class BridgeRunner {
  private seq = 0;
  private stamps: number[] = [];
  private stopped: string | null = null;
  readonly stats = { calls: 0, ok: 0, failed: 0, approved: 0, denied: 0, lastError: '' };

  constructor(private readonly deps: BridgeDeps) {}

  get mode(): 'ask' | 'readonly' {
    return this.deps.mode;
  }

  setMode(mode: 'ask' | 'readonly'): void {
    this.deps.mode = mode;
  }

  /** إيقاف فوري (زر «أوقف الجسر») — كل استدعاء بعده يُرفض حتى إعادة التشغيل */
  stop(reason = 'أوقفه المستخدم'): void {
    this.stopped = reason;
  }

  resume(): void {
    this.stopped = null;
  }

  get stoppedReason(): string | null {
    return this.stopped;
  }

  get callCount(): number {
    return this.seq;
  }

  private rateExceeded(): boolean {
    const now = (this.deps.now ?? Date.now)();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    const max = this.deps.maxCallsPerMinute ?? 12;
    if (this.stamps.length >= max) return true;
    this.stamps.push(now);
    return false;
  }

  /** قواعد المستخدم الحالية — تُقرأ حيّة عند كل استدعاء (الدالة تُحترم كما الكائن) */
  private perms(): Permissions | undefined {
    const p = this.deps.permissions;
    return typeof p === 'function' ? p() : p;
  }

  /** عدد القواعد المفعّلة على الجسر (للسطر التشخيصي والواجهة) */
  rulesCount(): number {
    const p = this.perms();
    return p ? p.allow.length + p.ask.length + p.deny.length : 0;
  }

  /** قرار قواعد المستخدم لهذا الاستدعاء: deny يمنع · ask يسأل · allow يمرّ بلا سؤال */
  private ruleFor(call: BridgeCall): Decision {
    const p = this.perms();
    if (!p) return { action: 'default' };
    try {
      // الاسم الرسمي لوسيط الأمر عند الفاحص هو «command»؛ نمرّره صراحةً كي تُطابَق
      // قواعد مثل run_command(npm test:*) على أوامر الجسر بدل أن تُتجاوَز بصمت
      const args = call.tool === 'run_command' ? { command: argStr(call, 'cmd') } : (call.args ?? {});
      return decide(p, call.tool, args, this.deps.root);
    } catch {
      // قاعدة مريبة (نمط غير صالح مثلاً) لا تُسقط التنفيذ: نسقط إلى السلوك الافتراضي (سؤال)
      return { action: 'default' };
    }
  }

  async run(call: BridgeCall): Promise<BridgeOutcome> {
    const started = (this.deps.now ?? Date.now)();
    const seq = ++this.seq;
    const spec = findTool(call.tool);
    const finish = async (
      ok: boolean,
      text: string,
      decision: BridgeAuditEntry['decision'],
      note?: string,
      extra?: { truncated?: boolean; done?: boolean },
    ): Promise<BridgeOutcome> => {
      this.stats.calls++;
      if (ok) this.stats.ok++;
      else {
        this.stats.failed++;
        this.stats.lastError = text.slice(0, 160);
      }
      if (decision === 'approved') this.stats.approved++;
      if (decision === 'denied') this.stats.denied++;
      const entry: BridgeAuditEntry = {
        at: started,
        seq,
        tool: call.tool,
        argsSummary: this.argsSummary(call),
        decision,
        ok,
        ms: (this.deps.now ?? Date.now)() - started,
        note,
      };
      try {
        await this.deps.audit?.(entry);
      } catch {
        /* فشل السجل لا يُسقط التنفيذ */
      }
      this.deps.onEvent?.(`${ok ? '✅' : '❌'} #${seq} ${call.tool} — ${text.split('\n')[0].slice(0, 110)}`);
      return { ok, text, decision, truncated: extra?.truncated, done: extra?.done };
    };

    if (this.stopped) return finish(false, `الجسر متوقف: ${this.stopped} — أعد تشغيله من /bridge resume`, 'error');
    if (!spec) return finish(false, `أداة غير معروفة: «${call.tool}» — المتاح: ${bridgeToolNames().join(', ')}`, 'error');
    if (this.rateExceeded()) {
      return finish(false, `تجاوزتَ حدّ ${this.deps.maxCallsPerMinute ?? 12} استدعاءً في الدقيقة — انتظر قليلاً ثم أعد المحاولة (حماية من حلقة لا نهائية).`, 'error');
    }

    const root = this.deps.root;
    // قواعد المستخدم تسبق كل شيء (عدا الحجب الأمني أعلاه): deny يمنع مهما كان الوضع
    const rule = this.ruleFor(call);
    if (rule.action === 'deny') {
      return finish(
        false,
        `قاعدة الصلاحيات عندك تمنع «${call.tool}»${rule.rule ? ` (${rule.rule})` : ''} — عدّلها من الإعدادات ← قواعد الصلاحيات إن أردت السماح للجسر.`,
        'blocked-rule',
        rule.rule,
      );
    }
    try {
      switch (call.tool) {
        case 'read_file': {
          const rel = argStr(call, 'path');
          if (!rel) return finish(false, 'read_file يحتاج وسيط “path”', 'error');
          if (rule.action === 'ask') {
            // قاعدة ask عند المستخدم تفرض نافذة موافقة حتى على القراءة (مثل deny read_file(.env*))
            const okRead = await this.deps.approve({ tool: 'read_file', title: 'قراءة ملف (طلب من الموقع)', summary: `قراءة ${rel}`, args: { path: rel } });
            if (!okRead) return finish(false, `رفض المستخدم قراءة ${rel}`, 'denied');
          }
          const maxChars = Math.max(200, Math.min(200_000, Number(call.args?.maxChars) || MAX_TEXT));
          const abs = resolveInside(root, rel); // يرفض الخروج من مجلد المشروع
          const raw = await fs.readFile(abs, 'utf8');
          const c = clip(raw, maxChars);
          return finish(true, `محتوى ${rel} (${raw.length} حرفاً${c.truncated ? '، مقتطع' : ''}):\n${c.text}`, rule.action === 'ask' ? 'approved' : 'auto', undefined, { truncated: c.truncated });
        }
        case 'list_dir': {
          const rel = argStr(call, 'path') || '.';
          if (rule.action === 'ask') {
            const okList = await this.deps.approve({ tool: 'list_dir', title: 'عرض مجلد (طلب من الموقع)', summary: `عرض ${rel}`, args: { path: rel } });
            if (!okList) return finish(false, `رفض المستخدم عرض ${rel}`, 'denied');
          }
          const entries = await listDir(root, rel);
          const lines = entries.map((e) => `${e.isDir ? '📁' : '📄'} ${e.path}`);
          return finish(true, `محتوى ${rel} (${entries.length} عنصراً):\n${lines.join('\n').slice(0, MAX_TEXT)}`, rule.action === 'ask' ? 'approved' : 'auto');
        }
        case 'search_files': {
          const q = argStr(call, 'query');
          if (!q) return finish(false, 'search_files يحتاج وسيط “query”', 'error');
          if (rule.action === 'ask') {
            const okSearch = await this.deps.approve({ tool: 'search_files', title: 'بحث عن ملفات (طلب من الموقع)', summary: `بحث «${q}»`, args: { query: q } });
            if (!okSearch) return finish(false, `رفض المستخدم البحث عن «${q}»`, 'denied');
          }
          const max = Math.max(1, Math.min(50, Number(call.args?.max) || 8));
          const hits = await searchFiles(root, q, max);
          return finish(true, hits.length ? `نتائج «${q}»:\n${hits.join('\n')}` : `لا نتائج للمطابقة «${q}»`, rule.action === 'ask' ? 'approved' : 'auto');
        }
        case 'task_done': {
          const summary = argStr(call, 'summary') || '(بلا وصف)';
          return finish(true, `أُعلن انتهاء المهمة: ${summary}`, 'auto', undefined, { done: true });
        }
        case 'write_file': {
          const rel = argStr(call, 'path');
          const content = typeof call.args?.content === 'string' ? (call.args.content as string) : '';
          if (!rel) return finish(false, 'write_file يحتاج وسيط “path”', 'error');
          if (!content && call.args?.content !== '') return finish(false, 'write_file يحتاج وسيط “content” (نص الملف كاملاً)', 'error');
          const abs = resolveInside(root, rel);
          if (this.deps.mode === 'readonly') {
            return finish(false, `الجسر في وضع القراءة فقط — رُفضت كتابة ${rel}. (بدّل بـ/bridge mode ask)`, 'readonly');
          }
          const lines = content.split('\n').length;
          // قاعدة allow عند المستخدم على هذا النمط تُغني عن نافذة الموافقة (نفس سلوك الوكيل)
          const auto = rule.action === 'allow';
          const okApprove =
            auto ||
            (await this.deps.approve({
              tool: 'write_file',
              title: 'كتابة ملف (طلب من الموقع)',
              summary: `كتابة ${rel} — ${content.length} حرفاً / ${lines} سطراً`,
              args: { path: rel, content },
            }));
          if (!okApprove) return finish(false, `رفض المستخدم كتابة ${rel}`, 'denied');
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, content, 'utf8');
          return finish(
            true,
            `كُتب ${rel} (${content.length} حرفاً، ${lines} سطراً)${auto ? ` — بقاعدة سماح عندك${rule.rule ? ` (${rule.rule})` : ''}` : ''}`,
            auto ? 'auto' : 'approved',
            auto ? `rule=${rule.rule ?? 'allow'}` : 'write_file',
          );
        }
        case 'run_command': {
          const cmd = argStr(call, 'cmd');
          if (!cmd) return finish(false, 'run_command يحتاج وسيط “cmd”', 'error');
          if (this.deps.mode === 'readonly') {
            return finish(false, `الجسر في وضع القراءة فقط — رُفض تشغيل: ${cmd}`, 'readonly');
          }
          if (isDangerousCommand(cmd)) {
            return finish(false, `أمر مدمّر مرفوض دائماً من الجسر: ${cmd} — إن كنت متأكداً نفّذه بنفسك من الطرفية.`, 'blocked-dangerous');
          }
          const auto = rule.action === 'allow';
          const okApprove = auto
            ? true
            : await this.deps.approve({ tool: 'run_command', title: 'تشغيل أمر (طلب من الموقع)', summary: cmd, args: { cmd } });
          if (!okApprove) return finish(false, `رفض المستخدم تشغيل: ${cmd}`, 'denied');
          const timeoutMs = Math.max(1_000, Math.min(300_000, Number(call.args?.timeoutMs) || 60_000));
          const r = await this.deps.shell(cmd, { cwd: root, timeoutMs });
          const out = clip(r.timedOut ? `انتهت المهلة (${Math.round(timeoutMs / 1000)}ث)\n${r.output}` : r.output, MAX_CMD_OUTPUT);
          const code = r.timedOut ? 'مهلة' : r.code;
          return finish(
            r.code === 0 && !r.timedOut,
            `نفّذت: ${cmd}\nرمز الخروج: ${code}${r.timedOut ? ' (مهلة)' : ''}${auto ? ' — بقاعدة سماح عندك' : ''}\nالمخرجات:\n${out.text || '(بلا مخرجات)'}`,
            auto ? 'auto' : 'approved',
            auto ? `exit=${code} · rule=${rule.rule ?? 'allow'}` : `exit=${code}`,
            { truncated: out.truncated },
          );
        }
        default:
          return finish(false, `أداة غير مدعومة: ${call.tool}`, 'error');
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      return finish(false, msg, 'error');
    }
  }

  private argsSummary(call: BridgeCall): string {
    if (call.tool === 'write_file') return `path=${argStr(call, 'path')} · ${String(call.args?.content ?? '').length} حرفاً`;
    if (call.tool === 'run_command') return `cmd=${argStr(call, 'cmd').slice(0, 160)}`;
    if (call.tool === 'read_file' || call.tool === 'list_dir') return `path=${argStr(call, 'path') || '.'}`;
    if (call.tool === 'search_files') return `query=${argStr(call, 'query').slice(0, 80)}`;
    return JSON.stringify(call.args ?? {}).slice(0, 160);
  }
}

/** سطر ملخص لحالة الجسر (يظهر في /bridge status وفي المحادثة) */
export function bridgeStatusLine(s: {
  open: boolean;
  url?: string;
  root: string;
  mode: 'ask' | 'readonly';
  calls: number;
  ok: number;
  failed: number;
  blocked: number;
  stopping?: string | null;
  /** عدد قواعد الصلاحيات المفعّلة على الجسر (اختياري — يظهر حين يوجد شيء) */
  rules?: number;
}): string {
  const state = s.stopping ? `متوقف (${s.stopping})` : s.open ? 'مفتوح' : 'مغلق';
  return `الجسر: ${state}${s.url ? ` · ${s.url}` : ''} · المشروع: ${s.root} · الوضع: ${s.mode === 'readonly' ? 'قراءة فقط' : 'موافقة على الكتابة والأوامر'}${s.rules ? ` · قواعد مفعّلة ${s.rules}` : ''} · استدعاءات ${s.calls} (نجح ${s.ok} · فشل ${s.failed} · مرفوض ${s.blocked})`;
}

export function bridgeAuditJsonl(e: BridgeAuditEntry): string {
  return JSON.stringify(e) + '\n';
}

const decisionAr: Record<BridgeAuditEntry['decision'], string> = {
  auto: 'قراءة',
  approved: 'وافق المستخدم',
  denied: 'رفض المستخدم',
  readonly: 'وضع القراءة فقط',
  'blocked-dangerous': 'محجوب (خطر)',
  'blocked-rule': 'محجوب (قاعدة عندك)',
  error: 'خطأ',
};

/** تقرير سجل الجسر — يُقرأ من .freecode/bridge-log.jsonl */
export function formatBridgeLog(entries: BridgeAuditEntry[]): string {
  if (!entries.length) return 'لا استدعاءات مسجَّلة بعد — افتح لوحة الجسر وأرسل مهمة من الموقع.';
  const lines: string[] = [`### سجل الجسر (${entries.length} استدعاء)`, '', '| # | الأداة | القرار | النتيجة | الزمن | التفاصيل |', '|---|---|---|---|---|---|'];
  for (const e of entries.slice(-20)) {
    lines.push(`| ${e.seq} | ${e.tool} | ${decisionAr[e.decision] ?? e.decision} | ${e.ok ? '✅' : '❌'} | ${e.ms}ms | ${String(e.argsSummary).replace(/\|/g, '/').slice(0, 70)} |`);
  }
  const denied = entries.filter((e) => e.decision === 'denied' || e.decision === 'blocked-dangerous').length;
  const failed = entries.filter((e) => !e.ok).length;
  lines.push('', `> ${entries.length} استدعاء: ${entries.length - failed} نجح · ${failed} فشل · ${denied} مرفوض — وكل استدعاء يحتاج موافقتك إلا القراءة.`);
  return lines.join('\n');
}

// ---------------- سكربت الصفحة ----------------
// يعمل داخل صفحة الموقع نفسها (main world) عبر executeJavaScript، ويتخاطب مع FreeCode
// عبر جسر contextBridge بالاسم fcBridge. لا يعتمد على محددات ثابتة: يكتشف خانة
// الإدخال وزرّ الإرسال تلقائياً، ويراقب نموّ آخر فقرة لتحديد اكتمال الرد.

export const BRIDGE_SELECTORS_DEFAULT = {
  input: 'textarea, [contenteditable="true"], input[type="text"]',
  send: 'button[type="submit"], button[aria-label*="send" i], button[data-testid*="send" i]',
  message: 'article, [data-message-author-role], .prose, [class*="message" i], [class*="markdown" i], p',
};

export function bridgePageScript(opts: { selectors?: Partial<typeof BRIDGE_SELECTORS_DEFAULT>; idleMs?: number; debounceMs?: number } = {}): string {
  const sel = { ...BRIDGE_SELECTORS_DEFAULT, ...(opts.selectors ?? {}) };
  const idleMs = Math.max(800, opts.idleMs ?? 2500);
  const debounceMs = Math.max(150, opts.debounceMs ?? 400);
  return `(() => {
  if (window.__fcBridgeInstalled) { window.__fcBridgeRescan && window.__fcBridgeRescan(); return 'already'; }
  window.__fcBridgeInstalled = true;
  const SEL = ${JSON.stringify(sel)};
  const START = ${JSON.stringify(BRIDGE_START)};
  const END = ${JSON.stringify(BRIDGE_END)};
  const RESULT = ${JSON.stringify(BRIDGE_RESULT_START)};
  const IDLE_MS = ${idleMs};
  const DEBOUNCE_MS = ${debounceMs};
  const seen = new Set();
  let busy = false, timer = null, lastLen = 0, lastGrowth = Date.now(), lastText = '';

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 30 && r.height > 12 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  };
  const pickInput = () => {
    const cands = [...document.querySelectorAll(SEL.input)].filter(visible);
    // الأكبر والأقرب لأسفل الشاشة (خانات الدردشة) أولى
    return cands.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (rb.top + rb.width * 0.001) - (ra.top + ra.width * 0.001);
    }).pop() || null;
  };
  const pickSend = () => [...document.querySelectorAll(SEL.send)].filter(visible).pop() || null;
  const candidates = () => [...document.querySelectorAll(SEL.message)].filter(visible).map((el) => el);
  const lastTextOf = () => {
    const all = candidates();
    const el = all[all.length - 1];
    return el ? el.innerText || '' : '';
  };

  const setInput = (text) => {
    const el = pickInput();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
    return true;
  };
  const submit = () => {
    const btn = pickSend();
    if (btn && !btn.disabled) { btn.click(); return 'click'; }
    return 'enter'; // تُضغط Enter من العملية الرئيسية (أوثق من أحداث JS)
  };

  const extract = (text) => {
    const t = String(text || '');
    const marked = t.split(START).pop().split(END)[0];
    if (t.includes(START) && marked && marked.includes('{')) return marked.trim();
    const fence = t.match(/\`\`\`[a-zA-Z]*\\s*\\n?([\\s\\S]*?)\`\`\`/);
    if (fence && /"tool"\\s*:/.test(fence[1])) return fence[1].trim();
    const line = t.split('\\n').map((x) => x.trim()).filter((x) => x.startsWith('{') && /"tool"\\s*:/.test(x)).pop();
    return line || '';
  };

  const handle = async () => {
    if (busy) return;
    const text = lastTextOf();
    if (!text || text === lastText) return;
    lastText = text;
    const call = extract(text);
    if (!call) return;
    const key = call.replace(/\\s+/g, '');
    if (seen.has(key)) return;
    seen.add(key);
    busy = true;
    try {
      const ack = await window.fcBridge.call(call);
      if (ack && setInput(ack)) {
        const how = submit();
        if (how === 'enter') await window.fcBridge.enter();
      }
    } catch (e) {
      setInput('تعذّر تنفيذ الأمر في FreeCode: ' + String(e));
    } finally {
      busy = false;
      lastGrowth = Date.now();
    }
  };

  const tick = () => {
    const text = lastTextOf();
    if (text.length !== lastLen) { lastLen = text.length; lastGrowth = Date.now(); }
    // لا ننفّذ إلا بعد أن يتوقف الموقع عن الكتابة (ردّ اكتمل)
    if (!busy && Date.now() - lastGrowth > IDLE_MS && lastLen > 0) { handle(); lastGrowth = Date.now(); }
  };
  window.__fcBridgeRescan = () => { lastLen = 0; lastText = ''; lastGrowth = Date.now(); };
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(tick, DEBOUNCE_MS); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setInterval(tick, IDLE_MS);
  return 'installed: inputs=' + document.querySelectorAll(SEL.input).length + ' send=' + document.querySelectorAll(SEL.send).length + ' msgs=' + document.querySelectorAll(SEL.message).length;
})();`;
}
