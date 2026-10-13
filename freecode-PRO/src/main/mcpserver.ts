// خادم MCP محلي: يعرض أدوات FreeCode نفسها لعملاء MCP (Claude Desktop وأمثاله)
// عبر stdio بصيغة JSON-RPC 2.0 — وهو الاتجاه المعاكس لدعم العميل في mcp.ts.
//
// قرارات أمان مقصودة (لأن العميل قد يكون برنامجاً آخر لا واجهةً تعرف بنود المشروع):
//   • القراءة فقط افتراضاً: read_file/list_dir/search_files/project_info فقط.
//   • `--allow-writes` يضيف write_file، و`--allow-commands` يضيف run_command — إضافة صريحة.
//   • الأوامر المدمّرة محجوبة **دائماً** حتى مع --allow-commands (نفس كشف الجسر/الوكيل).
//   • المسارات محصورة في مجلد المشروع (`resolveInside`).
//   • قواعد المستخدم من `.freecode/rules.json` (أو --rules): deny يحجب، وask يحتاج --yes
//     وإلا يُرفض بصراحة (لا نافذة موافقة في stdio — والصمت ليس موافقة).
//
// التشغيل:
//   node dist/main/mcpserver.js --root /path/to/project [--allow-writes] [--allow-commands] [--yes]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promises as fsp } from 'node:fs';
import { resolveInside, isDangerousCommand } from './tools';
import { listDir, searchFiles } from './files';
import { decide, emptyRules, parseRules, type Permissions } from './rules';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'freecode';

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  /** JSON Schema لوسائط الأداة (كما يتوقّعه MCP) */
  inputSchema: Record<string, unknown>;
  /** يحتاج --allow-writes أو --allow-commands */
  gate?: 'write' | 'command';
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });
const num = (description: string): Record<string, unknown> => ({ type: 'number', description });

export const MCP_TOOLS: McpToolDescriptor[] = [
  {
    name: 'read_file',
    title: 'قراءة ملف من المشروع',
    description: 'يقرأ ملفاً نصياً داخل مجلد المشروع ويعيد محتواه (بحد أقصى 20٬000 حرف).',
    inputSchema: { type: 'object', properties: { path: str('مسار نسبي داخل المشروع') }, required: ['path'] },
  },
  {
    name: 'list_dir',
    title: 'عرض محتوى مجلد',
    description: 'يعرض ملفات ومجلدات مسار داخل المشروع.',
    inputSchema: { type: 'object', properties: { path: str('مسار نسبي (افتراضياً جذر المشروع)') } },
  },
  {
    name: 'search_files',
    title: 'بحث عن ملفات بالاسم',
    description: 'يبحث عن ملفات يطابق اسمها نصاً معطى ويعيد المسارات.',
    inputSchema: { type: 'object', properties: { query: str('نص البحث'), max: num('أقصى عدد نتائج (1-50)') }, required: ['query'] },
  },
  {
    name: 'project_info',
    title: 'معلومات المشروع',
    description: 'ملخص عن المشروع المكشوف لهذا الخادم: المسار والوضع والأدوات المفعّلة وقواعد الصلاحيات.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'write_file',
    title: 'كتابة ملف',
    description: 'يكتب ملفاً كاملاً داخل المشروع (يحتاج تشغيل الخادم بـ--allow-writes).',
    inputSchema: { type: 'object', properties: { path: str('مسار نسبي داخل المشروع'), content: str('النص الكامل للملف') }, required: ['path', 'content'] },
    gate: 'write',
  },
  {
    name: 'run_command',
    title: 'تشغيل أمر في المشروع',
    description: 'ينفّذ أمر shell داخل مجلد المشروع (يحتاج --allow-commands، والأوامر المدمّرة محجوبة دائماً).',
    inputSchema: { type: 'object', properties: { command: str('الأمر'), timeoutMs: num('مهلة بالمللي ثانية (افتراضياً 60000)') }, required: ['command'] },
    gate: 'command',
  },
];

export interface McpServerOptions {
  root: string;
  allowWrites?: boolean;
  allowCommands?: boolean;
  /** اعتبر قواعد ask موافقةً مسبقةً (لبيئات تعرف ما تفعل) */
  autoApproveAsk?: boolean;
  permissions?: Permissions;
  shell?: (cmd: string, opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; output: string; timedOut: boolean }>;
  now?: () => number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

export interface McpReply {
  /** null = إشعار بلا رد */
  response: Record<string, unknown> | null;
  /** سطر تشخيصي اختياري (يُكتب في stderr) */
  log?: string;
}

const MAX_TEXT = 20_000;
const MAX_CMD_OUTPUT = 6_000;

const toolByName = (name: string): McpToolDescriptor | undefined => MCP_TOOLS.find((t) => t.name === name);

/**
 * نواة الخادم: استقبال رسالة JSON-RPC وإرجاع الرد — بلا أي اعتماد على stdio،
 * فتُختبر مباشرةً كما تعمل في الإنتاج.
 */
export class McpServerCore {
  private initialized = false;
  readonly root: string;
  private readonly perms: Permissions;

  constructor(private readonly opts: McpServerOptions) {
    this.root = path.resolve(opts.root);
    this.perms = opts.permissions ?? emptyRules().permissions;
  }

  /** الأدوات المتاحة فعلاً حسب أعلام التشغيل */
  availableTools(): McpToolDescriptor[] {
    return MCP_TOOLS.filter((t) => (t.gate === 'write' ? !!this.opts.allowWrites : t.gate === 'command' ? !!this.opts.allowCommands : true));
  }

  async handle(raw: string): Promise<McpReply> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(raw);
    } catch (e: any) {
      return { response: { jsonrpc: '2.0', id: null, error: { code: -32700, message: `JSON غير صالح: ${String(e?.message ?? e).slice(0, 120)}` } } };
    }
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return { response: { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'طلب غير صالح: لا يوجد method' } } };
    }
    const id = msg.id ?? null;
    const isNotification = msg.id === undefined;
    const ok = (result: unknown): McpReply => ({ response: isNotification ? null : { jsonrpc: '2.0', id, result } });
    const fail = (code: number, message: string): McpReply => ({ response: isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } } });

    switch (msg.method) {
      case 'initialize': {
        this.initialized = true;
        return ok({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: '1.0.0' },
          instructions: [
            `تتصل بـFreeCode على مشروع: ${this.root}`,
            this.opts.allowWrites || this.opts.allowCommands ? 'الأدوات المفعّلة تشمل الكتابة/التنفيذ حسب الأعلام الممرَّرة.' : 'هذا الخادم في وضع القراءة فقط (بلا كتابة ولا أوامر).',
            'المسارات محصورة في مجلد المشروع، والأوامر المدمّرة محجوبة دائماً.',
          ].join(' '),
        });
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return { response: null };
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: this.availableTools().map((t) => ({ name: t.name, description: `${t.title} — ${t.description}`, inputSchema: t.inputSchema })) });
      case 'tools/call': {
        const name = String(msg.params?.name ?? '');
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const r = await this.callTool(name, args);
        return ok({ content: [{ type: 'text', text: r.text }], isError: !r.ok });
      }
      default:
        return fail(-32601, `طريقة غير معروفة: ${msg.method}`);
    }
  }

  /** قرار القواعد لأداة (deny يمنع، ask يحتاج --yes، وإلا مسموح) */
  private gate(tool: string, args: Record<string, unknown>): { ok: boolean; why?: string; rule?: string } {
    const d = decide(this.perms, tool, args, this.root);
    if (d.action === 'deny') return { ok: false, why: `قاعدة الصلاحيات عند المستخدم تمنع ${tool}${d.rule ? ` (${d.rule})` : ''}`, rule: d.rule };
    if (d.action === 'ask' && !this.opts.autoApproveAsk) {
      return { ok: false, why: `قاعدة المستخدم تطلب موافقة على ${tool}${d.rule ? ` (${d.rule})` : ''} — لا نافذة موافقة في خادم stdio؛ شغّل الخادم بـ--yes إن كنت تقبل هذا مسبقاً`, rule: d.rule };
    }
    return { ok: true, rule: d.rule };
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const spec = toolByName(name);
    if (!spec) return { ok: false, text: `أداة غير معروفة: «${name}» — المتاح: ${this.availableTools().map((t) => t.name).join(', ')}` };
    if (spec.gate === 'write' && !this.opts.allowWrites) return { ok: false, text: 'الكتابة معطّلة في هذا الخادم — أعد تشغيله بـ--allow-writes لتفعيلها.' };
    if (spec.gate === 'command' && !this.opts.allowCommands) return { ok: false, text: 'تنفيذ الأوامر معطّل في هذا الخادم — أعد تشغيله بـ--allow-commands لتفعيله.' };

    const ruleArgs: Record<string, unknown> = name === 'run_command' ? { command: String(args.command ?? args.cmd ?? '') } : args;
    const g = this.gate(name, ruleArgs);
    if (!g.ok) return { ok: false, text: String(g.why) };

    try {
      switch (name) {
        case 'read_file': {
          const rel = String(args.path ?? '');
          if (!rel) return { ok: false, text: 'read_file يحتاج وسيط path' };
          const abs = resolveInside(this.root, rel);
          const raw = await fsp.readFile(abs, 'utf8');
          const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + '\n…[اقتُطع الباقي]' : raw;
          return { ok: true, text };
        }
        case 'list_dir': {
          const rel = String(args.path ?? '.') || '.';
          const entries = await listDir(this.root, rel);
          return { ok: true, text: entries.map((e) => `${e.isDir ? '📁' : '📄'} ${e.path}`).join('\n') || '(مجلد فارغ)' };
        }
        case 'search_files': {
          const q = String(args.query ?? '');
          if (!q) return { ok: false, text: 'search_files يحتاج وسيط query' };
          const max = Math.max(1, Math.min(50, Number(args.max) || 8));
          const hits = await searchFiles(this.root, q, max);
          return { ok: true, text: hits.length ? hits.join('\n') : 'لا نتائج' };
        }
        case 'project_info': {
          return {
            ok: true,
            text: [
              `المشروع: ${this.root}`,
              `الوضع: ${this.opts.allowWrites || this.opts.allowCommands ? [this.opts.allowWrites ? 'كتابة' : '', this.opts.allowCommands ? 'أوامر' : ''].filter(Boolean).join(' + ') : 'قراءة فقط'}`,
              `الأدوات: ${this.availableTools().map((t) => t.name).join(', ')}`,
              `قواعد مفعّلة: ${this.perms.allow.length + this.perms.ask.length + this.perms.deny.length}`,
            ].join('\n'),
          };
        }
        case 'write_file': {
          const rel = String(args.path ?? '');
          const content = typeof args.content === 'string' ? args.content : '';
          if (!rel) return { ok: false, text: 'write_file يحتاج وسيط path' };
          if (typeof args.content !== 'string') return { ok: false, text: 'write_file يحتاج وسيط content (نص الملف كاملاً)' };
          const abs = resolveInside(this.root, rel);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, content, 'utf8');
          return { ok: true, text: `كُتب ${rel} (${content.length} حرفاً)` };
        }
        case 'run_command': {
          const cmd = String(args.command ?? args.cmd ?? '').trim();
          if (!cmd) return { ok: false, text: 'run_command يحتاج وسيط command' };
          if (isDangerousCommand(cmd)) return { ok: false, text: `أمر مدمّر مرفوض دائماً: ${cmd}` };
          const timeoutMs = Math.max(1_000, Math.min(300_000, Number(args.timeoutMs) || 60_000));
          if (!this.opts.shell) return { ok: false, text: 'لا منفّذ أوامر مهيّأ في هذا الخادم' };
          const r = await this.opts.shell(cmd, { cwd: this.root, timeoutMs });
          const out = r.output.length > MAX_CMD_OUTPUT ? r.output.slice(0, MAX_CMD_OUTPUT) + '\n…[اقتُطع]' : r.output;
          return { ok: r.code === 0 && !r.timedOut, text: `رمز الخروج: ${r.timedOut ? 'مهلة' : r.code}\n${out}` };
        }
        default:
          return { ok: false, text: `أداة غير مدعومة: ${name}` };
      }
    } catch (e: any) {
      return { ok: false, text: String(e?.message ?? e).slice(0, 300) };
    }
  }

  get isInitialized(): boolean {
    return this.initialized;
  }
}

/** يقرأ قواعد المشروع (deny/ask تعمل دائماً) أو ملفاً صريحاً */
export function loadServerRules(root: string, rulesFile?: string): { permissions: Permissions; errors: string[] } {
  const file = rulesFile ? path.resolve(rulesFile) : path.join(root, '.freecode', 'rules.json');
  try {
    if (!fs.existsSync(file)) return { permissions: emptyRules().permissions, errors: [] };
    const parsed = parseRules(JSON.parse(fs.readFileSync(file, 'utf8')));
    return { permissions: parsed.rules.permissions, errors: parsed.errors };
  } catch (e: any) {
    return { permissions: emptyRules().permissions, errors: [`تعذّر قراءة ${file}: ${String(e?.message ?? e).slice(0, 120)}`] };
  }
}

/** يشغّل الخادم على stdio: سطر JSON لكل رسالة (مواصفة MCP) */
export async function serveStdio(core: McpServerCore, stdin: NodeJS.ReadableStream = process.stdin, stdout: NodeJS.WriteStream = process.stdout): Promise<void> {
  stdin.setEncoding('utf8');
  let buf = '';
  const write = (obj: unknown): void => {
    stdout.write(JSON.stringify(obj) + '\n');
  };
  await new Promise<void>((resolve) => {
    stdin.on('data', (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          void core.handle(line).then((reply) => {
            if (reply.log) process.stderr.write(reply.log + '\n');
            if (reply.response) write(reply.response);
          });
        }
        nl = buf.indexOf('\n');
      }
    });
    stdin.on('end', () => resolve());
  });
}

export const MCP_HELP = `خادم MCP محلي (FreeCode) — يعرض أدوات المشروع لعملاء MCP عبر stdio.

الاستخدام:
  freecode-mcp --root <مجلد المشروع> [خيارات]

الخيارات:
  --root <مجلد>      مجلد المشروع المكشوف (افتراضياً مجلد العمل الحالي)
  --allow-writes     فعّل write_file (معطّلة افتراضياً)
  --allow-commands   فعّل run_command (معطّلة افتراضياً، والأوامر المدمّرة محجوبة دائماً)
  --yes              اعتبر قواعد «ask» موافقةً مسبقة (وإلا رُفضت بصراحة)
  --rules <ملف>      ملف قواعد بديل (افتراضياً <المشروع>/.freecode/rules.json)
  -h, --help         هذه المساعدة

مثال إعداد Claude Desktop (claude_desktop_config.json):
{
  "mcpServers": {
    "freecode": { "command": "node", "args": ["/path/to/freecode/dist/main/mcpserver.js", "--root", "/path/to/project"] }
  }
}
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(MCP_HELP);
    return;
  }
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(val('--root') ?? process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    process.stderr.write(`مجلد غير موجود: ${root}\n`);
    process.exit(2);
  }
  const rulesFile = val('--rules');
  const { permissions, errors } = loadServerRules(root, rulesFile);
  for (const e of errors) process.stderr.write(`تنبيه قواعد: ${e}\n`);

  // منفّذ الأوامر: نفس محرّك FreeCode (shell.ts) — يُحمَّل بتأجيل كي لا يثقل وضع القراءة فقط
  const { runShell } = await import('./shell.js');
  const core = new McpServerCore({
    root,
    allowWrites: argv.includes('--allow-writes'),
    allowCommands: argv.includes('--allow-commands'),
    autoApproveAsk: argv.includes('--yes'),
    permissions,
    shell: (cmd, o) => runShell(cmd, { cwd: o.cwd, timeoutMs: o.timeoutMs, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } }),
  });
  process.stderr.write(`خادم MCP جاهز — المشروع: ${root} · الوضع: ${core.availableTools().map((t) => t.name).join(', ')}\n`);
  await serveStdio(core);
}

// لا نُشغّل main عند الاستيراد للاختبار
if (require.main === module) void main();
