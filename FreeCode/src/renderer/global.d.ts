interface Settings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  workspace: string | null;
  recent: string[];
  mode: 'plan' | 'act';
  autoApproveEdits: boolean;
  autoApproveCommands: boolean;
  tokenBudget: number;
  autoVerify: boolean;
  verifyCommand: string;
  repoMap: boolean;
  autoCommit: boolean;
  searchProvider: 'auto' | 'tavily' | 'brave' | 'serper' | 'duckduckgo';
  hasSearchKey: boolean;
  endpoint: string;
}

interface DiffLine {
  t: ' ' | '+' | '-';
  text: string;
  oldNo?: number;
  newNo?: number;
}
interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
interface DiffData {
  added: number;
  removed: number;
  hunks: Hunk[];
  truncated: boolean;
}
type Preview =
  | { kind: 'diff'; path: string; isNew: boolean; diff: DiffData }
  | { kind: 'command'; command: string; dangerous: boolean }
  | { kind: 'generic'; text: string };

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}
interface ChangedFile {
  path: string;
  created: boolean;
}
interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
  turns: number;
}
interface TreeEntry {
  name: string;
  path: string;
  isDir: boolean;
}
interface McpStatus {
  name: string;
  ok: boolean;
  toolCount: number;
  error?: string;
  source: string;
}
interface McpInfo {
  servers: McpStatus[];
  userConfigPath: string;
  projectConfigPath: string | null;
}
interface RulesInfo {
  userPath: string;
  projectPath: string;
  projectPresent: boolean;
  projectSensitive: boolean;
  projectTrusted: boolean;
  needsTrust: boolean;
  projectSummary: string[];
  errors: string[];
}
interface CustomCommand {
  name: string;
  desc: string;
  prompt: string;
}
type RenderItem =
  | { type: 'user'; text: string; attachments: string[]; images?: string[] }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; id: string; name: string; args: unknown; result?: string; isError?: boolean };

type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: any }
  | { type: 'tool_output'; id: string; chunk: string }
  | { type: 'tool_result'; id: string; name: string; result: string; isError: boolean }
  | { type: 'approval'; id: string; name: string; args: any; preview: Preview | null; rule?: string | null }
  | { type: 'todos'; todos: TodoItem[] }
  | { type: 'usage'; tokens: number; budget: number; saved: number }
  | { type: 'changes'; changes: ChangedFile[]; undoDepth: number }
  | { type: 'notice'; message: string }
  | { type: 'sessions_changed' }
  | { type: 'agents'; list: ParallelAgentView[] }
  | { type: 'agent_log'; id: string; chunk: string }
  | { type: 'bridge'; status: { running: boolean; port: number | null; url: string | null; token: string } | null }
  | { type: 'done'; aborted?: boolean }
  | { type: 'error'; message: string };

interface ReliabilitySummary {
  turns: number;
  okTurns: number;
  failedTurns: number;
  incompleteTurns: number;
  steps: number;
  tokens: number;
  tokensPerTurn: number;
  edits: number;
  exactEdits: number;
  fuzzyEdits: number;
  verifyRuns: number;
  verifyFailed: number;
  approvalsAsked: number;
  approvalsDenied: number;
  approvalsBulk: number;
  toolErrors: number;
  topErrors: { name: string; count: number }[];
  retries: number;
  p50TurnMs: number;
  p95TurnMs: number;
  from: number;
  to: number;
}

interface InstalledPluginView {
  slug: string;
  source: string;
  installedAt: number;
  version: string;
  description: string;
  files: number;
  risk: string;
  hash: string;
}

interface PluginView {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  source: 'project' | 'user';
  status: string;
  needsTrust: boolean;
  disabled: boolean;
  error?: string;
  counts: { skills: number; hooks: number; rules: number; mcp: number };
  dir: string;
}

interface ParallelAgentView {
  id: string;
  label: string;
  task: string;
  branch: string;
  dir: string;
  base: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | 'merged' | 'discarded';
  statusText: string;
  startedAt: number;
  endedAt?: number;
  toolCalls: number;
  tokens: number;
  files: { path: string; add: number; del: number }[];
  summary: string;
  error?: string;
  denied: string[];
}

interface Window {
  api: {
    getSettings(): Promise<Settings>;
    setSettings(
      patch: Partial<Omit<Settings, 'hasKey' | 'recent' | 'endpoint' | 'workspace' | 'hasSearchKey'>> & {
        apiKey?: string;
        clearKey?: boolean;
        searchApiKey?: string;
        clearSearchKey?: boolean;
      },
    ): Promise<Settings>;
    pickWorkspace(): Promise<Settings | null>;
    setWorkspace(dir: string): Promise<Settings | null>;
    listTree(rel: string): Promise<TreeEntry[]>;
    readFile(rel: string): Promise<{ ok: boolean; text?: string; truncated?: boolean; binary?: boolean; error?: string }>;
    searchFiles(q: string): Promise<string[]>;
    listModels(): Promise<{ ok: boolean; models?: string[]; error?: string }>;
    openExternal(url: string): Promise<void>;
    listSessions(): Promise<{ sessions: SessionSummary[]; currentId: string | null }>;
    newSession(): Promise<boolean>;
    loadSession(id: string): Promise<{ items: RenderItem[]; todos: TodoItem[]; settings: Settings } | null>;
    deleteSession(id: string): Promise<boolean>;
    send(text: string, images?: string[]): Promise<void>;
    abort(): Promise<void>;
    undo(): Promise<{ restored: ChangedFile[] }>;
    compact(): Promise<{ summarized: number }>;
    listCommands(): Promise<CustomCommand[]>;
    mcpStatus(): Promise<McpInfo>;
    mcpReload(): Promise<McpInfo>;
    respondApproval(id: string, ok: boolean, scope?: 'once' | 'turn' | 'file'): Promise<void>;
    getRules(): Promise<{ userText: string; userExists: boolean; userPath: string; info: RulesInfo | null }>;
    saveRules(text: string): Promise<{ ok: boolean; error?: string }>;
    trustRules(): Promise<RulesInfo | null>;
    allowRule(rule: string): Promise<boolean>;
    addMemory(note: string): Promise<{ ok: boolean; error?: string }>;
    readMemory(): Promise<{ text: string; path: string }>;
    sessionStats(): Promise<{ ok: boolean; messages?: number; user?: number; assistant?: number; toolCalls?: number; images?: number; tokens?: number; tokensNow?: number; budget?: number; durationMs?: number; tools?: { name: string; count: number }[]; title?: string; model?: string; error?: string }>;
    exportSession(format?: 'md' | 'json'): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>;
    sandboxStatus(): Promise<{ settings: { mode: string; image: string; network: boolean; extraArgs: string }; engines: Record<string, { available: boolean; version?: string; reason?: string }>; text: string }>;
    sandboxSet(patch: Record<string, unknown>): Promise<{ ok: boolean; text: string }>;
    lspStatus(): Promise<{ ok: boolean; servers: { name: string; available: boolean; running: boolean; extensions: string[]; reason?: string }[]; running?: number; disabled?: string[]; error?: string; projectFile?: string; needsTrust?: boolean; userFile?: string }>;
    lspToggle(name: string): Promise<{ ok: boolean; disabled: string[] }>;
    lspTrust(): Promise<{ ok: boolean; error?: string }>;
    bridgeStatus(): Promise<{ running: boolean; port: number | null; url: string | null; note: string; requests: number; token: string; auto: boolean; port_setting: number; text: string }>;
    bridgeStart(opts?: { port?: number }): Promise<{ ok: boolean; status?: unknown; error?: string }>;
    bridgeStop(): Promise<{ ok: boolean; error?: string }>;
    bridgeRotate(): Promise<{ ok: boolean; token: string; restarted: boolean }>;
    telemetrySummary(): Promise<{ summary: ReliabilitySummary; text: string; count: number; fails: number }>;
    telemetryFailures(opts?: { asTask?: boolean }): Promise<{ count: number; text: string; task: string }>;
    telemetryClear(): Promise<{ ok: boolean }>;
    metricsDashboard(opts?: { limit?: number }): Promise<{ ok: boolean; markdown: string; line: string; json: string; historyCount: number; turns: number }>;
    metricsExport(): Promise<{ ok: boolean; md?: string; js?: string; error?: string }>;
    metricsSweepNow(): Promise<{ ok: boolean; error?: string; created?: boolean; configPath?: string; digestLine?: string; regressions?: number; improvements?: number; notified?: boolean; runs?: number; seriesRuns?: number; seriesRegressions?: number; output?: string }>;
    metricsBadge(): Promise<{ ok: boolean; png?: string; project?: string; best?: string; bestRate?: number; at?: number; models?: number; error?: string }>;
    pluginsInstalled(): Promise<{ ok: boolean; list: InstalledPluginView[]; text: string }>;
    pluginsReview(raw: string, opts?: { deep?: boolean; model2?: string; model3?: string }): Promise<{ ok: boolean; error: string; text: string; audit?: string; slug: string; risk: string; willOverwrite: boolean; requiresForce: boolean; installed: InstalledPluginView[]; plugins: PluginView[] }>;
    evalProjectTasks(opts?: { limit?: number; dryRun?: boolean; model?: string }): Promise<{ ok: boolean; error?: string; dryRun?: boolean; count: number; text: string; markdown?: string; preview?: string }>;
    abRun(opts: { variantB?: string; mode?: 'quick' | 'all' | 'prompt'; prompt?: string; repeat?: number; variantA?: string; axis?: 'repoMap' | 'autoVerify' | 'budget' | 'memory' }): Promise<{ ok: boolean; error?: string; markdown?: string; json?: string; verdict?: string }>;
    evalShareCard(): Promise<{ ok: boolean; error?: string; html?: string; svg?: string; png?: string }>;
    pluginsApply(raw: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string; dir?: string; backup?: string; text?: string; needForce?: boolean; installed?: InstalledPluginView[] }>;
    pluginsCancel(): Promise<{ ok: boolean; error?: string }>;
    pluginsUpdate(slug: string, opts?: { apply?: boolean }): Promise<{ ok: boolean; error?: string; changed?: boolean; text?: string; slug?: string; risk?: string; installed?: InstalledPluginView[]; backup?: string }>;
    pluginsRemove(slug: string): Promise<{ ok: boolean; error?: string; text?: string; installed?: InstalledPluginView[] }>;
    evalTasks(): Promise<{ tasks: { id: string; title: string; category: string; acceptance: string[] }[]; total: number; quick: string[] }>;
    evalModels(opts?: { models?: string[]; quick?: boolean; tasks?: string[] }): Promise<{ ok: boolean; error?: string; markdown?: string; path?: string; models?: { label: string; passed: number; total: number }[] }>;
    telemetrySummary(): Promise<{ summary: import('./global').ReliabilitySummary; text: string; count: number; fails: number }>;
    telemetryFailures(opts?: { asTask?: boolean }): Promise<{ count: number; text: string; task: string }>;
    telemetryClear(): Promise<{ ok: boolean }>;
    evalTasks(): Promise<{ tasks: { id: string; title: string; category: string; acceptance: string[] }[]; total: number; quick: string[] }>;
    evalModels(opts?: { models?: string[]; quick?: boolean; tasks?: string[] }): Promise<{ ok: boolean; error?: string; markdown?: string; path?: string; models?: { label: string; passed: number; total: number }[] }>;
    securityScan(opts?: { deps?: boolean; only?: string[] }): Promise<{ ok: boolean; text: string; findings: { severity: 'high' | 'medium' | 'low'; title: string; file?: string; line?: number; detail?: string; fix: string }[]; counts: { high: number; medium: number; low: number }; error?: string }>;
    listPlugins(): Promise<{ plugins: PluginView[]; dir: string }>;
    scaffoldPlugin(name: string): Promise<{ ok: boolean; dir?: string; error?: string }>;
    trustPlugin(slug: string): Promise<{ ok: boolean; error?: string; hash?: string }>;
    togglePlugin(slug: string): Promise<{ ok: boolean; error?: string; disabled?: boolean }>;
    listAgents(): Promise<{ agents: ParallelAgentView[]; git: boolean; error?: string; max: number; running?: number }>;
    startAgents(tasks: { label: string; task: string }[]): Promise<{ ok: boolean; error?: string; count?: number }>;
    stopAgent(id: string): Promise<{ ok: boolean; message: string }>;
    mergeAgent(id: string, squash?: boolean): Promise<{ ok: boolean; message: string; conflicts: string[] }>;
    discardAgent(id: string): Promise<{ ok: boolean; message: string }>;
    agentDiff(id: string): Promise<{ text: string }>;
    clearAgents(): Promise<{ ok: boolean; message: string }>;
    listProcesses(): Promise<{ id: string; command: string; pid: number | null; running: boolean; startedAt: number }[]>;
    stopProcess(id: string): Promise<boolean>;
    listSkills(): Promise<{ skills: { name: string; description: string; source: 'project' | 'user'; file: string }[]; projectDir: string | null; userDir: string }>;
    scaffoldSkill(name: string): Promise<{ ok: boolean; error?: string; file?: string }>;
    skillBody(name: string): Promise<{ name: string; text: string } | null>;
    onEvent(cb: (e: AgentEvent) => void): () => void;
  }

}
