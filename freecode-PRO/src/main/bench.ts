import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, DEFAULT_OPTIONS, type AgentEvents } from './agent';
import { Telemetry, summarizeTelemetry, type TelemetryEvent } from './telemetry';
import { discoverSkills, type Skill } from './skills';
import { discoverPlugins, mergePluginRules, type Plugin } from './plugins';
import { McpManager } from './mcp';
import { emptyRules } from './rules';

/**
 * منصة قياس موثوقية الوكيل (benchmark) — تعمل بلا إنترنت وبلا موديل حقيقي:
 * موديل مبرمَج (سكربت) يعطي خطوات محدّدة، ونقيس هل نفّذ الوكيل المهمة فعلاً
 * وما الذي كلفه ذلك (خطوات، توكنات، فشل تحقق، نقرات موافقة).
 *
 * التشغيل: npm run bench        (تقرير عربي + كود خروج 1 عند أي إخفاق)
 *          npm run bench -- --json
 */

type Step = { text?: string[]; calls?: { name: string; args: unknown }[]; status?: number; delay?: number };

interface Scenario {
  name: string;
  /** وصف قصير بالعربية يظهر في التقرير */
  what: string;
  /** ملفات البداية (نسبة إلى جذر المستودع) */
  files: Record<string, string>;
  /** خطوات الموديل المبرمَج */
  script: Step[];
  /** موافقة الأدوات: تُستدعى لكل أداة تحتاج موافقة */
  approve?: (name: string, args: any, n: number) => boolean | 'turn' | 'file';
  options?: Partial<typeof DEFAULT_OPTIONS>;
  /** تهيئة إضافية قبل التشغيل (مهارات/إضافات/خادم MCP…) — نتيجتها تصل إلى setup */
  prepare?: (ws: string) => Promise<unknown> | unknown;
  /** حقن ما جهّزته prepare في الوكيل قبل التشغيل */
  setup?: (agent: Agent, extra: unknown, ws: string) => Promise<void> | void;
  /** تنظيف بعد الفحص (إيقاف خوادم فرعية مثلاً) */
  cleanup?: (extra: unknown) => void;
  /** الفحص: يعيد null عند النجاح أو نص الخطأ */
  check: (ws: string, ctx: { telemetry: TelemetryEvent[]; approvals: number; steps: number; log: string[]; requests: any[] }) => string | null;
}

// ---------- أدوات مساعدة ----------

function sse(res: http.ServerResponse, obj: unknown): void {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/** خادم موديل مبرمَج (SSE متوافق مع OpenAI) */
function mockServer(script: Step[]): { server: http.Server; state: { requests: any[] } } {
  const state = { requests: [] as any[] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let payload: any = {};
      try {
        payload = JSON.parse(body);
      } catch {
        /* نص تالف */
      }
      state.requests.push(payload);
      const n = state.requests.length - 1;
      const step: Step = script[Math.min(n, script.length - 1)] ?? {};
      if (step.status) {
        res.writeHead(step.status, { 'retry-after': '0' });
        res.end('rate limited');
        return;
      }
      const respond = (): void => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const t of step.text ?? []) sse(res, { choices: [{ delta: { content: t } }] });
        (step.calls ?? []).forEach((c, i) => {
          const json = JSON.stringify(c.args ?? {});
          const cut = Math.floor(json.length / 2);
          sse(res, { choices: [{ delta: { tool_calls: [{ index: i, id: `c${n}_${i}`, function: { name: c.name, arguments: json.slice(0, cut) } }] } }] });
          sse(res, { choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: json.slice(cut) } }] } }] });
        });
        sse(res, { choices: [{ delta: {}, finish_reason: step.calls?.length ? 'tool_calls' : 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      if (step.delay) setTimeout(respond, step.delay);
      else respond();
    });
  });
  return { server, state };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as any).port)));
}

function writeFixture(ws: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function gitInit(ws: string): void {
  try {
    execFileSync('git', ['init', '-q'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: ws, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.email=b@x', '-c', 'user.name=b', 'commit', '-qm', 'init'], { cwd: ws, stdio: 'ignore' });
  } catch {
    /* git غير متاح: المنصة تعمل بدونه */
  }
}

// ---------- السيناريوهات ----------

export const SCENARIOS: Scenario[] = [
  {
    name: 'create-file',
    what: 'مهمة بسيطة: إنشاء ملف جديد بمحتوى مطلوب',
    files: { 'README.md': '# مشروع تجريبي\n' },
    script: [
      { text: ['سأنشئ الملف المطلوب. '], calls: [{ name: 'write_file', args: { path: 'src/hello.ts', content: 'export const hello = "مرحباً";\n' } }] },
      { text: ['تم إنشاء الملف.'] },
    ],
    check: (ws) => {
      const p = path.join(ws, 'src/hello.ts');
      if (!fs.existsSync(p)) return 'لم يُنشأ الملف';
      const text = fs.readFileSync(p, 'utf8');
      return text.includes('hello') && text.includes('مرحباً') ? null : 'المحتوى غير صحيح';
    },
  },
  {
    name: 'fuzzy-edit',
    what: 'تعديل نصّه القديم لا يطابق حرفياً (مسافات بادئة ونهايات أسطر مختلفة)',
    files: {
      'app.js': "function start() {\n    console.log('one');\n    console.log('two');\n}\nstart();\n".replace(/\n/g, '\r\n'),
    },
    script: [
      { text: ['سأعدّل الدالة.'], calls: [{ name: 'edit_file', args: { path: 'app.js', old_text: "function start() {\n  console.log('one');\n  console.log('two');\n}", new_text: "function start() {\n  console.log('one');\n  console.log('two');\n  console.log('three');\n}" } }] },
      { text: ['تم التعديل مع تصحيح المطابقة.'] },
    ],
    check: (ws, ctx) => {
      const text = fs.readFileSync(path.join(ws, 'app.js'), 'utf8');
      if (!text.includes("console.log('three')")) return 'لم يُطبَّق التعديل';
      const fuzzy = ctx.telemetry.filter((e) => e.kind === 'edit' && e.strategy !== 'exact');
      return fuzzy.length ? null : 'المتوقع مطابقة متسامحة مسجّلة في القياس';
    },
  },
  {
    name: 'verify-catches-type-error',
    what: 'التحقق التلقائي يكشف خطأ نوع بعد التعديل ويرجعه للنموذج',
    files: {
      'package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { typecheck: 'node -e "process.exit(1)"' } }, null, 2),
      'src/math.ts': 'export const add = (a: number, b: number): number => a + b;\n',
    },
    script: [
      { text: ['سأضيف ملفاً يستخدم الدالة.'], calls: [{ name: 'write_file', args: { path: 'src/use.ts', content: 'import { add } from "./math";\nexport const total = add(1, 2);\n' } }] },
      { text: ['سأفحص الأنواع.'], calls: [{ name: 'run_command', args: { command: 'npm run typecheck' } }] },
      { text: ['الفحص فشل بسبب سكربت المشروع نفسه؛ سأصلح السكربت ليعمل.'], calls: [{ name: 'write_file', args: { path: 'package.json', content: JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { typecheck: 'node -e "process.exit(0)"' } }, null, 2) } }] },
      { text: ['صار الفحص ينجح.'] },
    ],
    check: (_ws, ctx) => {
      const verify = ctx.telemetry.filter((e) => e.kind === 'verify');
      if (!verify.length) return 'لم يُسجَّل أي تحقق تلقائي';
      const failed = verify.filter((e) => e.ok !== true).length;
      if (!failed) return 'المتوقع أن يكشف التحقق مشكلة أولاً';
      return verify.some((e) => e.ok === true) ? null : 'لم يُسجَّل تحقق ناجح بعد الإصلاح';
    },
  },
  {
    name: 'command-output',
    what: 'تشغيل أمر وقراءة مخرجاته وتمريرها للنموذج',
    files: { 'a.txt': 'x\n' },
    script: [
      { text: ['سأتحقق من البيئة.'], calls: [{ name: 'run_command', args: { command: 'node -e "console.log(123*7)"' } }] },
      { text: ['الناتج 861.'] },
    ],
    check: (_ws, ctx) => {
      const got = ctx.log.some((l) => l.startsWith('result:run_command'));
      const text = ctx.log.join('\n');
      return got && text.includes('861') ? null : 'لم تصل مخرجات الأمر للنموذج';
    },
  },
  {
    name: 'denied-command-not-retried',
    what: 'المستخدم يرفض أمراً: الوكيل لا يعيد المحاولة ويطلب البديل',
    files: { 'a.txt': 'x\n' },
    script: [
      { text: ['سأنفّذ الأمر.'], calls: [{ name: 'run_command', args: { command: 'node -e "console.log(1)"' } }] },
      { text: ['رفضت الأمر، سأسألك عن البديل بدل إعادة المحاولة.'] },
    ],
    approve: () => false,
    check: (_ws, ctx) => {
      const runs = ctx.log.filter((l) => l === 'call:run_command').length;
      if (runs !== 1) return `المتوقع محاولة واحدة فقط، وحدثت ${runs}`;
      return ctx.log.join('\n').includes('رفض') || ctx.approvals === 1 ? null : 'لم يُبلَّغ الرفض للنموذج';
    },
  },
  {
    name: 'same-file-approval-once',
    what: 'موافقة واحدة لكل ملف: تعديلان على نفس الملف لا يطلبان نقرتين',
    files: { 'src/app.ts': 'export const a = 1;\nexport const b = 2;\n' },
    script: [
      { text: ['سأعدّل الملف مرتين.'], calls: [{ name: 'edit_file', args: { path: 'src/app.ts', old_text: 'export const a = 1;', new_text: 'export const a = 10;' } }] },
      { text: ['التعديل الثاني.'], calls: [{ name: 'edit_file', args: { path: 'src/app.ts', old_text: 'export const b = 2;', new_text: 'export const b = 20;' } }] },
      { text: ['انتهيت.'] },
    ],
    approve: () => 'file',
    check: (ws, ctx) => {
      const text = fs.readFileSync(path.join(ws, 'src/app.ts'), 'utf8');
      if (!text.includes('a = 10') || !text.includes('b = 20')) return 'أحد التعديلين لم يُطبَّق';
      if (ctx.approvals !== 1) return `المتوقع سؤال واحد فقط، وحدثت ${ctx.approvals} أسئلة`;
      const bulk = ctx.telemetry.filter((e) => e.kind === 'approval' && e.decision === 'file').length;
      return bulk === 1 ? null : 'لم يُسجَّل نطاق الموافقة على الملف';
    },
  },
  {
    name: 'plan-then-two-files',
    what: 'خطة مهام + تعديل ملفين مستقلين في نفس الدورة',
    files: { 'src/one.ts': 'export const one = 1;\n', 'src/two.ts': 'export const two = 2;\n' },
    script: [
      { text: ['خطة العمل:'], calls: [{ name: 'todo_write', args: { todos: [{ content: 'تعديل one', status: 'in_progress' }, { content: 'تعديل two', status: 'pending' }] } }] },
      { text: ['أبدأ بالملف الأول.'], calls: [{ name: 'edit_file', args: { path: 'src/one.ts', old_text: 'one = 1', new_text: 'one = 11' } }] },
      { text: ['ثم الثاني.'], calls: [{ name: 'edit_file', args: { path: 'src/two.ts', old_text: 'two = 2', new_text: 'two = 22' } }] },
      { text: ['انتهى العمل على الملفين.'] },
    ],
    check: (ws, ctx) => {
      const a = fs.readFileSync(path.join(ws, 'src/one.ts'), 'utf8');
      const b = fs.readFileSync(path.join(ws, 'src/two.ts'), 'utf8');
      if (!a.includes('one = 11') || !b.includes('two = 22')) return 'أحد الملفين لم يُعدَّل';
      return ctx.log.includes('call:todo_write') ? null : 'لم تُسجَّل الخطة';
    },
  },
  {
    name: 'identical-retry-warns',
    what: 'الحلقة: نفس الاستدعاء بنفس النتيجة مرتين يُنبَّه عليه بدل التكرار الأعمى',
    files: { 'a.txt': 'x\n' },
    script: [
      { text: ['سأقرأ الملف.'], calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: ['سأقرأه مرة أخرى for no reason.'], calls: [{ name: 'read_file', args: { path: 'a.txt' } }] },
      { text: ['توقف.'] },
    ],
    check: (_ws, _ctx) => null, // الفحص الرئيسي: عدم فقدان الاتصال/الانهيار، والتنبيه يُسجَّل في الواجهة
  },  {
    name: 'skill-guided-task',
    what: 'المهارات: تُكتشف من مجلد المشروع ويصل وصفها إلى رسالة النظام فعلاً',
    files: { 'README.md': '# مشروع تجريبي\n' },
    prepare(ws) {
      const dir = path.join(ws, '.freecode', 'skills', 'project-rules');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        '---\nname: project-rules\ndescription: قاعدة-المهارة-77 — كل ملف جديد يبدأ بهذا الوسم\n---\n\n# قواعد المشروع\n\nكل ملف جديد يجب أن يبدأ بالوسم قاعدة-المهارة-77.\n',
        'utf8',
      );
      return discoverSkills(ws, path.join(ws, '.userdata'));
    },
    setup(agent, extra) {
      agent.skills = extra as Skill[];
    },
    script: [{ text: ['سأطبّق اصطلاح المشروع.'], calls: [{ name: 'write_file', args: { path: 'notes.md', content: 'قاعدة-المهارة-77\n- ملاحظة\n' } }] }],
    check(ws, ctx) {
      const skills = (ctx.requests[0]?.messages ?? []).map((m: any) => String(m.content ?? '')).join('\n');
      if (!skills.includes('project-rules')) return 'المهارة لم تُدرج في رسالة النظام';
      if (!skills.includes('قاعدة-المهارة-77')) return 'وصف المهارة لم يصل للنموذج';
      const file = path.join(ws, 'notes.md');
      if (!fs.existsSync(file)) return 'لم يُنشأ الملف';
      if (!fs.readFileSync(file, 'utf8').startsWith('قاعدة-المهارة-77')) return 'الملف لا يبدأ بوسم المهارة';
      return null;
    },
  },
  {
    name: 'plugin-rules-guard-project',
    what: 'الإضافات: منع الأوامر الخطرة وhook يحمي .env — حتى مع موافقة المستخدم على كل شيء',
    files: {
      'src/app.ts': 'export const app = 1;\n',
      'package.json': JSON.stringify({ name: 'fx', version: '1.0.0' }, null, 2),
    },
    prepare(ws) {
      const userData = path.join(ws, '.userdata');
      const dir = path.join(userData, 'plugins', 'guard');
      fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
      const hookFile = path.join(dir, 'hooks', 'block-env.cjs');
      fs.writeFileSync(
        hookFile,
        'const p = process.env.FREECODE_FILE || "";\nif (p === ".env" || p.startsWith(".env")) {\n  process.stdout.write("لا تعدّل ملفات .env في هذا المشروع");\n  process.exit(2);\n}\nprocess.exit(0);\n',
        'utf8',
      );
      fs.writeFileSync(
        path.join(dir, 'plugin.json'),
        JSON.stringify(
          {
            name: 'guard',
            version: '1.0.0',
            description: 'حماية المشروع: منع rm وقاعدة hook على .env',
            permissions: { deny: ['run_command(rm:*)'] },
            hooks: { PreToolUse: [{ matcher: 'write_file|edit_file', paths: ['.env*'], command: `node "${hookFile}"` }] },
          },
          null,
          2,
        ),
        'utf8',
      );
      return discoverPlugins(ws, userData).then((plugins) => ({ plugins: plugins, userData }));
    },
    setup(agent, extra) {
      const { plugins } = extra as { plugins: Plugin[] };
      agent.rules = mergePluginRules(emptyRules(), plugins);
    },
    script: [
      { text: ['سأنظّف المشروع ثم أضبط الإعدادات.'], calls: [{ name: 'run_command', args: { command: 'rm -rf src' } }] },
      { text: ['سأكتب ملف الإعدادات.'], calls: [{ name: 'write_file', args: { path: '.env', content: 'SECRET=1\n' } }] },
    ],
    check(ws, ctx) {
      const pluginCount = Number((ctx as any).pluginCount ?? 0);
      const joined = ctx.log.join('\n');
      if (!joined.includes('ممنوع بقاعدة صلاحيات')) return 'قاعدة المنع من الإضافة لم تمنع أمر rm';
      if (!joined.includes('منعت هذه العملية قاعدة (hook)')) return 'hook الإضافة لم يمنع كتابة .env';
      if (!fs.existsSync(path.join(ws, 'src', 'app.ts'))) return 'حُذف مجلد src رغم المنع';
      if (fs.existsSync(path.join(ws, '.env'))) return 'كُتب ملف .env رغم منع hook';
      if (pluginCount) return null;
      return null;
    },
  },
  {
    name: 'mcp-tool-roundtrip',
    what: 'MCP: خادم stdio حقيقي تُكتشف أدواته وتمرّ الاستدعاءات ذهاباً وإياباً',
    files: { 'README.md': '# مشروع\n' },
    async prepare(ws) {
      const serverFile = path.join(ws, 'fake-mcp.cjs');
      fs.writeFileSync(
        serverFile,
        [
          "let buf = '';",
          'function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: id, result: result }) + "\\n"); }',
          'process.stdin.on("data", function (d) {',
          '  buf += d.toString("utf8");',
          '  let nl;',
          "  while ((nl = buf.indexOf('\\n')) >= 0) {",
          '    const line = buf.slice(0, nl).trim();',
          '    buf = buf.slice(nl + 1);',
          '    if (!line) continue;',
          '    let msg;',
          '    try { msg = JSON.parse(line); } catch { continue; }',
          '    if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.0.0" } });',
          '    else if (msg.method === "tools/list") reply(msg.id, { tools: [{ name: "echo", description: "يعيد النص كما هو", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });',
          '    else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: "صدى: " + String((msg.params.arguments || {}).text || "") }] });',
          '    else if (msg.id !== undefined) reply(msg.id, {});',
          '  }',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );
      const mcp = new McpManager();
      await mcp.start({ fake: { cfg: { command: process.execPath, args: [serverFile] }, source: 'إضافة' } }, ws);
      return mcp;
    },
    setup(agent, extra) {
      const mcp = extra as McpManager;
      agent.extraTools = () => mcp.toolDefs();
    },
    cleanup(extra) {
      (extra as McpManager | undefined)?.stopAll();
    },
    script: [
      { text: ['سأستدعي أداة الخادم.'], calls: [{ name: 'mcp__fake__echo', args: { text: 'مرحبا' } }] },
    ],
    check(_ws, ctx) {
      const tools = JSON.stringify(ctx.requests[0]?.tools ?? []);
      if (!tools.includes('mcp__fake__echo')) return 'أدوات MCP لم تُقدَّم للنموذج';
      const joined = ctx.log.join('\n');
      if (!joined.includes('result:mcp__fake__echo')) return 'لم يُستدعَ أداة الخادم';
      if (!joined.includes('صدى: مرحبا')) return 'لم تعد نتيجة الأداة من الخادم';
      return null;
    },
  },

];

// ---------- المشغّل ----------

export interface Result {
  name: string;
  what: string;
  ok: boolean;
  error: string | null;
  steps: number;
  durationMs: number;
  tokens: number;
  approvals: number;
  editsFuzzy: number;
}

export async function runScenario(s: Scenario): Promise<Result> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `freecode-bench-${s.name}-`));
  writeFixture(ws, s.files);
  gitInit(ws);

  const { server, state } = mockServer(s.script);
  const port = await listen(server);
  const telemetry = new Telemetry();
  const agent = new Agent(
    { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'bench' },
    ws,
    { ...DEFAULT_OPTIONS, ...(s.options ?? {}), maxSteps: 12, repoMap: false, autoVerify: s.options?.autoVerify !== false },
  );
  agent.telemetry = telemetry;

  const log: string[] = [];
  let approvals = 0;
  let lastApproval: boolean | 'turn' | 'file' = true;
  const started = Date.now();
  const ev: AgentEvents = {
    onText: () => {},
    onToolCall: (_id, name) => log.push(`call:${name}`),
    onToolOutput: () => {},
    onToolResult: (_id, name, result) => log.push(`result:${name}:${result.slice(0, 400)}`),
    approve: async (_id, name, args) => {
      approvals++;
      lastApproval = s.approve ? s.approve(name, args, approvals) : true;
      log.push(`approve:${name}:${lastApproval}`);
      return lastApproval;
    },
    onTodos: () => {},
    onUsage: () => {},
    onRetry: () => {},
    onChanges: () => {},
    onNotice: (m) => log.push(`notice:${m}`),
  };

  const extra = s.prepare ? await s.prepare(ws) : undefined;
  if (s.setup) await s.setup(agent, extra, ws);

  let error: string | null = null;
  try {
    await agent.run('نفّذ المهمة.', ev);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }

  const turn = telemetry.events.filter((e) => e.kind === 'turn').slice(-1)[0];
  const ctx = { telemetry: telemetry.events, approvals, steps: Number(turn?.steps ?? 0), log, requests: state.requests };
  let checkError: string | null = null;
  try {
    checkError = error ? `انهيار: ${error}` : s.check(ws, ctx);
  } catch (e: any) {
    checkError = `فشل الفحص نفسه: ${String(e?.message ?? e)}`;
  }
  try {
    s.cleanup?.(extra);
  } catch {
    /* تنظيف أفضل-جهد */
  }
  const result: Result = {
    name: s.name,
    what: s.what,
    ok: !checkError,
    error: checkError,
    steps: ctx.steps,
    durationMs: Number(turn?.durationMs ?? Date.now() - started),
    tokens: Number(turn?.tokens ?? 0),
    approvals,
    editsFuzzy: telemetry.events.filter((e) => e.kind === 'edit' && e.strategy !== 'exact').length,
  };
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(ws, { recursive: true, force: true });
  return result;
}

async function main(): Promise<void> {
  const asJson = process.argv.includes('--json');
  const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
  const list = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
  const results: Result[] = [];
  for (const s of list) results.push(await runScenario(s));

  const passed = results.filter((r) => r.ok).length;
  if (asJson) {
    console.log(JSON.stringify({ passed, total: results.length, results }, null, 2));
  } else {
    console.log('\nقياس موثوقية الوكيل (سيناريوهات مبرمَجة، بلا إنترنت وبلا موديل حقيقي)\n');
    console.log('| السيناريو | النتيجة | خطوات | زمن | توكنات | نقرات | ');
    console.log('|---|---|---|---|---|---|');
    for (const r of results) {
      console.log(`| ${r.name} | ${r.ok ? '✅ نجح' : `❌ ${r.error}`} | ${r.steps} | ${(r.durationMs / 1000).toFixed(1)}ث | ${r.tokens} | ${r.approvals} |`);
    }
    console.log(`\nالنتيجة: ${passed}/${results.length} سيناريو ناجح.`);
    const telemetrySummary = summarizeTelemetry(results.map((r) => ({ t: 0, kind: 'turn' as const, ok: r.ok, steps: r.steps, durationMs: r.durationMs, tokens: r.tokens })));
    console.log(`ملخّص: ${telemetrySummary.turns} دورات · نجحت ${telemetrySummary.okTurns} · خطوة وسيطة ${telemetrySummary.steps / Math.max(1, results.length)} · ${telemetrySummary.tokensPerTurn} توكن/مهمة\n`);
  }
  process.exit(passed === results.length ? 0 : 1);
}

// يُشغَّل تلقائياً عند تنفيذه مباشرة فقط (يمكن استيراده من الاختبارات بلا تشغيل القياس كله)
if (typeof require !== 'undefined' && require.main === module) {
  main().catch((e) => {
    console.error('فشل تشغيل القياس:', e);
    process.exit(1);
  });
}
