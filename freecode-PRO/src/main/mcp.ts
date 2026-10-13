// عميل MCP (Model Context Protocol) عبر stdio: JSON-RPC 2.0 بأسطر مفصولة، بدون مكتبات.
// الإعداد بصيغة Claude Desktop: { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...} } } }
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { ToolDef } from './tools';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** إن كان true تُنفَّذ أدوات هذا الخادم دون سؤال (للخوادم التي تثق بها فقط) */
  autoApprove?: boolean;
  disabled?: boolean;
}

export interface McpStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
  source: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private closed = false;
  tools: McpTool[] = [];
  stderr = '';

  constructor(
    public name: string,
    private cfg: McpServerConfig,
    private root: string,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      cwd: this.cfg.cwd ?? this.root,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32', // npx.cmd وأمثاله على ويندوز
    });
    this.child = child;
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d: Buffer) => this.onData(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-1500);
    });
    child.on('error', (e) => this.failAll(new Error(`تعذّر تشغيل الأمر "${this.cfg.command}": ${e.message}`)));
    child.on('close', (code) => {
      this.closed = true;
      this.failAll(new Error(`انتهى خادم MCP (code ${code})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`));
    });

    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'freecode', version: '0.4.0' } }, 20_000);
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    let cursor: string | undefined;
    do {
      const r: any = await this.request('tools/list', cursor ? { cursor } : {}, 20_000);
      this.tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
      cursor = r?.nextCursor;
    } while (cursor);
  }

  private send(msg: unknown): void {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('خادم MCP متوقف'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`انتهت مهلة ${method} (${Math.round(timeoutMs / 1000)}ث)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // سطر غير JSON (سجلات)
      }
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        // طلب من الخادم إلينا: نجيب على ping ونرفض الباقي
        this.send(msg.method === 'ping' ? { jsonrpc: '2.0', id: msg.id, result: {} } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'غير مدعوم' } });
      }
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async call(tool: string, args: unknown, signal?: AbortSignal): Promise<string> {
    const onAbort = () => this.failAll(new Error('أُوقفت العملية'));
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const r: any = await this.request('tools/call', { name: tool, arguments: args ?? {} }, 120_000);
      const parts: string[] = [];
      for (const c of Array.isArray(r?.content) ? r.content : []) {
        if (c.type === 'text') parts.push(String(c.text ?? ''));
        else if (c.type === 'image') parts.push('[صورة]');
        else parts.push(JSON.stringify(c).slice(0, 2000));
      }
      const text = parts.join('\n') || (r?.structuredContent ? JSON.stringify(r.structuredContent) : '(لا مخرجات)');
      // نتائج MCP لا تمر عبر clip() في الأدوات المدمجة، فنحدّها هنا حتى لا تغرق السياق
      const capped = text.length > 20_000 ? `${text.slice(0, 20_000)}\n…[اقتُطعت ${text.length - 20_000} حرفاً من مخرجات MCP]` : text;
      return r?.isError ? `خطأ: ${capped}` : capped;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  stop(): void {
    this.closed = true;
    this.failAll(new Error('أُغلق الخادم'));
    try {
      this.child?.kill();
    } catch {
      /* انتهى أصلاً */
    }
  }
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

function schemaOf(raw: any): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || raw.type !== 'object') return { type: 'object', properties: {} };
  const { $schema: _drop, ...rest } = raw;
  return rest;
}

export class McpManager {
  private clients = new Map<string, { client: McpClient; cfg: McpServerConfig }>();
  statuses: McpStatus[] = [];

  async start(servers: Record<string, { cfg: McpServerConfig; source: string }>, root: string): Promise<void> {
    this.statuses = [];
    await Promise.all(
      Object.entries(servers).map(async ([name, { cfg, source }]) => {
        if (cfg.disabled) {
          this.statuses.push({ name, ok: false, toolCount: 0, error: 'معطّل', source });
          return;
        }
        const client = new McpClient(name, cfg, root);
        try {
          await client.start();
          this.clients.set(name, { client, cfg });
          this.statuses.push({ name, ok: true, toolCount: client.tools.length, source });
        } catch (e: any) {
          client.stop();
          this.statuses.push({ name, ok: false, toolCount: 0, error: String(e?.message ?? e).slice(0, 300), source });
        }
      }),
    );
    this.statuses.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** أدوات MCP كأدوات عادية للوكيل. تحتاج موافقة ما لم يضع المستخدم autoApprove لذلك الخادم. */
  toolDefs(): ToolDef[] {
    const defs: ToolDef[] = [];
    for (const [server, { client, cfg }] of this.clients) {
      for (const t of client.tools) {
        const fname = `mcp__${safe(server)}__${safe(t.name)}`.slice(0, 64);
        defs.push({
          mcp: true,
          kind: cfg.autoApprove ? 'read' : 'command',
          spec: {
            type: 'function',
            function: { name: fname, description: `[MCP:${server}] ${t.description ?? t.name}`.slice(0, 1000), parameters: schemaOf(t.inputSchema) },
          },
          async preview(args) {
            return { kind: 'command', command: `${server} › ${t.name} ${JSON.stringify(args ?? {}).slice(0, 600)}`, dangerous: false };
          },
          run: (args, ctx) => client.call(t.name, args, ctx.signal),
        });
      }
    }
    return defs;
  }

  stopAll(): void {
    for (const { client } of this.clients.values()) client.stop();
    this.clients.clear();
  }
}

/** يقبل mcpServers (صيغة Claude Desktop) أو servers */
export function parseMcpConfig(json: any): Record<string, McpServerConfig> {
  const raw = json?.mcpServers ?? json?.servers ?? {};
  const out: Record<string, McpServerConfig> = {};
  if (raw && typeof raw === 'object') {
    for (const [name, c] of Object.entries<any>(raw)) {
      if (c && typeof c.command === 'string' && c.command.trim()) {
        out[name] = {
          command: c.command,
          args: Array.isArray(c.args) ? c.args.map(String) : [],
          env: c.env && typeof c.env === 'object' ? c.env : undefined,
          cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
          autoApprove: c.autoApprove === true,
          disabled: c.disabled === true,
        };
      }
    }
  }
  return out;
}

export async function loadMcpFile(file: string): Promise<Record<string, McpServerConfig>> {
  try {
    return parseMcpConfig(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch {
    return {};
  }
}
