import { app, BrowserWindow, dialog, ipcMain, Notification, safeStorage, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Agent, DEFAULT_OPTIONS, type AgentOptions, type Mode } from './agent';
import { estimateTokens, listModels, normalizeBaseUrl, type ChatMessage, type LLMConfig } from './llm';
import { SessionStore, dehydrateImages, messagesToItems, newSessionId, rehydrateImages, sessionStats, sessionToMarkdown, titleFrom, type SessionData } from './sessions';
import { attachMentions, listCustomCommands, listDir, readPreview, searchFiles } from './files';
import { McpManager, loadMcpFile, type McpServerConfig } from './mcp';
import { RULES_TEMPLATE, addUserAllow, loadRules, parseRules, suggestRule, type LoadedRules } from './rules';
import { memoryPath, appendMemory, loadMemory } from './memory';
import { clearImageCache, filterImageDataUrls, readImageDataUrl, saveImages } from './images';
import { SKILL_TEMPLATE, discoverSkills, skillInvocation } from './skills';
import { runSecurityScan } from './security';
import { SANDBOX_DEFAULTS, describeSandbox, detectEngine, prepareSandbox, type ContainerEngine, type EngineInfo, type SandboxMode, type SandboxSettings } from './sandbox';
import { LspManager, loadLspConfig } from './lsp';
import { IdeBridge, describeBridge, newBridgeToken, type BridgeConfig } from './bridge';
import { activePlugins, describePlugin, discoverPlugins, mergePluginRules, pluginMcpServers, scaffoldPlugin, type Plugin } from './plugins';
import { autoCommit, isRepo } from './git';
import { AgentPool, MAX_PARALLEL, formatPoolReport, statusAr, type ParallelAgent } from './parallel';
import { canUseWorktrees } from './worktrees';
import { killAllShells, listManagedProcesses, stopAllManagedProcesses, stopManagedProcess } from './shell';
import { Telemetry, failuresToTask, formatReliability, recentFailures, summarizeTelemetry } from './telemetry';
import { evalModels, formatEvalReport, evalReportJson, type ModelTarget } from './modeleval';
import { appendEvalHistory, buildDashboard, dashboardJson, dashboardLine, formatDashboard, readEvalHistory, sweepRunNotice } from './metrics';
import { formatProjectTaskSet, projectTasksFromEvents } from './projecteval';
import { abReportJson, CONTEXT_AXES, contextVariants, formatAbReport, readVariant, runAbTest, taskFromPrompt, type ContextAxis } from './abtest';
import { loadProjectInstructions } from './context';
import { historyBadgePng, writeShareCard } from './share';
import { readSweepArchive, sweepConfigPath, sweepDigest, sweepTimeline } from './sweepconfig';
import { spawn } from 'node:child_process';
import { collectAuditBundle, crossModelAudit, explainDisagreement, formatAuditSection, formatCrossAuditSection, formatDisagreementSection, semanticAudit } from './pluginaudit';
import { applyInstall, discardReview, formatInstalled, formatReview, listInstalled, removeInstall, reviewInstall, reviewUpdate, type PluginReview } from './plugininstall';
import { EVAL_TASKS, quickTasks } from './evaltasks';

interface StoredSettings {
  baseUrl: string;
  model: string;
  apiKeyEnc?: string; // base64، مشفّر بـ safeStorage عند توفره
  apiKeyPlain?: string; // احتياطي إذا لم يتوفر التشفير على النظام
  workspace?: string;
  recent: string[];
  mode: Mode;
  autoApproveEdits: boolean;
  autoApproveCommands: boolean;
  tokenBudget: number;
  /** تشغيل فحص الأنواع/lint تلقائياً بعد التعديلات */
  autoVerify: boolean;
  /** أمر فحص مخصّص (فارغ = اكتشاف تلقائي) */
  verifyCommand: string;
  /** إضافة خريطة المستودع لرسالة النظام */
  repoMap: boolean;
  /** التزام git تلقائي بعد كل دورة فيها تعديلات */
  autoCommit: boolean;
  /** مزوّد بحث الويب والمفتاح */
  searchProvider: 'auto' | 'tavily' | 'brave' | 'serper' | 'duckduckgo';
  searchApiKey?: string;
  trustedMcp?: Record<string, string>; // مسار المشروع ← بصمة إعدادات MCP التي وافق عليها المستخدم
  trustedRules?: Record<string, string>; // مسار المشروع ← بصمة قواعد المشروع (allow/hooks) التي وافق عليها المستخدم
  /** الإضافات: مسار الإضافة ← بصمة وافق عليها المستخدم */
  trustedPlugins?: Record<string, string>;
  /** موديل ثانٍ للمراجعة المتقاطعة في تثبيت الإضافات (اختياري) */
  auditModel?: string;
  /** موديل ثالث محايد يفسّر الخلاف بين حكمَي الموديلين (اختياري) */
  auditModel3?: string;
  /** إضافات معطّلة (بالاسم أو المسار) */
  disabledPlugins?: string[];
  /** وضع الحماية لأوامر الوكيل (docker/podman) */
  sandbox?: SandboxSettings;
  /** جسر IDE: رمز سري ومنفذ */
  bridgeToken?: string;
  bridgePort?: number;
  bridgeAuto?: boolean;
  /** خوادم لغة واثق بها: مسار الملف ← بصمة */
  trustedLsp?: Record<string, string>;
  /** تعطيل خوادم لغة معيّنة */
  disabledLsp?: string[];
}

const DEFAULTS: StoredSettings = {
  baseUrl: 'http://127.0.0.1:31415',
  model: 'freellmapi/auto',
  recent: [],
  mode: DEFAULT_OPTIONS.mode,
  autoApproveEdits: DEFAULT_OPTIONS.autoApproveEdits,
  autoApproveCommands: DEFAULT_OPTIONS.autoApproveCommands,
  tokenBudget: DEFAULT_OPTIONS.tokenBudget,
  autoVerify: DEFAULT_OPTIONS.autoVerify,
  verifyCommand: DEFAULT_OPTIONS.verifyCommand,
  repoMap: DEFAULT_OPTIONS.repoMap,
  autoCommit: false,
  searchProvider: 'auto',
};

let win: BrowserWindow | null = null;
let agent: Agent | null = null;
let session: SessionData | null = null;
let abort: AbortController | null = null;
let running = false;
const pendingApprovals = new Map<string, (ok: boolean | 'turn' | 'file') => void>();
let store: SessionStore;
let mcp: McpManager | null = null;
let mcpRoot = '';
let mcpStarting: Promise<void> | null = null;

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
/** مجلد صور المحادثات (منفصل عن JSON الجلسات) */
const imagesDir = () => path.join(app.getPath('userData'), 'images');

function loadSettings(): StoredSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: StoredSettings): void {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

function readApiKey(s: StoredSettings): string {
  if (s.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(s.apiKeyEnc, 'base64'));
    } catch {
      return '';
    }
  }
  return s.apiKeyPlain ?? '';
}

function llmConfig(s = loadSettings()): LLMConfig {
  return { baseUrl: s.baseUrl, model: s.model, apiKey: readApiKey(s) };
}

function agentOptions(s: StoredSettings): AgentOptions {
  return {
    ...DEFAULT_OPTIONS,
    mode: s.mode,
    autoApproveEdits: s.autoApproveEdits,
    autoApproveCommands: s.autoApproveCommands,
    tokenBudget: s.tokenBudget,
    autoVerify: s.autoVerify,
    verifyCommand: s.verifyCommand,
    repoMap: s.repoMap,
    searchProvider: s.searchProvider,
    searchApiKey: s.searchApiKey ?? '',
  };
}

const userMcpFile = () => path.join(app.getPath('userData'), 'mcp.json');
const userRulesFile = () => path.join(app.getPath('userData'), 'rules.json');
/** بصمات قواعد رفض المستخدم الثقة بها في هذه الجلسة، حتى لا نسأله عند كل رسالة */
const declinedRules = new Map<string, string>();

/** يحمّل قواعد الصلاحيات والـ hooks. قواعد المشروع التي تحوي allow أو hooks تحتاج موافقة صريحة (تُسأل مرة لكل بصمة). */
async function loadRulesFor(ws: string, interactive: boolean): Promise<LoadedRules> {
  const s = loadSettings();
  let lr = await loadRules(userRulesFile(), ws, (h) => s.trustedRules?.[ws] === h);
  if (lr.needsTrust && interactive && win && declinedRules.get(ws) !== lr.hash) {
    const hash = lr.hash;
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['الثقة والتفعيل', 'تجاهل'],
      defaultId: 1,
      cancelId: 1,
      title: 'قواعد المشروع',
      message: 'يطلب هذا المشروع صلاحيات تلقائية أو أوامر hooks',
      detail: lr.projectSummary.join('\n') + '\n\nالـ hooks تُنفَّذ كأوامر على جهازك والسماح التلقائي يتجاوز سؤالك. وافق فقط إن كنت تثق بهذا المشروع. (قواعد المنع والسؤال تعمل دائماً.)',
    });
    if (r.response === 0) {
      s.trustedRules = { ...(s.trustedRules ?? {}), [ws]: hash };
      saveSettings(s);
      lr = await loadRules(userRulesFile(), ws, (h) => h === hash);
    } else declinedRules.set(ws, hash);
  }
  return lr;
}

function rulesInfo(lr: LoadedRules) {
  return {
    userPath: lr.userPath,
    projectPath: lr.projectPath,
    projectPresent: lr.projectPresent,
    projectSensitive: lr.projectSensitive,
    projectTrusted: lr.projectTrusted,
    needsTrust: lr.needsTrust,
    projectSummary: lr.projectSummary,
    errors: lr.errors,
  };
}

/** يشغّل خوادم MCP للمشروع. إعدادات المشروع (.freecode/mcp.json) لا تعمل إلا بعد موافقة صريحة من المستخدم. */
async function ensureMcp(ws: string, force = false): Promise<void> {
  if (!force && mcp && mcpRoot === ws) return mcpStarting ?? undefined;
  mcp?.stopAll();
  const m = new McpManager();
  mcp = m;
  mcpRoot = ws;
  mcpStarting = (async () => {
    const servers: Record<string, { cfg: McpServerConfig; source: string }> = {};
    for (const [n, c] of Object.entries(await loadMcpFile(userMcpFile()))) servers[n] = { cfg: c, source: 'المستخدم' };
    const proj = await loadMcpFile(path.join(ws, '.freecode', 'mcp.json'));
    // خوادم MCP التي تجلبها الإضافات الفعّالة (المستخدم ثق بها عند التثبيت)
    const wsPlugins = await loadPlugins(ws);
    for (const [n, c] of Object.entries(pluginMcpServers(wsPlugins))) servers[n] = { cfg: c, source: 'إضافة' };
    if (Object.keys(proj).length) {
      const s = loadSettings();
      const hash = createHash('sha256').update(JSON.stringify(proj)).digest('hex');
      let trusted = s.trustedMcp?.[ws] === hash;
      if (!trusted && win) {
        const r = await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['السماح', 'تجاهل'],
          defaultId: 1,
          cancelId: 1,
          title: 'خوادم MCP',
          message: 'يطلب هذا المشروع تشغيل خوادم MCP',
          detail:
            Object.entries(proj).map(([n, c]) => `${n}: ${c.command} ${(c.args ?? []).join(' ')}`).join('\n') +
            '\n\nهذه أوامر ستُنفَّذ على جهازك. اسمح فقط إن كنت تثق بهذا المشروع.',
        });
        trusted = r.response === 0;
        if (trusted) {
          s.trustedMcp = { ...(s.trustedMcp ?? {}), [ws]: hash };
          saveSettings(s);
        }
      }
      if (trusted) for (const [n, c] of Object.entries(proj)) servers[n] = { cfg: c, source: 'المشروع' };
    }
    await m.start(servers, ws);
  })();
  await mcpStarting;
}

function makeAgent(cfg: LLMConfig, ws: string, options: AgentOptions, history: ChatMessage[] = []): Agent {
  const a = new Agent(cfg, ws, options, history);
  a.extraTools = () => (mcp && mcpRoot === ws ? mcp.toolDefs() : []);
  return a;
}

function send(event: Record<string, unknown>): void {
  win?.webContents.send('agent:event', event);
}

function publicSettings() {
  const s = loadSettings();
  return {
    baseUrl: s.baseUrl,
    model: s.model,
    hasKey: !!readApiKey(s),
    workspace: s.workspace ?? null,
    recent: s.recent,
    mode: s.mode,
    autoApproveEdits: s.autoApproveEdits,
    autoApproveCommands: s.autoApproveCommands,
    tokenBudget: s.tokenBudget,
    autoVerify: s.autoVerify,
    verifyCommand: s.verifyCommand,
    repoMap: s.repoMap,
    autoCommit: s.autoCommit,
    searchProvider: s.searchProvider,
    hasSearchKey: !!(s.searchApiKey ?? '').trim(),
    endpoint: normalizeBaseUrl(s.baseUrl),
  };
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'FreeCode',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e: { preventDefault(): void }, url: string) => {
    if (!url.startsWith('file:')) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  win.on('closed', () => (win = null));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    store = new SessionStore(path.join(app.getPath('userData'), 'sessions'));
    createWindow();
    // الجسر الاختياري: يُشغَّل تلقائياً إن فعّله المستخدم سابقاً
    const boot = loadSettings();
    if (boot.bridgeAuto && boot.bridgeToken) void startBridge().catch((e) => console.error('bridge', e));
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// عند الخروج: نوقف الوكيل ونقتل كل أوامر shell الجارية، وإلا بقيت عمليات يتيمة
// (run_command يعمل detached في مجموعة عمليات مستقلة).
app.on('before-quit', () => {
  abort?.abort();
  pool?.stopAll();
  void bridge?.stop();
  void lsp?.stopAll();
  const procs = stopAllManagedProcesses();
  const killed = killAllShells();
  if (procs || killed) console.log(`أُوقفت ${procs + killed} عملية عند الخروج`);
  mcp?.stopAll();
});

process.on('unhandledRejection', (e: unknown) => console.error('unhandledRejection', e));

// ---------- مساعدات ----------

function setWorkspace(dir: string): void {
  const s = loadSettings();
  s.workspace = dir;
  s.recent = [dir, ...s.recent.filter((r) => r !== dir)].slice(0, 8);
  saveSettings(s);
  if (agent && agent.root !== dir) {
    agent = null;
    session = null;
  }
}

async function persist(): Promise<void> {
  if (!agent || !session) return;
  // الصور تُكتب في ملفات وتُستبدل بمراجع، فلا تتضخم ملفات الجلسات
  const history = agent.history();
  session.messages = history.some((m) => m.images?.length)
    ? await dehydrateImages(history, (i, urls) => saveImages(imagesDir(), session!.id, i, urls))
    : history;
  session.todos = agent.todos;
  if (session.title === 'محادثة جديدة') {
    const first = session.messages.find((m) => m.role === 'user');
    if (first?.content) session.title = titleFrom(first.content);
  }
  if (session.messages.length) await store.save(session);
}

// ---------- الإضافات (Plugins) ----------

/** إضافات المشروع الحالي بعد قراءة حالة الثقة/التعطيل من الإعدادات */
async function loadPlugins(ws: string): Promise<Plugin[]> {
  const s = loadSettings();
  return discoverPlugins(ws, app.getPath('userData'), { trusted: s.trustedPlugins ?? {}, disabled: s.disabledPlugins ?? [] }).catch(() => []);
}

/** يدمج قواعد الإضافات الفعّالة في قواعد الجلسة */
function withPluginRules(rules: LoadedRules, plugins: Plugin[]): LoadedRules {
  const active = activePlugins(plugins);
  if (!active.length) return rules;
  return { ...rules, rules: mergePluginRules(rules.rules, plugins) };
}

/** مجلدات مهارات الإضافات الفعّالة (للكشف والقراءة) */
function pluginSkillDirs(plugins: Plugin[]): { dir: string; source: 'project' | 'user' }[] {
  return activePlugins(plugins).flatMap((p) => p.skillDirs.map((dir) => ({ dir, source: p.source })));
}

/** كل الجذور المسموح للوكيل القراءة منها (خارج المشروع) */
function readRootsFor(ws: string, plugins: Plugin[]): string[] {
  const userData = app.getPath('userData');
  const roots = [path.join(userData, 'skills'), ...pluginSkillDirs(plugins).map((d) => d.dir), ...activePlugins(plugins).map((p) => p.dir)];
  return roots.filter((r) => !r.startsWith(ws));
}

// ---------- وضع الحماية (Sandbox) ----------

const sandboxSettings = (s: StoredSettings): SandboxSettings => ({ ...SANDBOX_DEFAULTS, ...(s.sandbox ?? {}) });
const engineCache = new Map<ContainerEngine, EngineInfo>();

/** حالة المحرّكات (مع كاش قصير عبر detectEngine نفسه) */
async function engineStatus(): Promise<Partial<Record<ContainerEngine, EngineInfo>>> {
  const out: Partial<Record<ContainerEngine, EngineInfo>> = {};
  for (const e of ['docker', 'podman'] as ContainerEngine[]) {
    const info = await detectEngine(e);
    engineCache.set(e, info);
    out[e] = info;
  }
  return out;
}

/** يحوّل أمراً للتنفيذ في حاوية حسب الإعدادات الحالية */
function sandboxFor(s: StoredSettings) {
  const cfg = sandboxSettings(s);
  if (!cfg.mode || cfg.mode === 'off') return undefined;
  return (command: string) => {
    const engines: Partial<Record<ContainerEngine, EngineInfo>> = {};
    for (const [k, v] of engineCache) engines[k] = v;
    return prepareSandbox(cfg, engines, s.workspace ?? process.cwd(), command);
  };
}

/** يهيّئ حالة المحرّكات مسبقاً كي لا يتأخر أول أمر */
async function warmSandbox(s: StoredSettings): Promise<void> {
  const cfg = sandboxSettings(s);
  if (cfg.mode === 'off') return;
  const engines = await engineStatus();
  const note = describeSandbox(cfg, engines);
  const d = engines;
  if (cfg.mode !== 'auto' && !(d.docker?.available || d.podman?.available)) send({ type: 'notice', message: note });
}

// ---------- ذكاء الكود (LSP) ----------

// ---------- قياس الموثوقية (محلي فقط) ----------

/** سجل القياس في مجلد بيانات المستخدم؛ لا يُرسل لأي مكان */
let telemetry: Telemetry | null = null;
let telemetryLoaded = false;

function telemetryFor(): Telemetry {
  if (!telemetry) telemetry = new Telemetry(path.join(app.getPath('userData'), 'telemetry.jsonl'));
  return telemetry;
}

async function ensureTelemetryLoaded(): Promise<void> {
  if (telemetryLoaded) return;
  const t = telemetryFor();
  const events = await Telemetry.load(path.join(app.getPath('userData'), 'telemetry.jsonl'));
  if (events.length) t.events = events;
  telemetryLoaded = true;
}

let lsp: LspManager | null = null;
let lspRoot = '';

async function ensureLsp(ws: string): Promise<LspManager> {
  const s = loadSettings();
  const trusted = (file: string, hash: string) => (loadSettings().trustedLsp ?? {})[file] === hash;
  const cfg = await loadLspConfig(ws, app.getPath('userData'), trusted);
  const disabled = new Set(s.disabledLsp ?? []);
  for (const name of Object.keys(cfg.servers)) if (disabled.has(name)) delete cfg.servers[name];
  if (lsp && lspRoot === ws) {
    lsp.setConfig(cfg);
  } else {
    await lsp?.stopAll();
    lsp = new LspManager(cfg, ws);
    lspRoot = ws;
  }
  if (cfg.needsTrust && win) send({ type: 'notice', message: 'إعداد خوادم اللغة في المشروع (.freecode/lsp.json) يحتاج ثقتك: /lsp trust' });
  for (const e of cfg.errors) send({ type: 'notice', message: `lsp.json: ${e}` });
  return lsp;
}

// ---------- جسر IDE ----------

let bridge: IdeBridge | null = null;

async function startBridge(): Promise<void> {
  const s = loadSettings();
  if (!s.bridgeToken) {
    s.bridgeToken = newBridgeToken();
    s.bridgePort = s.bridgePort || 4177;
    saveSettings(s);
  }
  bridge = new IdeBridge({
    llm: () => llmConfig(loadSettings()),
    workspace: () => loadSettings().workspace ?? null,
    options: () => agentOptions(loadSettings()),
    prepare: async (a) => {
      const ws = loadSettings().workspace;
      if (!ws) return;
      const lr = await loadRulesFor(ws, false);
      const plugins = await loadPlugins(ws);
      a.rules = withPluginRules(lr, plugins).rules;
      a.skills = await discoverSkills(ws, app.getPath('userData'), pluginSkillDirs(plugins)).catch(() => []);
      a.readRoots = readRootsFor(ws, plugins);
      const cfg = sandboxSettings(loadSettings());
      if (cfg.mode !== 'off') {
        const engines = await engineStatus();
        a.sandbox = (command: string) => prepareSandbox(cfg, engines, ws, command);
      }
      a.lsp = await ensureLsp(ws);
    },
  });
  const st = await bridge.start({ port: s.bridgePort ?? 4177, token: s.bridgeToken });
  send({ type: 'bridge', status: { ...st, token: s.bridgeToken } });
}

async function stopBridge(): Promise<void> {
  await bridge?.stop();
  bridge = null;
  send({ type: 'bridge', status: null });
}

// ---------- الوكلاء المتوازيون ----------

let pool: AgentPool | null = null;

/** منسّق واحد لكل مجلد مشروع، ويُعاد إنشاؤه عند تغيير المشروع */
function makePool(cfg: LLMConfig, ws: string, s: StoredSettings): AgentPool {
  const userData = app.getPath('userData');
  if (pool && pool.root === ws) {
    pool.cfg = cfg;
    return pool;
  }
  pool?.stopAll();
  pool = new AgentPool(
    cfg,
    ws,
    userData,
    { ...DEFAULT_OPTIONS, ...agentOptions(s), autoApproveEdits: true, autoApproveCommands: false },
    {
      onUpdate: (a) => send({ type: 'agents', list: poolList() }),
      onLog: (id, chunk) => send({ type: 'agent_log', id, chunk }),
      onNotice: (message) => send({ type: 'notice', message }),
    },
  );
  void pool.load().then(() => send({ type: 'agents', list: poolList() }));
  return pool;
}

function poolList(): (ParallelAgent & { statusText: string })[] {
  return (pool?.list() ?? []).map((a) => ({ ...a, statusText: statusAr(a.status) }));
}

/** يشغّل التفويض ويعيد التقرير النصي للنموذج (يُستخدم من أداة delegate) */
async function runDelegates(tasks: { label: string; task: string }[]): Promise<string> {
  const s = loadSettings();
  if (!s.workspace) return 'لا مشروع مفتوح.';
  const ok = await canUseWorktrees(s.workspace);
  if (!ok.ok) return ok.error!;
  const p = makePool(llmConfig(s), s.workspace, s);
  send({ type: 'notice', message: `بدأ ${Math.min(tasks.length, MAX_PARALLEL)} وكيل متوازٍ في نسخ معزولة — تابعهم في لوحة «الوكلاء».` });
  const agents = await p.run(tasks);
  return formatPoolReport(agents);
}

// ---------- IPC: الإعدادات والمشروع ----------

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle(
  'settings:set',
  (
    _e: unknown,
    patch: Partial<
      Pick<
        StoredSettings,
        'baseUrl' | 'model' | 'mode' | 'autoApproveEdits' | 'autoApproveCommands' | 'tokenBudget' | 'autoVerify' | 'verifyCommand' | 'repoMap' | 'autoCommit' | 'searchProvider'
      >
    > & {
      apiKey?: string;
      /** يمسح المفتاح المحفوظ (لا يمكن تمييزه عن "اتركه كما هو" بالسلسلة الفارغة) */
      clearKey?: boolean;
      /** مفتاح مزوّد البحث (فارغ = اتركه كما هو) */
      searchApiKey?: string;
      clearSearchKey?: boolean;
    },
  ) => {
    const s = loadSettings();
    if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) s.baseUrl = patch.baseUrl.trim();
    if (typeof patch.model === 'string' && patch.model.trim()) s.model = patch.model.trim();
    if (patch.mode === 'plan' || patch.mode === 'act') s.mode = patch.mode;
    if (typeof patch.autoApproveEdits === 'boolean') s.autoApproveEdits = patch.autoApproveEdits;
    if (typeof patch.autoApproveCommands === 'boolean') s.autoApproveCommands = patch.autoApproveCommands;
    if (typeof patch.tokenBudget === 'number' && patch.tokenBudget >= 4000 && patch.tokenBudget <= 1_000_000) s.tokenBudget = Math.round(patch.tokenBudget);
    if (typeof patch.autoVerify === 'boolean') s.autoVerify = patch.autoVerify;
    if (typeof patch.repoMap === 'boolean') s.repoMap = patch.repoMap;
    if (typeof patch.autoCommit === 'boolean') s.autoCommit = patch.autoCommit;
    if (typeof patch.verifyCommand === 'string') s.verifyCommand = patch.verifyCommand.trim().slice(0, 300);
    if (patch.searchProvider === 'auto' || patch.searchProvider === 'tavily' || patch.searchProvider === 'brave' || patch.searchProvider === 'serper' || patch.searchProvider === 'duckduckgo')
      s.searchProvider = patch.searchProvider;
    if (typeof patch.searchApiKey === 'string' && patch.searchApiKey.trim()) s.searchApiKey = patch.searchApiKey.trim();
    else if (patch.clearSearchKey === true) delete s.searchApiKey;
    if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) {
      const key = patch.apiKey.trim();
      if (safeStorage.isEncryptionAvailable()) {
        s.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
        delete s.apiKeyPlain;
      } else {
        s.apiKeyPlain = key;
        delete s.apiKeyEnc;
      }
    } else if (patch.clearKey === true) {
      delete s.apiKeyEnc;
      delete s.apiKeyPlain;
    }
    saveSettings(s);
    // نُحدّث الوكيل الحالي بدل إعادة إنشائه حتى لا نفقد المحادثة
    if (agent) {
      agent.cfg = llmConfig(s);
      agent.options = agentOptions(s);
    }
    return publicSettings();
  },
);

ipcMain.handle('workspace:pick', async () => {
  const opts = { properties: ['openDirectory' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  setWorkspace(r.filePaths[0]);
  return publicSettings();
});

ipcMain.handle('workspace:set', (_e: unknown, dir: string) => {
  if (typeof dir !== 'string' || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  setWorkspace(dir);
  return publicSettings();
});

ipcMain.handle('tree:list', async (_e: unknown, rel: string) => {
  const ws = loadSettings().workspace;
  if (!ws) return [];
  try {
    return await listDir(ws, rel);
  } catch {
    return [];
  }
});

ipcMain.handle('file:read', async (_e: unknown, rel: string) => {
  const ws = loadSettings().workspace;
  return ws ? readPreview(ws, rel) : { ok: false, error: 'لا يوجد مشروع' };
});

ipcMain.handle('files:search', async (_e: unknown, q: string) => {
  const ws = loadSettings().workspace;
  return ws ? searchFiles(ws, String(q ?? '')) : [];
});

ipcMain.handle('models:list', async () => {
  try {
    return { ok: true, models: await listModels(llmConfig()) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle('open:external', (_e: unknown, url: string) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) void shell.openExternal(url);
});

// ---------- IPC: الجلسات ----------

ipcMain.handle('sessions:list', async () => {
  const ws = loadSettings().workspace;
  return { sessions: await store.list(ws ?? undefined), currentId: session?.id ?? null };
});

ipcMain.handle('sessions:new', () => {
  if (running) return false;
  clearImageCache();
  agent = null;
  session = null;
  return true;
});

ipcMain.handle('sessions:load', async (_e: unknown, id: string) => {
  if (running) return null;
  const data = await store.load(id);
  if (!data || typeof data.id !== 'string' || !Array.isArray(data.messages)) return null;
  // مجلد المشروع قد يكون حُذف أو نُقل بعد حفظ المحادثة: الوكيل لا يستطيع العمل بجذر غير موجود،
  // فنوضّح ذلك بدل إنشاء وكيل معطوب تُفشل كل أدواته.
  const ws = typeof data.workspace === 'string' ? data.workspace : '';
  if (!ws || !fs.existsSync(ws) || !fs.statSync(ws).isDirectory()) {
    send({ type: 'error', message: 'تعذّر فتح المحادثة: مجلد المشروع لم يعد موجوداً. اختر مشروعاً آخر ثم أعد المحاولة.' });
    return null;
  }
  setWorkspace(ws);
  const s = loadSettings();
  // نُعيد الصور من ملفاتها إلى data URL قبل تمريرها للوكيل وللواجهة
  const messages = data.messages.some((m) => m.images?.length) ? await rehydrateImages(data.messages, (ref) => readImageDataUrl(imagesDir(), ref)) : data.messages;
  agent = makeAgent(llmConfig(s), ws, agentOptions(s), messages);
  agent.todos = data.todos ?? [];
  session = data;
  return { items: messagesToItems(messages), todos: data.todos ?? [], settings: publicSettings() };
});

ipcMain.handle('sessions:delete', async (_e: unknown, id: string) => {
  const sid = String(id ?? '');
  try {
    await store.remove(sid);
  } catch {
    return false; // معرّف غير صالح
  }
  if (/^[\w-]+$/.test(sid)) await fs.promises.rm(path.join(imagesDir(), sid), { recursive: true, force: true }).catch(() => {});
  if (session?.id === id) {
    agent = null;
    session = null;
  }
  return true;
});

// ---------- IPC: المحادثة ----------

ipcMain.handle('chat:send', async (_e: unknown, rawText: string, images?: unknown) => {
  if (running) return;
  // الصور القادمة من الواجهة تُفلتَر (نوع وحجم وعدد) قبل أي استخدام
  const imgs = filterImageDataUrls(images);
  if (Array.isArray(images) && images.length && !imgs.length) send({ type: 'notice', message: 'تجاهلت الصور المرفقة (صيغة أو حجم غير مدعوم، أو تجاوزت 4 صور).' });
  const dropped = Array.isArray(images) ? images.length - imgs.length : 0;
  if (imgs.length && dropped > 0) send({ type: 'notice', message: `أُرفقت ${imgs.length} صورة (تُجوهل ${dropped}).` });
  const s = loadSettings();
  if (!s.workspace) {
    send({ type: 'error', message: 'اختر مجلد المشروع أولاً.' });
    send({ type: 'done' });
    return;
  }
  const cfg = llmConfig(s);
  if (!cfg.apiKey) {
    send({ type: 'error', message: 'أدخل مفتاح FreeLLMAPI في الإعدادات أولاً.' });
    send({ type: 'done' });
    return;
  }

  // نضع علامة التشغيل قبل أي await، وإلا تمكن إرسالان سريعان من تجاوز الفحص
  // وتشغيل الوكيل مرتين بالتوازي على الجلسة نفسها.
  const ctl = new AbortController();
  running = true;
  abort = ctl;
  try {
    await ensureMcp(s.workspace).catch((e: unknown) => console.error('mcp', e));
    if (!agent) agent = makeAgent(cfg, s.workspace, agentOptions(s));
    agent.cfg = cfg;
    agent.options = agentOptions(s);
    const lr0 = await loadRulesFor(s.workspace, true);
    const plugins = await loadPlugins(s.workspace);
    const lr = withPluginRules(lr0, plugins);
    agent.rules = lr.rules;
    agent.skills = await discoverSkills(s.workspace, app.getPath('userData'), pluginSkillDirs(plugins)).catch(() => []);
    agent.readRoots = readRootsFor(s.workspace, plugins);
    // أداة delegate تتاح فقط إن كان المشروع مستودع git (وإلا لا نسخ معزولة)
    agent.delegate = (await isRepo(s.workspace)) ? runDelegates : undefined;
    // وضع الحماية وذكاء الكود لهذه الدورة
    await warmSandbox(s).catch(() => {});
    agent.sandbox = sandboxFor(s);
    agent.lsp = await ensureLsp(s.workspace).catch(() => null) ?? undefined;
    for (const e of lr.errors) send({ type: 'notice', message: `تنبيه في ملف القواعد: ${e}` });
    if (lr.needsTrust) send({ type: 'notice', message: 'قواعد المشروع (السماح التلقائي والـ hooks) غير مفعّلة لأنك لم تثق بها؛ قواعد المنع والسؤال تعمل.' });
    const pluginWarn = plugins.filter((p) => p.needsTrust);
    if (pluginWarn.length) send({ type: 'notice', message: `إضافات مشروع تحتاج ثقتك قبل التفعيل: ${pluginWarn.map((p) => p.slug).join(', ')} — استخدم /plugins trust <الاسم>.` });
    for (const p of plugins) if (p.error) send({ type: 'notice', message: `إضافة «${p.slug}» فيها خطأ: ${p.error}` });
    if (!session) {
      session = { id: newSessionId(), title: 'محادثة جديدة', workspace: s.workspace, createdAt: Date.now(), updatedAt: Date.now(), messages: [], todos: [] };
    }

    const { text, attached } = await attachMentions(s.workspace, String(rawText));
    if (attached.length) send({ type: 'notice', message: `أُرفق: ${attached.join(', ')}` });

    const a = agent;
    a.telemetry = telemetryFor();
    try {
      await a.run(
        text,
        {
          onText: (delta) => send({ type: 'text', delta }),
          onToolCall: (id, name, args) => send({ type: 'tool_call', id, name, args }),
          onToolOutput: (id, chunk) => send({ type: 'tool_output', id, chunk }),
          onToolResult: (id, name, result, isError) => send({ type: 'tool_result', id, name, result, isError }),
          approve: (id, name, args, preview) =>
            new Promise<boolean | 'turn' | 'file'>((resolve) => {
              pendingApprovals.set(id, resolve);
              send({ type: 'approval', id, name, args, preview, rule: suggestRule(name, args, a.root) });
            }),
          onTodos: (todos) => send({ type: 'todos', todos }),
          onUsage: (u) => send({ type: 'usage', ...u }),
          onRetry: (info) =>
            send({ type: 'notice', message: `المزوّد مشغول، إعادة المحاولة ${info.attempt}/${info.maxAttempts - 1} بعد ${Math.round(info.delayMs / 1000)}ث…` }),
          onChanges: (changes, undoDepth) => send({ type: 'changes', changes, undoDepth }),
          onNotice: (message) => send({ type: 'notice', message }),
        },
        ctl.signal,
        imgs,
      );
      const finalText = [...a.history()].reverse().find((m) => m.role === 'assistant' && m.content)?.content ?? '';
      send({ type: 'done' });
      notifyDone(String(finalText), false);
    } catch (e: any) {
      if (ctl.signal.aborted) {
        send({ type: 'done', aborted: true });
        notifyDone('', true);
      }
      else {
        send({ type: 'error', message: String(e?.message ?? e) });
        send({ type: 'done' });
      }
    }
  } catch (e: any) {
    // فشل قبل انطلاق الوكيل (تشغيل MCP أو قواعد المشروع أو إرفاق الملفات)
    send({ type: 'error', message: String(e?.message ?? e) });
    send({ type: 'done' });
  } finally {
    for (const [id, resolve] of pendingApprovals) {
      resolve(false);
      pendingApprovals.delete(id);
    }
    abort = null;
    running = false;
    await persist().catch((e: unknown) => console.error('persist failed', e));
    // التزام تلقائي اختياري (كأسلوب Aider): يجعل كل دورة قابلة للمراجعة والتراجع عبر git
    try {
      const st = loadSettings();
      if (st.autoCommit && agent && agent.checkpoints.depth > 0 && !ctl.signal.aborted) {
        const msg = await autoCommit(agent.root, titleFrom(String(rawText)));
        if (msg) send({ type: 'notice', message: msg });
      }
    } catch (e: unknown) {
      console.error('autoCommit', e);
    }
    send({ type: 'sessions_changed' });
  }
});

ipcMain.handle('chat:compact', async () => {
  if (!agent || running) return { summarized: 0 };
  running = true;
  abort = new AbortController();
  try {
    agent.cfg = llmConfig();
    const n = await agent.compact(abort.signal);
    send({ type: 'notice', message: n ? `لُخّصت ${n} رسالة قديمة وتحرّر جزء من السياق.` : 'المحادثة قصيرة، لا يوجد ما يستحق التلخيص.' });
    await persist();
    return { summarized: n };
  } catch (e: any) {
    send({ type: 'error', message: `تعذّر التلخيص: ${String(e?.message ?? e)}` });
    return { summarized: 0 };
  } finally {
    abort = null;
    running = false;
  }
});

ipcMain.handle('commands:list', async () => {
  const ws = loadSettings().workspace;
  return ws ? listCustomCommands(ws) : [];
});

ipcMain.handle('mcp:status', () => {
  const ws = loadSettings().workspace;
  return {
    servers: mcp && mcpRoot === ws ? mcp.statuses : [],
    userConfigPath: userMcpFile(),
    projectConfigPath: ws ? path.join(ws, '.freecode', 'mcp.json') : null,
  };
});

ipcMain.handle('mcp:reload', async () => {
  const ws = loadSettings().workspace;
  if (ws) await ensureMcp(ws, true).catch((e: unknown) => console.error('mcp', e));
  return { servers: mcp?.statuses ?? [], userConfigPath: userMcpFile(), projectConfigPath: ws ? path.join(ws, '.freecode', 'mcp.json') : null };
});

ipcMain.handle('chat:abort', () => {
  abort?.abort();
});

ipcMain.handle('chat:undo', async () => {
  if (!agent || running) return { restored: [] };
  const restored = await agent.undo();
  send({ type: 'changes', changes: agent.checkpoints.allChanges(), undoDepth: agent.checkpoints.depth });
  await persist();
  return { restored };
});

ipcMain.handle('approval:respond', (_e: unknown, id: string, ok: boolean, scope?: 'once' | 'turn' | 'file') => {
  const resolve = pendingApprovals.get(id);
  if (resolve) {
    pendingApprovals.delete(id);
    resolve(ok && (scope === 'turn' || scope === 'file') ? scope : ok);
  }
});

// ---------- IPC: القواعد والـ hooks ----------

ipcMain.handle('rules:get', async () => {
  const ws = loadSettings().workspace;
  let userText = '';
  try {
    userText = fs.readFileSync(userRulesFile(), 'utf8');
  } catch {
    userText = '';
  }
  const lr = ws ? await loadRulesFor(ws, false) : null;
  return { userText: userText || RULES_TEMPLATE, userExists: !!userText, info: lr ? rulesInfo(lr) : null, userPath: userRulesFile() };
});

ipcMain.handle('rules:save', (_e: unknown, text: string) => {
  let json: unknown;
  try {
    json = JSON.parse(String(text));
  } catch (e: any) {
    return { ok: false, error: `JSON غير صالح: ${String(e?.message ?? e)}` };
  }
  const { errors } = parseRules(json);
  if (errors.length) return { ok: false, error: errors.join('\n') };
  fs.mkdirSync(path.dirname(userRulesFile()), { recursive: true });
  fs.writeFileSync(userRulesFile(), String(text), { mode: 0o600 });
  return { ok: true };
});

ipcMain.handle('rules:trust', async () => {
  const ws = loadSettings().workspace;
  if (!ws) return null;
  const lr = await loadRules(userRulesFile(), ws, () => false);
  if (lr.projectSensitive) {
    const s = loadSettings();
    s.trustedRules = { ...(s.trustedRules ?? {}), [ws]: lr.hash };
    saveSettings(s);
    declinedRules.delete(ws);
  }
  return rulesInfo(await loadRulesFor(ws, false));
});

ipcMain.handle('rules:allow', async (_e: unknown, rule: string) => addUserAllow(userRulesFile(), String(rule ?? '')));

// ---------- IPC: الذاكرة والعمليات ----------

ipcMain.handle('memory:add', async (_e: unknown, note: string) => {
  const ws = loadSettings().workspace;
  if (!ws) return { ok: false, error: 'لا يوجد مشروع مفتوح.' };
  const ok = await appendMemory(ws, String(note ?? ''));
  return ok ? { ok: true } : { ok: false, error: 'الملاحظة فارغة أو مكررة.' };
});

ipcMain.handle('memory:read', async () => {
  const ws = loadSettings().workspace;
  return ws ? { text: await loadMemory(ws), path: memoryPath(ws) } : { text: '', path: '' };
});

/** إشعار نظام عند انتهاء العمل والتطبيق غير مُركّز (وضع «شغّل واذهب») */
function notifyDone(text: string, aborted: boolean): void {
  try {
    if (!Notification.isSupported()) return;
    if (!win || win.isDestroyed() || win.isFocused()) return;
    const body = (text || '').replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    new Notification({
      title: aborted ? 'FreeCode: أُوقف الوكيل' : 'FreeCode: انتهى',
      body: body || (aborted ? 'أوقفت العمل بناءً على طلبك.' : 'انتهت الدورة.'),
      silent: false,
    }).show();
  } catch {
    /* الإشعارات اختيارية */
  }
}

ipcMain.handle('sessions:stats', () => {
  if (!session) return { ok: false, error: 'لا جلسة مفتوحة' };
  const st = sessionStats(session);
  const s = loadSettings();
  return {
    ok: true,
    ...st,
    title: session.title,
    model: s.model,
    tokensNow: agent ? estimateTokens(agent.history()) : st.tokens,
    budget: s.tokenBudget,
  };
});

ipcMain.handle('sessions:export', async (_e: unknown, format: 'md' | 'json' = 'md') => {
  if (!session) return { ok: false, error: 'لا جلسة مفتوحة' };
  const s = loadSettings();
  const safe = session.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'freecode-chat';
  const date = new Date().toISOString().slice(0, 10);
  const ext = format === 'json' ? 'json' : 'md';
  const target = await dialog.showSaveDialog(win!, {
    title: 'تصدير المحادثة',
    defaultPath: path.join(s.workspace ?? app.getPath('documents'), `${safe}-${date}.${ext}`),
    filters: ext === 'json' ? [{ name: 'JSON', extensions: ['json'] }] : [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (target.canceled || !target.filePath) return { ok: false, canceled: true };
  const payload = format === 'json' ? JSON.stringify({ ...session, exportedAt: Date.now(), model: s.model }, null, 2) : sessionToMarkdown(session, { model: s.model });
  try {
    await fs.promises.writeFile(target.filePath, payload, 'utf8');
    return { ok: true, path: target.filePath };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle('security:scan', async (_e: unknown, opts?: { deps?: boolean; only?: string[] }) => {
  const s = loadSettings();
  if (!s.workspace) return { ok: false, error: 'لا مشروع مفتوح', text: '', findings: [], counts: { high: 0, medium: 0, low: 0 } };
  const report = await runSecurityScan(s.workspace, { deps: opts?.deps !== false, only: opts?.only });
  return report;
});

ipcMain.handle('sandbox:status', async () => {
  const s = loadSettings();
  const cfg = sandboxSettings(s);
  const engines = await engineStatus();
  return { settings: cfg, engines, text: describeSandbox(cfg, engines), templates: { image: SANDBOX_DEFAULTS.image } };
});

ipcMain.handle('sandbox:set', async (_e: unknown, patch: Partial<SandboxSettings>) => {
  const s = loadSettings();
  const next: SandboxSettings = { ...sandboxSettings(s), ...patch };
  if (next.mode !== 'off' && next.mode !== 'auto' && next.mode !== 'docker' && next.mode !== 'podman') next.mode = 'auto';
  next.image = String(next.image || SANDBOX_DEFAULTS.image).slice(0, 200);
  next.extraArgs = String(next.extraArgs ?? '').slice(0, 300);
  s.sandbox = next;
  saveSettings(s);
  await warmSandbox(s).catch(() => {});
  return { ok: true, text: describeSandbox(next, await engineStatus()) };
});

ipcMain.handle('lsp:status', async () => {
  const s = loadSettings();
  if (!s.workspace) return { ok: false, error: 'لا مشروع مفتوح', servers: [] };
  const mgr = await ensureLsp(s.workspace);
  const servers = await mgr.status();
  const projectFile = path.join(s.workspace, '.freecode', 'lsp.json');
  const raw = await fs.promises.readFile(projectFile, 'utf8').catch(() => null);
  const hash = raw ? createHash('sha256').update(raw).digest('hex') : '';
  const needsTrust = !!raw && (s.trustedLsp ?? {})[projectFile] !== hash;
  return {
    ok: true,
    servers,
    running: mgr.runningCount,
    disabled: s.disabledLsp ?? [],
    projectFile,
    needsTrust,
    userFile: path.join(app.getPath('userData'), 'lsp.json'),
  };
});

ipcMain.handle('lsp:toggle', async (_e: unknown, name: string) => {
  const s = loadSettings();
  const list = new Set(s.disabledLsp ?? []);
  const n = String(name ?? '');
  if (list.has(n)) list.delete(n);
  else list.add(n);
  s.disabledLsp = [...list];
  saveSettings(s);
  if (s.workspace) await ensureLsp(s.workspace);
  return { ok: true, disabled: [...list] };
});

ipcMain.handle('lsp:trust', async () => {
  const s = loadSettings();
  if (!s.workspace) return { ok: false, error: 'لا مشروع مفتوح' };
  const file = path.join(s.workspace, '.freecode', 'lsp.json');
  const raw = await fs.promises.readFile(file, 'utf8').catch(() => null);
  if (!raw) return { ok: false, error: 'لا ملف .freecode/lsp.json في المشروع' };
  const hash = createHash('sha256').update(raw).digest('hex');
  s.trustedLsp = { ...(s.trustedLsp ?? {}), [file]: hash };
  saveSettings(s);
  await ensureLsp(s.workspace);
  return { ok: true };
});

ipcMain.handle('bridge:status', () => {
  const s = loadSettings();
  const st = bridge?.status ?? { running: false, port: null, url: null, note: 'متوقف', requests: 0 };
  return { ...st, token: s.bridgeToken ?? '', auto: !!s.bridgeAuto, port_setting: s.bridgePort ?? 4177, text: describeBridge(st, s.bridgeToken ?? '') };
});

ipcMain.handle('bridge:start', async (_e: unknown, opts?: { port?: number }) => {
  const s = loadSettings();
  if (opts?.port) {
    s.bridgePort = Math.max(1024, Math.min(65535, Number(opts.port) || 4177));
    saveSettings(s);
  }
  try {
    await stopBridge();
    await startBridge();
    return { ok: true, status: bridge!.status };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle('bridge:stop', async () => {
  await stopBridge();
  return { ok: true };
});

ipcMain.handle('bridge:rotate', () => {
  const s = loadSettings();
  s.bridgeToken = newBridgeToken();
  saveSettings(s);
  const running = !!bridge;
  if (running) void stopBridge().then(() => startBridge());
  return { ok: true, token: s.bridgeToken, restarted: running };
});

ipcMain.handle('eval:tasks', () => {
  return { tasks: EVAL_TASKS.map((t) => ({ id: t.id, title: t.title, category: t.category, acceptance: t.acceptance })), total: EVAL_TASKS.length, quick: quickTasks().map((t) => t.id) };
});

ipcMain.handle('eval:models', async (_e: unknown, opts?: { models?: string[]; quick?: boolean; tasks?: string[] }) => {
  const s = loadSettings();
  const base = llmConfig(s);
  const wanted = (opts?.models?.length ? opts.models : [s.model]).filter((m): m is string => !!m);
  const models = [...new Set(wanted)].slice(0, 4); // سقف معقول: 4 موديلات × بنك المهام
  if (!models.length) return { ok: false, error: 'لا موديلات محدّدة' };

  const tasks = opts?.tasks?.length ? EVAL_TASKS.filter((t) => opts.tasks!.some((id) => t.id.startsWith(id))) : opts?.quick ? quickTasks() : EVAL_TASKS;
  send({ type: 'notice', message: `بدء تقييم ${models.length} موديل × ${tasks.length} مهمة — يعمل محلياً على بنك مهام حقيقي (بلا استهلاك صور).` });

  const reports = await evalModels(
    models.map((m): ModelTarget => ({ label: m, cfg: { ...base, model: m } })),
    {
      tasks,
      signal: abort?.signal,
      // نتائج المهام فقط (لا أسطر العناوين) حتى لا تغرق المحادثة
      onProgress: (line) => {
        if (line.includes('✅') || line.includes('❌')) send({ type: 'notice', message: line });
      },
    },
  );

  const md = formatEvalReport(reports, { tasksLabel: tasks.length === EVAL_TASKS.length ? 'البنك الكامل' : 'مجموعة مختارة' });
  // نحفظ آخر تقرير حتى يبني /models-eval share بطاقة منه بلا إعادة تشغيل
  try {
    await fs.promises.writeFile(path.join(app.getPath('userData'), 'last-eval.json'), evalReportJson(reports), 'utf8');
  } catch {
    /* البطاقة كمالية */
  }
  // سجل اللوحة: نحفظ ملخصاً رقمياً لكل جولة ليعرض /dashboard الاتجاه عبر الزمن
  const ranked = [...reports].sort((a, b) => b.passed - a.passed || a.tokens - b.tokens);
  const best = ranked[0];
  await appendEvalHistory(app.getPath('userData'), {
    at: Date.now(),
    tasks: tasks.length,
    quick: tasks.length < EVAL_TASKS.length,
    models: reports.map((r) => ({ label: r.label, passed: r.passed, total: r.total, tokens: r.tokens, stepsPerPass: r.stepsPerPass })),
    best: best && best.passed > 0 ? best.label : '',
    bestRate: best && best.total ? Math.round((best.passed / best.total) * 100) : 0,
  });
  let file = '';
  try {
    const dir = s.workspace ?? app.getPath('userData');
    file = path.join(dir, `model-eval-${new Date().toISOString().slice(0, 10)}.md`);
    await fs.promises.writeFile(file, `# تقييم الموديلات — FreeCode\n\n${md}\n`, 'utf8');
    const jsonFile = file.replace(/\.md$/, '.json');
    await fs.promises.writeFile(jsonFile, evalReportJson(reports) + '\n', 'utf8');
    file = `${file} و ${jsonFile}`;
  } catch {
    file = '';
  }
  return { ok: true, markdown: md, path: file, models: reports.map((r) => ({ label: r.label, passed: r.passed, total: r.total })) };
});

// ---------- مهام من عطل المشروع + A/B للتعليمات + بطاقة المشاركة ----------
ipcMain.handle('eval:projectTasks', async (_e: unknown, opts?: { limit?: number; dryRun?: boolean; model?: string }) => {
  const s = loadSettings();
  const ws = s.workspace;
  if (!ws) return { ok: false, error: 'افتح مجلد مشروع أولاً.' };
  const events = await Telemetry.load(path.join(app.getPath('userData'), 'telemetry.jsonl')).catch(() => []);
  const set = await projectTasksFromEvents(ws, events, { limit: opts?.limit ?? 3 });
  const preview = formatProjectTaskSet(set);
  if (!set.tasks.length || opts?.dryRun) return { ok: true, dryRun: true, count: set.tasks.length, text: preview };
  const cfg = llmConfig(s);
  const model = opts?.model || s.model;
  send({ type: 'notice', message: `أُجري تقييم على ${set.tasks.length} مهمة مستخرجة من أعطال مشروعك (${model})…` });
  const reports = await evalModels([{ label: model, cfg: { ...cfg, model } }], {
    tasks: set.tasks,
    signal: abort?.signal,
    onProgress: (line) => {
      if (line.includes('✅') || line.includes('❌')) send({ type: 'notice', message: line });
    },
  });
  const md = formatEvalReport(reports, { tasksLabel: 'مهام من عطل المشروع' });
  try {
    await fs.promises.writeFile(path.join(app.getPath('userData'), 'last-eval.json'), evalReportJson(reports), 'utf8');
  } catch {
    /* كمالي */
  }
  return { ok: true, count: set.tasks.length, markdown: md + '\n\n' + preview, preview };
});

ipcMain.handle('ab:run', async (_e: unknown, opts: { variantB?: string; mode?: 'quick' | 'all' | 'prompt'; prompt?: string; repeat?: number; variantA?: string; axis?: ContextAxis }) => {
  const s = loadSettings();
  const ws = s.workspace;
  if (!ws) return { ok: false, error: 'افتح مجلد مشروع أولاً.' };
  const cfg = llmConfig(s);
  const model = s.model;
  // محور سياق الوكيل: مفعّل في مقابل معطّل — نفس المهام ونفس التعليمات، خيار وكيل واحد يختلف
  if (opts?.axis) {
    const info = CONTEXT_AXES.find((x) => x.axis === opts.axis);
    if (!info) return { ok: false, error: 'محور غير معروف. المتاح: repoMap · autoVerify' };
    const axisTasks = opts.mode === 'all' ? EVAL_TASKS : quickTasks();
    send({ type: 'notice', message: `A/B سياق — ${info.title}: ${info.question} (${axisTasks.length} مهمة × نسختين)` });
    const rep = await runAbTest({ label: model, cfg: { ...cfg, model } }, axisTasks, {
      variants: contextVariants(opts.axis),
      repeats: Math.max(1, Math.min(3, opts.repeat ?? 1)),
      signal: abort?.signal,
      onProgress: (line) => send({ type: 'notice', message: line }),
    });
    return { ok: true, markdown: formatAbReport(rep), json: abReportJson(rep), verdict: rep.verdict };
  }
  const spec = String(opts?.variantB ?? '').trim();
  if (!spec) return { ok: false, error: 'اكتب مسار ملف النسخة الثانية (أو نص التعليمات البديل).' };

  let variantB;
  try {
    variantB = await readVariant(ws, spec);
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  let variantA;
  if (opts.variantA !== undefined) variantA = await readVariant(ws, String(opts.variantA));
  else {
    const current = await loadProjectInstructions(ws);
    variantA = current ? { label: `الحالي (${current.file})`, text: current.text } : { label: 'بلا تعليمات (الحالي)', text: null };
  }

  const mode = opts.mode ?? 'quick';
  let tasks = quickTasks();
  if (mode === 'all') tasks = EVAL_TASKS;
  if (mode === 'prompt') {
    const prompt = String(opts.prompt ?? '').trim();
    if (!prompt) return { ok: false, error: 'اكتب المهمة المطلوبة لمقارنة التعليمات عليها.' };
    const t = await taskFromPrompt(ws, prompt);
    if ('error' in t) return { ok: false, error: t.error };
    tasks = [t];
  }

  send({ type: 'notice', message: `A/B: ${tasks.length} مهمة × نسختين × ${Math.max(1, Math.min(3, opts.repeat ?? 1))} تكرار — قد يستغرق دقائق.` });
  const report = await runAbTest({ label: model, cfg: { ...cfg, model } }, tasks, {
    variants: [variantA, variantB],
    repeats: opts.repeat ?? 1,
    signal: abort?.signal,
    onProgress: (line) => send({ type: 'notice', message: line }),
  });
  return { ok: true, markdown: formatAbReport(report), json: abReportJson(report), verdict: report.verdict };
});

ipcMain.handle('eval:shareCard', async () => {
  const s = loadSettings();
  const userData = app.getPath('userData');
  let reports;
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(userData, 'last-eval.json'), 'utf8'));
    reports = raw?.reports ?? raw?.ranked ?? [];
  } catch {
    return { ok: false, error: 'لا يوجد تقييم محفوظ — شغّل /models-eval أولاً.' };
  }
  if (!reports.length) return { ok: false, error: 'لا يوجد تقييم محفوظ — شغّل /models-eval أولاً.' };
  const dir = s.workspace ? path.join(s.workspace, '.freecode') : userData;
  const res = await writeShareCard(dir, reports, { project: s.workspace ?? undefined, version: app.getVersion(), tasksLabel: `${reports[0]?.outcomes?.length ?? 0} مهمة` });
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, html: res.html, svg: res.svg, png: res.png };
});

// ---------- لوحة القياس (الموثوقية + تقييم الموديلات) ----------
ipcMain.handle('metrics:dashboard', async (_e: unknown, opts?: { limit?: number }) => {
  await ensureTelemetryLoaded();
  const events = telemetryFor().events;
  const userData = app.getPath('userData');
  const history = await readEvalHistory(userData, Math.max(1, Math.min(50, opts?.limit ?? 20)));
  const ws = loadSettings().workspace;
  const sweeps = ws ? await readSweepArchive(ws) : [];
  const data = buildDashboard({ events, history, sweeps });
  return {
    ok: true,
    markdown: formatDashboard(data, { workspace: loadSettings().workspace ?? undefined }),
    line: dashboardLine(data),
    json: dashboardJson(data),
    historyCount: history.length,
    turns: data.reliability.turns,
  };
});

ipcMain.handle('metrics:badge', async () => {
  const st = loadSettings();
  const userData = app.getPath('userData');
  const history = await readEvalHistory(userData, 20);
  const last = history[history.length - 1];
  if (!last) return { ok: false, error: 'لا توجد جولة تقييم محفوظة بعد — شغّل /eval ثم أعد المحاولة.' };
  const ws = st.workspace;
  const dir = ws ? path.join(ws, '.freecode') : userData;
  const project = ws ? path.basename(ws) : '';
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const stamp = new Date(last.at).toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const png = path.join(dir, `last-round-badge-${stamp}.png`);
    await fs.promises.writeFile(png, historyBadgePng(last, { project, version: app.getVersion() }));
    return {
      ok: true,
      png,
      project: project || 'مشروعك',
      best: last.best,
      bestRate: Math.round(last.bestRate * 100),
      at: last.at,
      models: last.models.length,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// «جرد الآن»: يشغّل جرد محاور السياق على مساحة المشروع من داخل التطبيق،
// ويبلّغ بإشعار نظام فقط عند انحدار حقيقي (بلا ضجيج).
ipcMain.handle('metrics:sweep-now', async () => {
  const st = loadSettings();
  const ws = String(st.workspace ?? '').trim();
  if (!ws) return { ok: false, error: 'افتح مجلد مشروع من التطبيق أولاً (المساحة) ثم أعد المحاولة.' };
  const cfgFile = sweepConfigPath(ws);
  let created = false;
  if (!fs.existsSync(cfgFile)) {
    const model = String(st.model ?? '').trim();
    if (!model) return { ok: false, error: 'لا موديل محدد في الإعدادات — اختر موديلاً ثم أعد المحاولة.' };
    const cfg = { models: [model], baseUrl: st.baseUrl, axes: ['repoMap', 'autoVerify', 'budget', 'memory'], tasks: 'quick', repeat: 1, verifyCommand: '' };
    try {
      await fs.promises.mkdir(path.dirname(cfgFile), { recursive: true });
      await fs.promises.writeFile(cfgFile, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      created = true;
      send({ type: 'notice', message: `أُنشئ إعداد جرد جديد (${path.relative(ws, cfgFile)} أو .freecode/sweep.json) بموديلك الحالي — عدّله متى شئت.` });
    } catch (e: any) {
      return { ok: false, error: `تعذّر إنشاء إعداد الجرد: ${String(e?.message ?? e)}` };
    }
  }
  const cli = path.join(app.getAppPath(), 'dist', 'main', 'evalcli.js');
  if (!fs.existsSync(cli)) return { ok: false, error: 'ملف الجرد (dist/main/evalcli.js) غير موجود — شغّل npm run build أولاً.' };
  const args = [cli, '--ctx-sweep', '--config', cfgFile, '--save', '--compare'];
  const verifyCmd = String(st.verifyCommand ?? '').trim();
  if (verifyCmd) args.push('--verify-cmd', verifyCmd);
  send({ type: 'notice', message: '🔁 جرد الآن: يشغّل الجرد على مساحة المشروع… (قد يستغرق دقائق على موديلاتك)' });
  const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ws, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    let out = '';
    const cap = (d: Buffer): void => {
      out += String(d);
      if (out.length > 80_000) out = out.slice(-80_000);
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    child.on('error', (e) => resolve({ code: -1, out: `${out}\n${String((e as any)?.message ?? e)}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
  const archived = await readSweepArchive(ws);
  const last = archived[archived.length - 1] ?? null;
  if (res.code !== 0 || !last) {
    return { ok: false, error: `فشل الجرد (رمز ${res.code ?? '؟'}):\n${res.out.trim().slice(-700)}` };
  }
  const digest = sweepDigest(archived.length > 1 ? archived[archived.length - 2] : null, last);
  const tl = sweepTimeline(archived);
  const notice = sweepRunNotice(digest);
  if (notice.notify && Notification.isSupported()) {
    new Notification({ title: notice.title, body: notice.body }).show();
  }
  return {
    ok: true,
    created,
    configPath: cfgFile,
    digestLine: digest.line,
    regressions: digest.regressions,
    improvements: digest.improvements,
    notified: notice.notify,
    runs: archived.length,
    seriesRuns: tl?.runs ?? 0,
    seriesRegressions: tl?.events.length ?? 0,
    output: res.out.trim().slice(-1200),
  };
});

ipcMain.handle('metrics:export', async () => {
  await ensureTelemetryLoaded();
  const events = telemetryFor().events;
  const userData = app.getPath('userData');
  const history = await readEvalHistory(userData, 20);
  const ws = loadSettings().workspace;
  const sweeps = ws ? await readSweepArchive(ws) : [];
  const data = buildDashboard({ events, history, sweeps });
  const dir = ws ? path.join(ws, '.freecode') : userData;
  const stamp = new Date().toISOString().slice(0, 10);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const md = path.join(dir, `dashboard-${stamp}.md`);
    const js = path.join(dir, `dashboard-${stamp}.json`);
    await fs.promises.writeFile(md, `# لوحة القياس — FreeCode\n\n${formatDashboard(data, { workspace: ws ?? undefined })}\n`, 'utf8');
    await fs.promises.writeFile(js, dashboardJson(data) + '\n', 'utf8');
    return { ok: true, md, js };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

// ---------- سوق الإضافات: مراجعة ثم تثبيت صريح ----------
let pendingReview: PluginReview | null = null;

ipcMain.handle('plugins:installed', async () => {
  const list = await listInstalled(app.getPath('userData'));
  return { ok: true, list, text: formatInstalled(list) };
});

ipcMain.handle('plugins:review', async (_e: unknown, raw: string, opts?: { deep?: boolean; model2?: string; model3?: string }) => {
  const st = loadSettings();
  const ws = st.workspace ?? '';
  const review = await reviewInstall(String(raw ?? ''), app.getPath('userData'));
  pendingReview = review.ok ? review : null;
  const installed = await listInstalled(app.getPath('userData'));
  // مراجعة دلالية بموديل ثانٍ (اختيارية، `--deep`): تشرح ما تفعله الإضافة فعلاً وتنبّه
  // على ما يستحق وقفة — وهي **معلومات لا إذن**: فشلها لا يمنع التثبيت ولا يُخفي المراجعة الآلية.
  let audit = '';
  if (review.ok && opts?.deep) {
    try {
      const bundle = await collectAuditBundle(review.staging);
      const cfg = llmConfig(st);
      send({ type: 'notice', message: `أطلب مراجعة ذكية من «${st.model}» على ${bundle.files} ملفاً نصياً (${bundle.chars} حرفاً) — بلا تنفيذ أي شيء…` });
      const second = String(opts?.model2 ?? st.auditModel ?? '').trim();
      if (second && second !== st.model) {
        send({ type: 'notice', message: `مراجعة بموديلين متقاطعَين: «${st.model}» و«${second}» — نفس النص، حكمان مستقلان، والأشد تحفظاً يفوز…` });
        const cross = await crossModelAudit([{ ...cfg, model: st.model }, { ...cfg, model: second }], bundle, abort?.signal);
        audit = formatCrossAuditSection(cross);
        // عند تعارض الحكمين: موديل ثالث محايد يفسّر مصدر الخلاف (اختياري، وغير الاثنين)
        const third = String(opts?.model3 ?? st.auditModel3 ?? '').trim();
        if (cross.disagreement) {
          if (third && third !== st.model && third !== second) {
            send({ type: 'notice', message: `الحكمان مختلفان — أطلب تفسير الخلاف من موديل محايد ثالث «${third}»…` });
            const ex = await explainDisagreement({ ...cfg, model: third }, cross, bundle, abort?.signal);
            audit += `\n\n${formatDisagreementSection(ex, third, cross.disagreement, cross)}`;
          } else {
            audit += `\n\n> ⚠️ الحكمان مختلفان (${cross.disagreement}) — أضف \`--model3=<موديل>\` أو اضبط «موديل ثالث» في الإعدادات ليشرح موديل محايد مصدر الخلاف.`;
          }
        }
      } else {
        const res = await semanticAudit({ ...cfg, model: st.model }, bundle, abort?.signal);
        audit = formatAuditSection(res, st.model);
      }
    } catch (e: any) {
      audit = formatAuditSection({ ok: false, text: '', error: String(e?.message ?? e).slice(0, 160), ms: 0 }, st.model);
    }
  }
  return {
    ok: review.ok,
    error: review.error ?? '',
    audit,
    text: formatReview(review) + (audit ? `\n\n${audit}` : ''),
    slug: review.slug,
    risk: review.risk,
    willOverwrite: !!review.installedHash,
    requiresForce: !!review.installedHash && review.installedHash !== review.hash,
    installed,
    plugins: ws ? await loadPlugins(ws) : [],
  };
});

ipcMain.handle('plugins:apply', async (_e: unknown, raw: string, opts?: { force?: boolean }) => {
  const src = String(raw ?? '');
  if (!pendingReview || pendingReview.source.raw !== src) {
    // لم يمرّ بمراجعة في هذه الجلسة (أو تغيّر المصدر): نراجع الآن ثم نثبّت
    const fresh = await reviewInstall(src, app.getPath('userData'));
    if (!fresh.ok) return { ok: false, error: fresh.error ?? 'تعذّرت المراجعة' };
    pendingReview = fresh;
  }
  const res = await applyInstall(pendingReview, app.getPath('userData'), { force: opts?.force === true });
  const review = pendingReview;
  if (res.ok) {
    pendingReview = null;
    const ws = loadSettings().workspace ?? '';
    await ensureMcp(ws, true).catch(() => {});
    const after = await listInstalled(app.getPath('userData'));
    return {
      ok: true,
      dir: res.dir,
      backup: res.backup,
      text: `ثُبّتت الإضافة «${review.slug}»${review.version ? ` (${review.version})` : ''} في:\n\`${res.dir}\`\n\nالمهارات والقواعد تُقرأ مباشرة، وخوادم MCP تُحدَّث الآن. إن كان فيها hooks فستعمل حسب قواعد المشروع (وتسألك الموافقة عند اللزوم).${res.backup ? `\n\nحُفظت نسخة سابقة في: ${res.backup}` : ''}`,
      installed: after,
    };
  }
  if (String(res.error ?? '').includes('--force')) {
    return { ok: false, error: String(res.error), needForce: true };
  }
  return { ok: false, error: res.error ?? 'تعذّر التثبيت' };
});

ipcMain.handle('plugins:cancel', async () => {
  if (pendingReview) {
    await discardReview(pendingReview);
    pendingReview = null;
    return { ok: true };
  }
  return { ok: false, error: 'لا مراجعة معلّقة.' };
});

ipcMain.handle('plugins:update', async (_e: unknown, slug: string, opts?: { apply?: boolean }) => {
  const userData = app.getPath('userData');
  const found = await reviewUpdate(String(slug ?? ''), userData);
  if ('ok' in found && found.ok === false) return { ok: false, error: String((found as any).error) };
  const review = found as PluginReview;
  pendingReview = review;
  const changed = review.changes.some((c) => c.includes('تغيّر'));
  if (!opts?.apply) {
    return { ok: true, changed, text: formatReview(review), slug: review.slug, risk: review.risk };
  }
  const res = await applyInstall(review, userData, { force: true });
  if (!res.ok) return { ok: false, error: res.error };
  pendingReview = null;
  const ws = loadSettings().workspace ?? '';
  await ensureMcp(ws, true).catch(() => {});
  const after = await listInstalled(userData);
  return { ok: true, changed, text: changed ? `حُدّثت الإضافة «${review.slug}»${review.version ? ` إلى ${review.version}` : ''}.` : `لا تغيير في «${review.slug}» (نفس بصمة المحتوى).`, installed: after, backup: res.backup };
});

ipcMain.handle('plugins:remove', async (_e: unknown, slug: string) => {
  const res = await removeInstall(String(slug ?? ''), app.getPath('userData'));
  const ws = loadSettings().workspace ?? '';
  await ensureMcp(ws, true).catch(() => {});
  const after = await listInstalled(app.getPath('userData'));
  return res.ok ? { ok: true, text: `أُزيلت «${String(slug)}» (نُقلت إلى سلة داخل مجلد الإضافات: ${res.trashed}).`, installed: after } : { ok: false, error: res.error, installed: after };
});

ipcMain.handle('telemetry:summary', async () => {
  await ensureTelemetryLoaded();
  const events = telemetryFor().events;
  const summary = summarizeTelemetry(events);
  return { summary, text: formatReliability(summary), count: events.length, fails: recentFailures(events, 20).length };
});

ipcMain.handle('telemetry:failures', async (_e: unknown, opts?: { asTask?: boolean }) => {
  await ensureTelemetryLoaded();
  const events = telemetryFor().events;
  const items = recentFailures(events, 20);
  const root = loadSettings().workspace ?? '';
  const text = items
    .map((x) => (x.kind === 'tool_error' ? `• [أداة ${String(x.name)}] ${String(x.message ?? '').slice(0, 200)}` : x.kind === 'verify' ? `• [تحقق فاشل] ${String(x.command ?? '')} — ${String(x.summary ?? '').slice(0, 160)}` : `• [دورة فاشلة] ${String(x.error ?? x.outcome ?? '')}`))
    .join('\n');
  return { count: items.length, text: text || 'لا أعطال مسجّلة.', task: opts?.asTask ? failuresToTask(events, root) : '' };
});

ipcMain.handle('telemetry:clear', async () => {
  await telemetryFor().clear();
  telemetryLoaded = true;
  return { ok: true };
});

ipcMain.handle('plugins:list', async () => {
  const s = loadSettings();
  const ws = s.workspace ?? '';
  const plugins = ws ? await loadPlugins(ws) : [];
  return {
    plugins: plugins.map((p) => ({
      slug: p.slug,
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      source: p.source,
      status: describePlugin(p),
      needsTrust: p.needsTrust,
      disabled: !!p.disabled,
      error: p.error,
      counts: {
        skills: p.skillDirs.length,
        hooks: p.hooks.PreToolUse.length + p.hooks.PostToolUse.length,
        rules: p.permissions.allow.length + p.permissions.ask.length + p.permissions.deny.length,
        mcp: Object.keys(p.mcp).length,
      },
      dir: p.dir,
    })),
    dir: path.join(app.getPath('userData'), 'plugins'),
  };
});

ipcMain.handle('plugins:scaffold', async (_e: unknown, name: string) => scaffoldPlugin(app.getPath('userData'), String(name ?? '')));

ipcMain.handle('plugins:trust', async (_e: unknown, slugOrDir: string) => {
  const s = loadSettings();
  const ws = s.workspace ?? '';
  const plugins = await loadPlugins(ws);
  const p = plugins.find((x) => x.slug === String(slugOrDir) || x.dir === String(slugOrDir));
  if (!p) return { ok: false, error: 'إضافة غير معروفة' };
  s.trustedPlugins = { ...(s.trustedPlugins ?? {}), [p.dir]: p.hash };
  s.disabledPlugins = (s.disabledPlugins ?? []).filter((x) => x !== p.slug && x !== p.dir);
  saveSettings(s);
  await ensureMcp(ws, true).catch(() => {});
  return { ok: true, hash: p.hash };
});

ipcMain.handle('plugins:toggle', async (_e: unknown, slugOrDir: string) => {
  const s = loadSettings();
  const ws = s.workspace ?? '';
  const plugins = await loadPlugins(ws);
  const p = plugins.find((x) => x.slug === String(slugOrDir) || x.dir === String(slugOrDir));
  if (!p) return { ok: false, error: 'إضافة غير معروفة' };
  const list = new Set(s.disabledPlugins ?? []);
  const nowDisabled = !p.disabled;
  if (nowDisabled) list.add(p.slug);
  else list.delete(p.slug);
  s.disabledPlugins = [...list];
  saveSettings(s);
  await ensureMcp(ws, true).catch(() => {});
  return { ok: true, disabled: nowDisabled };
});

ipcMain.handle('agents:list', async () => {
  const s = loadSettings();
  if (!s.workspace) return { agents: [], git: false, error: 'لا مشروع مفتوح', max: MAX_PARALLEL };
  const p = makePool(llmConfig(s), s.workspace, s);
  const usable = await canUseWorktrees(s.workspace);
  return { agents: poolList(), git: usable.ok, error: usable.error ?? '', max: MAX_PARALLEL, running: p.running.length };
});

ipcMain.handle('agents:start', async (_e: unknown, raw: unknown) => {
  const s = loadSettings();
  if (!s.workspace) return { ok: false, error: 'لا مشروع مفتوح' };
  const tasks = (Array.isArray(raw) ? raw : [])
    .map((t: any) => ({ label: String(t?.label ?? 'وكيل').slice(0, 60), task: String(t?.task ?? '').trim() }))
    .filter((t) => t.task);
  if (!tasks.length) return { ok: false, error: 'اكتب مهمةً واحدة على الأقل' };
  const usable = await canUseWorktrees(s.workspace);
  if (!usable.ok) return { ok: false, error: usable.error };
  const p = makePool(llmConfig(s), s.workspace, s);
  void p.run(tasks);
  return { ok: true, count: Math.min(tasks.length, MAX_PARALLEL) };
});

ipcMain.handle('agents:stop', (_e: unknown, id: string) => {
  const ok = pool?.stop(String(id)) ?? false;
  return { ok, message: ok ? 'أُوقف الوكيل' : 'الوكيل لا يعمل الآن' };
});

ipcMain.handle('agents:merge', async (_e: unknown, id: string, squash?: boolean) => {
  if (!pool) return { ok: false, message: 'لا وكلاء', conflicts: [] };
  const r = await pool.merge(String(id), !!squash);
  send({ type: 'agents', list: poolList() });
  return r;
});

ipcMain.handle('agents:discard', async (_e: unknown, id: string) => {
  if (!pool) return { ok: false, message: 'لا وكلاء' };
  const r = await pool.discard(String(id));
  send({ type: 'agents', list: poolList() });
  return r;
});

ipcMain.handle('agents:diff', async (_e: unknown, id: string) => {
  const text = (await pool?.diff(String(id))) ?? '';
  return { text: text.slice(0, 200_000) };
});

ipcMain.handle('agents:clear', async () => {
  const n = (await pool?.clearFinished()) ?? 0;
  send({ type: 'agents', list: poolList() });
  return { ok: true, message: n ? `أُزيلت ${n} بطاقة منتهية` : 'لا بطاقات منتهية' };
});

ipcMain.handle('processes:list', () => listManagedProcesses().map((p) => ({ id: p.id, command: p.command, pid: p.pid ?? null, running: p.code === null, startedAt: p.startedAt })));

ipcMain.handle('processes:stop', (_e: unknown, id: string) => stopManagedProcess(String(id ?? '')));

// ---------- IPC: المهارات ----------

ipcMain.handle('skills:list', async () => {
  const ws = loadSettings().workspace;
  if (!ws) return { skills: [], projectDir: null, userDir: path.join(app.getPath('userData'), 'skills') };
  const skills = await discoverSkills(ws, app.getPath('userData')).catch(() => []);
  return {
    skills: skills.map((k) => ({ name: k.name, description: k.description, source: k.source, file: k.file })),
    projectDir: path.join(ws, '.freecode', 'skills'),
    userDir: path.join(app.getPath('userData'), 'skills'),
  };
});

/** ينشئ مجلد مهارة جديدة بقالب جاهز (لتسهيل البدء) */
ipcMain.handle('skills:scaffold', async (_e: unknown, name: string) => {
  const ws = loadSettings().workspace;
  if (!ws) return { ok: false, error: 'لا يوجد مشروع مفتوح.' };
  const clean = String(name ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(clean)) return { ok: false, error: 'اسم غير صالح: حروف إنجليزية صغيرة وأرقام وشرطات فقط.' };
  const dir = path.join(ws, '.freecode', 'skills', clean);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) return { ok: false, error: 'المهارة موجودة بالفعل.' };
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(file, SKILL_TEMPLATE.replace('my-skill', clean), 'utf8');
  return { ok: true, file };
});

/** نص مهارة للاستدعاء الصريح من الواجهة */
ipcMain.handle('skills:body', async (_e: unknown, name: string) => {
  const ws = loadSettings().workspace;
  if (!ws) return null;
  const skills = await discoverSkills(ws, app.getPath('userData')).catch(() => []);
  const skill = skills.find((k) => k.name === String(name ?? '').trim().toLowerCase());
  if (!skill) return null;
  return { name: skill.name, text: skillInvocation(skill, '') };
});
