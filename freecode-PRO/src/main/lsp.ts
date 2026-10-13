// ذكاء الكود (LSP): عميل بروتوكول Language Server يعمل عبر stdio، مع:
//  - إعدادافتراضية لأشهر الخوادم (TypeScript · Pyright · gopls · rust-analyzer)،
//  - إعداد من ملف المستخدم وملف المشروع (إعداد المشروع يحتاج ثقة لأنه يشغّل أوامر)،
//  - تدهور لطيف: بلا خادم متاح نعود إلى فهرسة نصية للرموز بدل الفشل.
//
// البروتوكول: JSON-RPC 2.0 مع ترويسة Content-Length — منفّذ يدوياً بلا مكتبات.
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// ---------- البروتوكول (ترويسة Content-Length) ----------

/** يلفّ رسالة JSON بإطار LSP (نقي — يُختبر وحده) */
export function encodeFrame(message: unknown): string {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

/** محلّل تدفّق: يستقبل أجزاء نصية ويعيد الرسائل الكاملة (يتحمّل التقسيم والتلاصق) */
export class LspFramer {
  // نعمل على بايتات لا على حروف: طول الإطار بالبايت، ونصوص الردود قد تكون عربية (متعددة البايتات)
  private buf: Buffer = Buffer.alloc(0);
  private static readonly SEP = Buffer.from('\r\n\r\n', 'latin1');

  push(chunk: Buffer | string): any[] {
    const add = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buf = this.buf.length ? Buffer.concat([this.buf, add]) : Buffer.from(add);
    const out: any[] = [];
    for (;;) {
      const headEnd = this.buf.indexOf(LspFramer.SEP);
      if (headEnd < 0) break;
      const header = this.buf.subarray(0, headEnd).toString('latin1');
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        // ترويسة غير مفهومة: نتخلّص من أول سطر ونحاول مجدداً
        this.buf = this.buf.subarray(headEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headEnd + 4;
      if (this.buf.length - start < len) break; // لم يكتمل الجسم بعد (بالبايتات)
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      try {
        out.push(JSON.parse(body));
      } catch {
        /* رسالة تالفة: نتجاهلها */
      }
    }
    return out;
  }

  /** بقايا غير مكتملة (للتشخيص والاختبار) */
  get pending(): string {
    return this.buf.toString('utf8');
  }
}

// ---------- مسارات و URIs ----------

/** يحوّل مساراً محلياً إلى URI بصيغة LSP (نقي) */
export function pathToUri(absPath: string): string {
  let p = absPath.split(path.sep).join('/');
  if (!p.startsWith('/')) p = `/${p}`; // ويندوز: C:/x → /C:/x
  const enc = p
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `file://${enc}`;
}

/** يحوّل URI إلى مسار محلي (نقي) */
export function uriToPath(uri: string): string {
  let s = String(uri ?? '');
  if (s.startsWith('file://')) s = s.slice(7);
  s = decodeURIComponent(s);
  if (/^\/[A-Za-z]:\//.test(s)) s = s.slice(1); // ويندوز
  return s;
}

/** يحوّل موضع (سطر/عمود بنظام 1) إلى إحداثيات LSP (بنظام 0) */
export function toLspPosition(line1: number, col1: number): { line: number; character: number } {
  return { line: Math.max(0, Math.floor(line1) - 1), character: Math.max(0, Math.floor(col1) - 1) };
}

/** وصف موضع LSP للعرض (1-based) */
export function fromLspPosition(pos: { line?: number; character?: number } | undefined): string {
  if (!pos) return '—';
  return `${(pos.line ?? 0) + 1}:${(pos.character ?? 0) + 1}`;
}

// ---------- الإعداد ----------

export interface LspServerConf {
  command: string;
  args?: string[];
  /** امتدادات الملفات التي يخدمها (بلا نقطة) */
  extensions: string[];
  /** معرّف اللغة الذي يُرسل للخادم (افتراضي: الامتداد) */
  languageId?: string;
  env?: Record<string, string>;
  /** وسائط زمن التنفيذ (initializationOptions) */
  initOptions?: unknown;
}

export interface LspConfig {
  servers: Record<string, LspServerConf>;
}

export const DEFAULT_LSP_SERVERS: Record<string, LspServerConf> = {
  typescript: { command: 'typescript-language-server', args: ['--stdio'], extensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] },
  python: { command: 'pyright-langserver', args: ['--stdio'], extensions: ['py'] },
  go: { command: 'gopls', extensions: ['go'] },
  rust: { command: 'rust-analyzer', extensions: ['rs'] },
};

export interface LoadedLsp extends LspConfig {
  /** إعداد المشروع يحتاج ثقة (يشغّل أوامر) */
  needsTrust: boolean;
  projectFile: string;
  errors: string[];
}

/** يدمج الإعداد الافتراضي مع إعداد المستخدم ومع إعداد المشروع (المشروع يتقدم) */
export function mergeLspConfig(base: LspConfig, user: any, project: any, trusted: boolean): LoadedLsp {
  const out: LspConfig = { servers: { ...base.servers } };
  const errors: string[] = [];
  const apply = (raw: any, label: string): void => {
    if (!raw || typeof raw !== 'object') return;
    const list = (raw as any).servers;
    if (!list || typeof list !== 'object') return;
    for (const [name, conf] of Object.entries<any>(list)) {
      if (!conf || typeof conf.command !== 'string' || !conf.command.trim()) {
        errors.push(`${label}: الخادم «${name}» بلا command صالح`);
        continue;
      }
      const exts = Array.isArray(conf.extensions) ? conf.extensions.filter((e: unknown) => typeof e === 'string') : [];
      if (!exts.length) {
        errors.push(`${label}: الخادم «${name}» بلا extensions — تُجوهل`);
        continue;
      }
      out.servers[name] = {
        command: conf.command,
        args: Array.isArray(conf.args) ? conf.args.filter((a: unknown) => typeof a === 'string') : [],
        extensions: exts.map((e: string) => e.replace(/^\./, '').toLowerCase()),
        languageId: typeof conf.languageId === 'string' ? conf.languageId : undefined,
        env: conf.env && typeof conf.env === 'object' ? conf.env : undefined,
        initOptions: conf.initOptions,
      };
    }
  };
  apply(user, 'إعداد المستخدم');
  if (project && trusted) apply(project, 'إعداد المشروع');
  else if (project && !trusted) errors.push('إعداد المشروع (lsp.json) غير مفعّل قبل الثقة.');
  return { ...out, needsTrust: !!project && !trusted, projectFile: '', errors };
}

export async function loadLspConfig(root: string, userData: string, trusted: (file: string, hash: string) => boolean): Promise<LoadedLsp> {
  const projectFile = path.join(root, '.freecode', 'lsp.json');
  const userFile = path.join(userData, 'lsp.json');
  const read = async (f: string): Promise<any> => {
    try {
      return JSON.parse(await fs.readFile(f, 'utf8'));
    } catch {
      return null;
    }
  };
  const user = await read(userFile);
  const projectRaw = await fs.readFile(projectFile, 'utf8').catch(() => null);
  const project = projectRaw ? safeJson(projectRaw) : null;
  const hash = projectRaw ? createHash('sha256').update(projectRaw).digest('hex') : '';
  const ok = project ? trusted(projectFile, hash) : true;
  const merged = mergeLspConfig({ servers: DEFAULT_LSP_SERVERS }, user, project, ok);
  merged.projectFile = projectFile;
  return merged;
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------- العميل ----------

export interface LspDiagnostic {
  message: string;
  severity?: number;
  line?: number;
  character?: number;
  source?: string;
  code?: string | number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export class LspClient {
  private proc: ChildProcess | null = null;
  private framer = new LspFramer();
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private opened = new Map<string, number>(); // uri → version
  private failures = 0;
  dead = false;
  stderr = '';
  /** آخر التشخيصات لكل ملف (من إشعارات publishDiagnostics) */
  readonly diagnostics = new Map<string, LspDiagnostic[]>();
  onDiagnostics?: (uri: string, items: LspDiagnostic[]) => void;

  constructor(
    readonly name: string,
    private conf: LspServerConf,
    private root: string,
  ) {}

  /** يشغّل الخادم ويُجري مصافحة initialize */
  private starting: Promise<void> | null = null;

  async start(timeoutMs = 15_000): Promise<void> {
    if (this.proc) {
      // إن كانت المصافحة جارية، ننتظرها؛ وإن كانت يميناً ننتظر قليلاً حتى تصبح جاهزة
      if (this.starting) return this.starting;
      for (let i = 0; i < 50 && !this.ready; i++) await new Promise((r) => setTimeout(r, 100));
      return;
    }
    this.starting = this.doStart(timeoutMs);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private ready = false;

  private async doStart(timeoutMs = 15_000): Promise<void> {
    const proc = spawn(this.conf.command, this.conf.args ?? [], {
      cwd: this.root,
      env: { ...process.env, ...(this.conf.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    // بلا setEncoding: نمرّر Bufers خاماً حتى تُحسب الأطوار بالبايتات كما في مواصفة LSP
    proc.stdout!.on('data', (chunk: Buffer) => {
      for (const msg of this.framer.push(chunk)) this.handle(msg);
    });
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-4000);
    });
    proc.on('exit', () => {
      this.dead = true;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`خادم اللغة «${this.name}» توقف أثناء الانتظار`));
      }
      this.pending.clear();
    });
    proc.on('error', () => {
      this.dead = true;
    });

    const initRes = await this.request(
      'initialize',
      {
        processId: process.pid,
        rootUri: pathToUri(this.root),
        capabilities: {
          textDocument: {
            definition: {},
            references: {},
            hover: {},
            publishDiagnostics: {},
          },
          workspace: { workspaceFolders: true },
        },
        workspaceFolders: [{ uri: pathToUri(this.root), name: path.basename(this.root) }],
        initializationOptions: this.conf.initOptions,
      },
      timeoutMs,
    );
    this.serverCommands = Array.isArray((initRes as any)?.capabilities?.executeCommandProvider?.commands)
      ? ((initRes as any).capabilities.executeCommandProvider.commands as string[])
      : [];
    this.notify('initialized', {});
    this.ready = true;
  }

  /** أوامر الخادم الإضافية (مثل _typescript.goToSourceDefinition) */
  serverCommands: string[] = [];

  private handle(msg: any): void {
    if (msg && msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(Number(msg.id));
      if (!p) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'خطأ من خادم اللغة')));
      else p.resolve(msg.result);
      return;
    }
    if (msg?.method === 'textDocument/publishDiagnostics') {
      const uri = String(msg.params?.uri ?? '');
      const items: LspDiagnostic[] = (msg.params?.diagnostics ?? []).slice(0, 200).map((d: any) => ({
        message: String(d.message ?? ''),
        severity: d.severity,
        line: d.range?.start?.line,
        character: d.range?.start?.character,
        source: d.source,
        code: d.code,
      }));
      this.diagnostics.set(uri, items);
      this.onDiagnostics?.(uri, items);
    }
  }

  request(method: string, params: unknown, timeoutMs = 8000): Promise<any> {
    if (this.dead || !this.proc) return Promise.reject(new Error(`خادم اللغة «${this.name}» غير متاح`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error(`انتهت مهلة الرد من «${this.name}» على ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc!.stdin!.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params: unknown): void {
    if (this.dead || !this.proc) return;
    this.proc.stdin!.write(encodeFrame({ jsonrpc: '2.0', method, params }));
  }

  /** يفتح المستند مرة واحدة (ويرسله مجدداً إن تغيّر) */
  async ensureOpen(abs: string): Promise<void> {
    const uri = pathToUri(abs);
    let text: string;
    try {
      text = await fs.readFile(abs, 'utf8');
    } catch {
      throw new Error(`تعذّر قراءة الملف: ${abs}`);
    }
    const version = (this.opened.get(uri) ?? 0) + 1;
    const ext = path.extname(abs).replace('.', '').toLowerCase();
    if (version === 1) {
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.conf.languageId ?? ext, version, text },
      });
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    }
    this.opened.set(uri, version);
  }

  /** تعريف «المصدر» لخوادم TypeScript: يحلّ الاسم المستعار إلى موضع التنفيذ الحقيقي */
  async sourceDefinition(uri: string, position: { line: number; character: number }): Promise<any[] | null> {
    if (!this.serverCommands.includes('_typescript.goToSourceDefinition')) return null;
    const r = await this.request('workspace/executeCommand', {
      command: '_typescript.goToSourceDefinition',
      arguments: [uri, { line: position.line, character: position.character }],
    }).catch(() => null);
    return Array.isArray(r) ? r : null;
  }

  async shutdown(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    try {
      await this.request('shutdown', null, 3000);
      this.notify('exit', null);
    } catch {
      /* نتجاهل: سنقتله */
    }
    this.dead = true;
    setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* تجاهل */
      }
    }, 500);
  }

  kill(): void {
    this.dead = true;
    try {
      this.proc?.kill();
    } catch {
      /* تجاهل */
    }
  }
}

// ---------- المدير ----------

export interface LspStatus {
  name: string;
  available: boolean;
  running: boolean;
  extensions: string[];
  reason?: string;
}

export interface LspDeps {
  /** للاختبار: بديل عن تشغيل الخادم */
  makeClient?: (name: string, conf: LspServerConf, root: string) => LspClient;
}

export class LspManager {
  private clients = new Map<string, LspClient>();
  private availability = new Map<string, { at: number; ok: boolean; reason?: string }>();

  constructor(
    private cfg: LspConfig,
    private root: string,
    private deps: LspDeps = {},
  ) {}

  setConfig(cfg: LspConfig): void {
    this.cfg = cfg;
  }

  /** خادم يخدم هذا الملف */
  serverFor(file: string): { name: string; conf: LspServerConf } | null {
    const ext = path.extname(file).replace('.', '').toLowerCase();
    if (!ext) return null;
    for (const [name, conf] of Object.entries(this.cfg.servers)) {
      if (conf.extensions.includes(ext)) return { name, conf };
    }
    return null;
  }

  /** هل الأمر موجود؟ (نُجرّب التشغيل بإصدار سريع) */
  async available(name: string): Promise<{ ok: boolean; reason?: string }> {
    const c = this.availability.get(name);
    if (c && Date.now() - c.at < 60_000) return { ok: c.ok, reason: c.reason };
    const conf = this.cfg.servers[name];
    if (!conf) return { ok: false, reason: 'خادم غير معروف' };
    const res = await probeCommand(conf.command);
    this.availability.set(name, { at: Date.now(), ok: res.ok, reason: res.reason });
    return res;
  }

  private client(name: string): LspClient {
    const existing = this.clients.get(name);
    if (existing && !existing.dead) return existing;
    const conf = this.cfg.servers[name];
    const c = this.deps.makeClient ? this.deps.makeClient(name, conf, this.root) : new LspClient(name, conf, this.root);
    this.clients.set(name, c);
    return c;
  }

  /** يضمن تشغيل خادم للملف، أو يشرح البديل */
  async ensure(file: string): Promise<{ client: LspClient; name: string } | { error: string }> {
    const s = this.serverFor(file);
    if (!s) return { error: `لا خادم لغة معرّف لامتداد «${path.extname(file)}». يمكنك إضافته في .freecode/lsp.json.` };
    const av = await this.available(s.name);
    if (!av.ok) return { error: `خادم اللغة «${s.name}» غير متاح: ${av.reason ?? 'الأمر غير موجود'}. بديل: استخدم أدوات البحث (search/read_file${fallbackHint()}).` };
    const client = this.client(s.name);
    try {
      await client.start();
    } catch (e: any) {
      client.kill();
      return { error: `تعذّر تشغيل «${s.name}»: ${String(e?.message ?? e).slice(0, 200)}` };
    }
    return { client, name: s.name };
  }

  /** line/character بنظام 1 كما يكتبها المستخدم والنموذج؛ تُحوَّل داخلياً إلى نظام LSP */
  async definition(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }> {
    const r = await this.withDoc(file, (c) => c.request('textDocument/definition', { textDocument: { uri: pathToUri(file) }, position: toLspPosition(line, character) }));
    if ('error' in r) return { ok: false, text: r.error };
    const hopped = await this.hopThroughImport(file, r.value);
    if (hopped) return { ok: true, text: formatLocations(hopped, this.root, 'التعريف') };
    const empty = !Array.isArray(r.value) ? !r.value : r.value.length === 0;
    if (empty || this.pointsAtImport(file, r.value)) {
      // خوادم TypeScript تعرف الأمر الخاص «اذهب إلى تعريف المصدر»: أفضل من إعطاء سطر الاستيراد
      const viaSource = await this.withDoc(file, (c) => c.sourceDefinition(pathToUri(file), toLspPosition(line, character)));
      const arr = viaSource && 'value' in viaSource && Array.isArray(viaSource.value) ? viaSource.value : null;
      if (arr && arr.length) return { ok: true, text: formatLocations(arr, this.root, 'التعريف') };
    }
    return { ok: true, text: formatLocations(r.value, this.root, 'التعريف') };
  }

  /**
   * بعض خوادم اللغة تُعيد سطر الاستيراد نفسه عند طلب تعريف رمز مستورد
   * (تراه في TypeScript: «import add»). نقفزة واحدة إضافية من داخل سطر الاستيراد
   * تعطي التعريف الحقيقي بلا دوران: شرطها نتيجة واحدة في الملف نفسه وعلى سطر import/require.
   */
  /** هل تشير كل النتائج إلى أسطر استيراد في الملف نفسه؟ (علامة أن الخادم لم يحلّ الاسم المستعار) */
  private pointsAtImport(file: string, raw: any): boolean {
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (!arr.length || arr.length > 1) return false;
    const loc = arr[0];
    const abs = uriToPath(loc?.uri ?? loc?.targetUri ?? '');
    const range = loc?.range ?? loc?.targetSelectionRange ?? loc?.targetRange;
    if (abs !== file || (range?.start?.line ?? -1) < 0) return false;
    const lines = this.lineCache.get(file) ?? '';
    const text = (lines || '').split(/\r?\n/)[range.start.line] ?? '';
    return /^\s*(import|export)\b/.test(text) || /\brequire\s*\(/.test(text);
  }

  /** أسطر ملف مخزّنة مؤقتاً لتفادي قراءة القرص في كل موضع */
  private lineCache = new Map<string, string>();

  private async fileLines(file: string): Promise<string> {
    const hit = this.lineCache.get(file);
    if (hit !== undefined) return hit;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    this.lineCache.set(file, text);
    return text;
  }

  private async hopThroughImport(file: string, raw: any): Promise<any[] | null> {
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (arr.length !== 1) return null;
    const loc = arr[0];
    const abs = uriToPath(loc?.uri ?? loc?.targetUri ?? '');
    if (!abs || abs !== file) return null; // القفزة داخلية فقط
    const range = loc?.range ?? loc?.targetSelectionRange ?? loc?.targetRange;
    const ln = range?.start?.line ?? 0;
    const source = await this.fileLines(file);
    const lineText = source.split(/\r?\n/)[ln] ?? '';
    const looksImport = /^\s*(import|export)\b/.test(lineText) || /\brequire\s*\(/.test(lineText);
    if (!looksImport) return null;
    const pos = range?.start ?? { line: ln, character: 0 };
    const r2 = await this.withDoc(file, (c) =>
      c.request('textDocument/definition', { textDocument: { uri: pathToUri(file) }, position: { line: pos.line, character: pos.character } }),
    ).catch(() => null);
    if (!r2 || 'error' in r2) return null;
    const arr2 = Array.isArray(r2.value) ? r2.value : r2.value ? [r2.value] : [];
    if (!arr2.length || JSON.stringify(arr2) === JSON.stringify(arr)) return null;
    return arr2;
  }

  async references(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }> {
    const r = await this.withDoc(file, (c) =>
      c.request('textDocument/references', { textDocument: { uri: pathToUri(file) }, position: toLspPosition(line, character), context: { includeDeclaration: true } }),
    );
    if ('error' in r) return { ok: false, text: r.error };
    return { ok: true, text: formatLocations(r.value, this.root, 'المراجع', 60) };
  }

  async hover(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }> {
    const r = await this.withDoc(file, (c) => c.request('textDocument/hover', { textDocument: { uri: pathToUri(file) }, position: toLspPosition(line, character) }));
    if ('error' in r) return { ok: false, text: r.error };
    const v = r.value;
    const text = typeof v?.contents === 'string' ? v.contents : (v?.contents?.value ?? '');
    const clean = String(text).replace(/```[\w]*\n?/g, '').trim();
    return { ok: true, text: clean ? clean.slice(0, 2000) : 'لا معلومات من خادم اللغة عند هذا الموضع.' };
  }

  /** تشخيصات محفوظة من الخادم (بعد فتح الملف وانتظار قصير) */
  async diagnostics(file: string, waitMs = 2500): Promise<{ ok: boolean; text: string }> {
    const opened = await this.withDocRaw(file);
    if ('error' in opened) return { ok: false, text: opened.error };
    const uri = pathToUri(file);
    const deadline = Date.now() + waitMs;
    let items = this.clients.get(opened.name)?.diagnostics.get(uri);
    while ((!items || !items.length) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      items = this.clients.get(opened.name)?.diagnostics.get(uri);
    }
    if (!items) return { ok: true, text: 'لم يُرسل الخادم تشخيصات لهذا الملف (قد يكون سليماً أو لم يكمل التحليل بعد).' };
    if (!items.length) return { ok: true, text: '✅ لا أخطاء ولا تحذيرات في هذا الملف حسب خادم اللغة.' };
    const sevAr = ['خطأ', 'تحذير', 'معلومة', 'تلميح'];
    const lines = items.slice(0, 40).map((d) => `• [${sevAr[(d.severity ?? 1) - 1] ?? 'تنبيه'}] ${(d.line ?? 0) + 1}:${(d.character ?? 0) + 1} ${d.message}${d.source ? ` (${d.source})` : ''}`);
    return { ok: true, text: `تشخيصات ${items.length}:\n${lines.join('\n')}` };
  }

  private async withDoc(file: string, fn: (c: LspClient) => Promise<any>): Promise<{ value: any } | { error: string }> {
    const opened = await this.withDocRaw(file);
    if ('error' in opened) return { error: opened.error };
    try {
      return { value: await fn(opened.client) };
    } catch (e: any) {
      return { error: `فشل الطلب من خادم اللغة: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }

  private async withDocRaw(file: string): Promise<{ client: LspClient; name: string } | { error: string }> {
    const r = await this.ensure(file);
    if ('error' in r) return r;
    try {
      await r.client.ensureOpen(file);
    } catch (e: any) {
      return { error: String(e?.message ?? e).slice(0, 200) };
    }
    return r;
  }

  async status(): Promise<LspStatus[]> {
    const out: LspStatus[] = [];
    for (const [name, conf] of Object.entries(this.cfg.servers)) {
      const av = await this.available(name);
      out.push({ name, available: av.ok, running: !!this.clients.get(name) && !this.clients.get(name)!.dead, extensions: conf.extensions, reason: av.reason });
    }
    return out;
  }

  async stopAll(): Promise<void> {
    for (const c of this.clients.values()) await c.shutdown().catch(() => c.kill());
    this.clients.clear();
  }

  get runningCount(): number {
    let n = 0;
    for (const c of this.clients.values()) if (!c.dead) n++;
    return n;
  }
}

/** يجرّب تشغيل الأمر بإصدار (يطابق أي إصدار أو خروج بلا خطأ) */
export function probeCommand(command: string, timeoutMs = 4000): Promise<{ ok: boolean; reason?: string }> {
  if (command.includes(path.sep) || command.startsWith('.')) {
    // مسار صريح: يكفي وجوده
    return fs
      .access(command)
      .then(() => ({ ok: true }))
      .catch(() => ({ ok: false, reason: `الملف غير موجود: ${command}` }));
  }
  return new Promise((resolve) => {
    const p = spawn(command, ['--version'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      p.kill();
      // كثير من الخوادم لا تدعم --version لكنها تعمل؛ لا نعاقبها بسبب المهلة
      resolve({ ok: true, reason: 'لم يستجب لـ--version (سنحاول التشغيل عند أول استخدام)' });
    }, timeoutMs);
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'الأمر غير مثبّت على الجهاز' });
    });
    p.on('exit', () => {
      clearTimeout(timer);
      resolve({ ok: true });
    });
  });
}

function fallbackHint(): string {
  return ' · أو شغّل الخادم بتثبيته (مثل npm i -g typescript-language-server)';
}

/** ينسّق مواقع LSP (تعريف/مراجع) إلى نص عربي مقروء */
export function formatLocations(raw: any, root: string, label: string, limit = 20): string {
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!arr.length) return `لم أجد ${label === 'التعريف' ? 'تعريفاً' : 'مراجع'} لهذا الموضع.`;
  const shown = arr.slice(0, limit).map((loc: any) => {
    const uri = loc?.uri ?? loc?.targetUri ?? '';
    const range = loc?.range ?? loc?.targetSelectionRange ?? loc?.targetRange;
    const abs = uriToPath(uri);
    const rel = abs.startsWith(root) ? path.relative(root, abs).split(path.sep).join('/') : abs;
    return `• ${rel}:${fromLspPosition(range?.start)}`;
  });
  const more = arr.length > limit ? `\n…و${arr.length - limit} موضعاً آخر` : '';
  return `${label} (${arr.length}):\n${shown.join('\n')}${more}`;
}

// ---------- بديل بلا خادم: فهرسة نصية للرموز ----------

export interface TextDefinition {
  file: string;
  line: number;
  text: string;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', 'target', '__pycache__', '.venv', 'venv', 'coverage', '.next']);
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'rb', 'php', 'cs', 'c', 'h', 'cpp', 'hpp', 'swift', 'scala']);

/**
 * فهرسة نصية: يبحث عن تعريفات رمز بالاسم عند غياب خادم لغة.
 * ليست بدقة LSP (بلا أنواع ولا سياق)، لكنها تجد الموضع بسرعة.
 */
export async function findTextDefinitions(root: string, name: string, limit = 30): Promise<TextDefinition[]> {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > 80) return [];
  const esc = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(
    `(?:^|[^\\w$])(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|const|let|var|def|struct|trait|impl|func|record)\\s+${esc}\\b` +
      `|(?:pub\\s+)?(?:fn|struct|enum|trait)\\s+${esc}\\b`,
  );
  const out: TextDefinition[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 10) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || (e.name.startsWith('.') && e.name !== '.freecode')) continue;
        await walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile() && CODE_EXT.has(path.extname(e.name).replace('.', '').toLowerCase())) {
        const abs = path.join(dir, e.name);
        let text: string;
        try {
          const st = await fs.stat(abs);
          if (st.size > 400_000) continue;
          text = await fs.readFile(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 500) continue;
          if (decl.test(lines[i])) {
            out.push({ file: path.relative(root, abs).split(path.sep).join('/'), line: i + 1, text: lines[i].trim().slice(0, 160) });
            if (out.length >= limit) return;
          }
        }
      }
    }
  };
  await walk(root, 0);
  return out;
}

/** يستخرج الرمز (identifier) عند موضع معيّن من سطر — للاستخدام في البديل النصي */
export function identifierAt(line: string, character: number): string {
  const s = String(line ?? '');
  const i = Math.max(0, Math.min(s.length - 1, character));
  const isWord = (ch: string) => /[\w$]/.test(ch);
  if (!s.length) return '';
  let a = i;
  let b = i;
  while (a > 0 && isWord(s[a - 1])) a--;
  while (b < s.length && isWord(s[b])) b++;
  return s.slice(a, b);
}
