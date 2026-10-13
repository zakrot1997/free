// جسر IDE: خادم محلي صغير (127.0.0.1) يتيح لإضافة VS Code (أو أي عميل HTTP) تشغيل
// نفس نواة الوكيل على مشروعك: إرسال مهمة، ومتابعة الأحداث لحظياً بـSSE، وإيقاف.
//
// الأمان أولاً:
//  - الاستماع على 127.0.0.1 فقط (لا يُتاح على الشبكة).
//  - رمز سري إلزامي في كل طلب (يُولَّد ويُحفظ في الإعدادات، ويُمرَّر بترويسة أو query).
//  - مقارنة الرمز بزمن ثابت، ورفض طلبات غير GET/POST، وحدّ حجم للجسم.
import * as http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Agent, DEFAULT_OPTIONS, type AgentEvents, type AgentOptions } from './agent';
import { isDangerousCommand } from './tools';
import type { LLMConfig } from './llm';

export interface BridgeConfig {
  /** المنفذ (0 = تلقائي) */
  port: number;
  /** الرمز السري */
  token: string;
  /** ربط بعنوان محلي فقط دائماً */
  host?: string;
}

export interface BridgeEvent {
  type: string;
  [k: string]: unknown;
}

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  url: string | null;
  /** آخر خطأ أو حالة */
  note: string;
  requests: number;
}

const MAX_BODY = 256 * 1024;

/** رمز سري جديد (يُحفظ في الإعدادات) */
export function newBridgeToken(): string {
  return randomBytes(24).toString('base64url');
}

/** مقارنة بزمن ثابت (نقي — يُختبر) */
export function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
}

/** استخراج الرمز من ترويسة أو معامل استعلام (نقي) */
export function tokenFrom(headers: http.IncomingHttpHeaders, url: URL): string {
  const h = String(headers['x-freecode-token'] ?? headers['authorization'] ?? '');
  if (h) return h.replace(/^Bearer\s+/i, '').trim();
  return url.searchParams.get('token') ?? '';
}

/** يتحقق من الرمز ويصنّف الطلب (نقي — يُختبر) */
export function authorize(
  headers: http.IncomingHttpHeaders,
  url: URL,
  token: string,
): { ok: true } | { ok: false; code: number; error: string } {
  if (!token) return { ok: false, code: 503, error: 'الجسر يعمل بلا رمز — أوقفه من الإعدادات' };
  if (!sameToken(tokenFrom(headers, url), token)) return { ok: false, code: 401, error: 'رمز غير صالح' };
  return { ok: true };
}

interface Client {
  id: number;
  send: (e: BridgeEvent) => void;
  close: () => void;
}

export interface BridgeDeps {
  llm: () => LLMConfig | null;
  workspace: () => string | null;
  options: () => AgentOptions;
  /** ضبط قواعد الجلسة (صلاحيات/hooks) قبل التشغيل */
  prepare?: (agent: Agent) => Promise<void>;
  onEvent?: (e: BridgeEvent) => void;
}

export class IdeBridge {
  private server: http.Server | null = null;
  private clients = new Map<number, Client>();
  private nextClient = 1;
  private abort: AbortController | null = null;
  private running = false;
  private note = 'متوقف';
  private requests = 0;
  private lastResult = '';

  constructor(private deps: BridgeDeps) {}

  get status(): BridgeStatus {
    const addr = this.server?.address();
    const port = typeof addr === 'object' && addr ? addr.port : null;
    return { running: !!this.server, port, url: port ? `http://127.0.0.1:${port}` : null, note: this.note, requests: this.requests };
  }

  private broadcast(e: BridgeEvent): void {
    for (const c of this.clients.values()) c.send(e);
    this.deps.onEvent?.(e);
  }

  async start(cfg: BridgeConfig): Promise<BridgeStatus> {
    if (this.server) return this.status;
    if (!cfg.token) throw new Error('لا رمز للجسر');
    const server = http.createServer((req, res) => void this.handle(req, res, cfg));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port || 0, cfg.host ?? '127.0.0.1', () => resolve());
    });
    this.note = 'يعمل';
    const addr = server.address();
    if (typeof addr === 'object' && addr && addr.port === 0) this.note = 'يعمل';
    return this.status;
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    for (const c of this.clients.values()) c.close();
    this.clients.clear();
    const s = this.server;
    this.server = null;
    this.note = 'متوقف';
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, cfg: BridgeConfig): Promise<void> {
    this.requests++;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${cfg.port || 0}`);
    } catch {
      return this.json(res, 400, { error: 'رابط غير صالح' });
    }
    // نمنع أي محاولة وصول من أصل آخر
    const origin = String(req.headers.origin ?? '');
    if (origin && !/^vscode-webview:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return this.json(res, 403, { error: 'أصل غير مسموح' });
    }

    const auth = authorize(req.headers, url, cfg.token);
    if (!auth.ok) return this.json(res, auth.code, { error: auth.error });

    const route = url.pathname;
    if (route === '/status' && req.method === 'GET') {
      const ws = this.deps.workspace();
      return this.json(res, 200, { ok: true, bridge: this.status, workspace: ws, running: this.running, busy: this.running, lastResult: this.lastResult.slice(0, 2000) });
    }

    if (route === '/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const id = this.nextClient++;
      const send = (e: BridgeEvent) => {
        try {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          /* العميل أغلق */
        }
      };
      const keep = setInterval(() => send({ type: 'ping', at: Date.now() }), 20_000);
      const client: Client = {
        id,
        send,
        close: () => {
          clearInterval(keep);
          try {
            res.end();
          } catch {
            /* تجاهل */
          }
        },
      };
      this.clients.set(id, client);
      send({ type: 'hello', bridge: this.status, workspace: this.deps.workspace() });
      req.on('close', () => {
        clearInterval(keep);
        this.clients.delete(id);
      });
      return;
    }

    if (route === '/abort' && req.method === 'POST') {
      if (!this.running) return this.json(res, 200, { ok: true, aborted: false, note: 'لا عمل جارٍ' });
      this.abort?.abort();
      return this.json(res, 200, { ok: true, aborted: true });
    }

    if (route === '/message' && req.method === 'POST') {
      const body = await readBody(req);
      if (body === null) return this.json(res, 413, { error: 'الجسم أكبر من الحد المسموح' });
      let parsed: any = {};
      try {
        parsed = body ? JSON.parse(body) : {};
      } catch {
        return this.json(res, 400, { error: 'JSON غير صالح' });
      }
      const text = String(parsed.text ?? parsed.prompt ?? '').trim();
      if (!text) return this.json(res, 400, { error: 'text مطلوب' });
      if (this.running) return this.json(res, 409, { error: 'الوكيل يعمل بالفعل — أوقفه أولاً أو انتظر' });
      const cfgLLM = this.deps.llm();
      const ws = this.deps.workspace();
      if (!ws) return this.json(res, 400, { error: 'لا مجلد مشروع محدد في التطبيق' });
      if (!cfgLLM?.apiKey) return this.json(res, 400, { error: 'لا مفتاح API مضبوط في التطبيق' });

      // نبدأ ثم نرد فوراً: الأحداث تصل عبر /events
      void this.runTurn(text, cfgLLM, ws, { mode: parsed.mode, allowCommands: parsed.allowCommands });
      return this.json(res, 202, { ok: true, accepted: true, note: 'تابع الأحداث على /events' });
    }

    return this.json(res, 404, { error: 'مسار غير معروف', routes: ['/status', '/events', '/message', '/abort'] });
  }

  private async runTurn(text: string, llm: LLMConfig, ws: string, o: { mode?: unknown; allowCommands?: unknown }): Promise<void> {
    this.running = true;
    const ctl = new AbortController();
    this.abort = ctl;
    const allowCommands = o.allowCommands === true;
    let answer = '';
    try {
      const options: AgentOptions = { ...this.deps.options(), mode: o.mode === 'plan' ? 'plan' : 'act', autoApproveEdits: true, autoApproveCommands: false, isSub: false };
      const agent = new Agent(llm, ws, options);
      await this.deps.prepare?.(agent);
      const ev: AgentEvents = {
        onText: (delta) => {
          answer += delta;
          this.broadcast({ type: 'text', delta });
        },
        onToolCall: (id, name, args) => this.broadcast({ type: 'tool_call', id, name, args }),
        onToolOutput: (id, chunk) => this.broadcast({ type: 'tool_output', id, chunk }),
        onToolResult: (id, name, result, isError) => this.broadcast({ type: 'tool_result', id, name, result, isError }),
        approve: async (_id, name, args) => {
          if (name !== 'run_command' && name !== 'start_process' && name !== 'stop_process') return true;
          const cmd = String((args as any)?.command ?? '');
          if (isDangerousCommand(cmd)) {
            this.broadcast({ type: 'notice', message: `رُفض أمر خطر من الجسر: ${cmd}` });
            return false;
          }
          return allowCommands;
        },
        onTodos: (todos) => this.broadcast({ type: 'todos', todos }),
        onUsage: (u) => this.broadcast({ type: 'usage', ...u }),
        onRetry: (info) => this.broadcast({ type: 'notice', message: `إعادة محاولة ${info.attempt}/${info.maxAttempts}` }),
        onChanges: (changes, undoDepth) => this.broadcast({ type: 'changes', changes, undoDepth }),
        onNotice: (message) => this.broadcast({ type: 'notice', message }),
      };
      await agent.run(text, ev, ctl.signal);
      this.lastResult = answer;
      this.broadcast({ type: 'done', aborted: ctl.signal.aborted });
    } catch (e: any) {
      this.broadcast({ type: 'error', message: String(e?.message ?? e).slice(0, 500) });
      this.broadcast({ type: 'done', aborted: ctl.signal.aborted });
    } finally {
      this.running = false;
      this.abort = null;
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let data = '';
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      data += c.toString('utf8');
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(null));
  });
}

/** نص حالة الجسر للعرض في /bridge أو الإعدادات */
export function describeBridge(st: BridgeStatus, token: string): string {
  if (!st.running) return 'جسر IDE: متوقف. شغّله من الإعدادات أو بـ/bridge on.';
  return [
    'جسر IDE: يعمل ✅',
    `• العنوان: ${st.url}`,
    `• الرمز: ${token.slice(0, 6)}… (كامل في الإعدادات → جسر IDE)`,
    '• نقاط النهاية: GET /status · GET /events (SSE) · POST /message {text, mode?, allowCommands?} · POST /abort',
    '• في VS Code: ثبّت الإضافة من مجلد ide/vscode ثم اربطها بالعنوان والرمز.',
  ].join('\n');
}
