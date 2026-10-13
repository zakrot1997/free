// قواعد الصلاحيات والـ Hooks.
//
// الملفات: <userData>/rules.json (قواعدك أنت) و <المشروع>/.freecode/rules.json (قواعد المشروع).
// {
//   "permissions": {
//     "allow": ["run_command(npm test:*)", "run_command(git status)", "write_file|edit_file(src/**)"],
//     "ask":   ["run_command(git push:*)"],
//     "deny":  ["read_file(.env*)", "write_file|edit_file(.env*)", "run_command(rm:*)"]
//   },
//   "hooks": {
//     "PreToolUse":  [{ "matcher": "write_file|edit_file", "command": "node scripts/guard.js" }],
//     "PostToolUse": [{ "matcher": "write_file|edit_file", "paths": ["**/*.ts"], "command": "npx prettier --write \"$FREECODE_FILE\"" }]
//   }
// }
//
// الأولوية: deny ثم ask ثم allow ثم السلوك الافتراضي (الإعدادات العامة).
// قواعد المشروع: deny و ask تعمل دائماً (تزيد الحماية فقط)، أما allow والـ hooks فلا تعمل إلا بعد أن تثق بالملف.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { globToRegExp } from './tools';
import { runShell } from './shell';

export interface Permissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface HookDef {
  /** تعبير نمطي على اسم الأداة (مثل "write_file|edit_file")؛ فارغ أو * = كل الأدوات */
  matcher?: string;
  /** أنماط glob لمسار الملف (للأدوات التي تعمل على ملفات فقط) */
  paths?: string[];
  command: string;
  /** بالثواني (الافتراضي 30) */
  timeout?: number;
  /** PostToolUse: أضف مخرجات الـ hook لنتيجة الأداة حتى عند النجاح */
  feedback?: boolean;
}

export type HookPhase = 'PreToolUse' | 'PostToolUse';

export interface RulesConfig {
  permissions: Permissions;
  hooks: Record<HookPhase, HookDef[]>;
}

export const emptyRules = (): RulesConfig => ({
  permissions: { allow: [], ask: [], deny: [] },
  hooks: { PreToolUse: [], PostToolUse: [] },
});

// ---------- قراءة وتحقق ----------

const RULE_RE = /^([\w*|-]+)(?:\(([\s\S]*)\))?$/;

export function parseRuleString(rule: string): { tools: RegExp; toolText: string; pattern?: string } | null {
  const m = RULE_RE.exec(rule.trim());
  if (!m) return null;
  const alts = m[1].split('|').filter(Boolean);
  if (!alts.length) return null;
  const tools = new RegExp(`^(?:${alts.map((a) => a.replace(/[.+^${}()[\]\\]/g, '\\$&').replace(/\*/g, '.*')).join('|')})$`);
  return { tools, toolText: m[1], pattern: m[2] !== undefined && m[2] !== '' ? m[2] : undefined };
}

export function parseRules(json: any): { rules: RulesConfig; errors: string[] } {
  const rules = emptyRules();
  const errors: string[] = [];
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { rules, errors: ['الملف يجب أن يكون كائن JSON'] };

  const perms = json.permissions ?? {};
  for (const k of ['allow', 'ask', 'deny'] as const) {
    const arr = perms[k];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      errors.push(`permissions.${k} يجب أن تكون مصفوفة`);
      continue;
    }
    for (const r of arr) {
      if (typeof r === 'string' && parseRuleString(r)) rules.permissions[k].push(r.trim());
      else errors.push(`قاعدة غير صالحة في ${k}: ${JSON.stringify(r)} (الصيغة: tool أو tool(pattern))`);
    }
  }

  const hooks = json.hooks ?? {};
  for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
    const arr = hooks[phase];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) {
      errors.push(`hooks.${phase} يجب أن تكون مصفوفة`);
      continue;
    }
    for (const h of arr) {
      if (!h || typeof h.command !== 'string' || !h.command.trim()) {
        errors.push(`hook في ${phase} بلا command`);
        continue;
      }
      if (h.matcher !== undefined && h.matcher !== '' && h.matcher !== '*') {
        try {
          new RegExp(String(h.matcher));
        } catch {
          errors.push(`matcher غير صالح: ${h.matcher}`);
          continue;
        }
      }
      rules.hooks[phase].push({
        matcher: h.matcher === undefined ? undefined : String(h.matcher),
        paths: Array.isArray(h.paths) ? h.paths.map(String) : undefined,
        command: h.command,
        timeout: typeof h.timeout === 'number' && h.timeout > 0 ? Math.min(h.timeout, 300) : undefined,
        feedback: h.feedback === true,
      });
    }
  }
  return { rules, errors };
}

function mergeRules(a: RulesConfig, b: RulesConfig): RulesConfig {
  return {
    permissions: {
      allow: [...a.permissions.allow, ...b.permissions.allow],
      ask: [...a.permissions.ask, ...b.permissions.ask],
      deny: [...a.permissions.deny, ...b.permissions.deny],
    },
    hooks: {
      PreToolUse: [...a.hooks.PreToolUse, ...b.hooks.PreToolUse],
      PostToolUse: [...a.hooks.PostToolUse, ...b.hooks.PostToolUse],
    },
  };
}

// ---------- الموضوع الذي تُطابَق عليه القاعدة ----------

export interface Subject {
  kind: 'command' | 'path' | 'url' | 'none';
  text?: string;
}

const PATH_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'list_dir', 'search']);

/** أسماء أدوات الملفات (تُستخدم لتمييز قواعد المسارات عن قواعد الأوامر) */
const PATH_TOOL_NAMES = [...PATH_TOOLS];

/** يستخرج ما تُطابَق عليه القواعد: الأمر أو المسار (نسبياً للمشروع وبفواصل /) أو الرابط */
export function subjectOf(name: string, args: any, root: string): Subject {
  if (!args || typeof args !== 'object') return { kind: 'none' };
  // ملاحظة: «cmd» مقبولة أيضاً — جسر العقل الخارجي يسمّي الوسيط cmd، وقواعد المستخدم يجب
  // أن تُطابَق مهما كان الاسم المستعمل من الجهة المستدعية (وإلا مرّ الأمر بلا قاعدة).
  if (name === 'run_command') return { kind: 'command', text: String(args.command ?? args.cmd ?? '').trim() };
  if (name === 'web_fetch') return { kind: 'url', text: String(args.url ?? '') };
  if (PATH_TOOLS.has(name)) {
    const p = args.path ?? (name === 'list_dir' || name === 'search' ? '.' : undefined);
    if (typeof p !== 'string' || !p) return { kind: 'none' };
    const rel = path.relative(root, path.resolve(root, p)).split(path.sep).join('/');
    return { kind: 'path', text: rel || '.' };
  }
  return { kind: 'none' };
}

// ---------- تقسيم الأوامر المركّبة ----------

/**
 * كلمات الأمر بعد إزالة الفواصل والاقتباسات، مع قيمة أي `--opt=value`.
 * تُستخدم لمطابقة قواعد المسارات (deny/ask) على أوامر run_command،
 * فقاعدة مثل `read_file(.env*)` تمنع أيضاً `cat .env` بدل أن تقتصر على الأداة وحدها.
 */
export function commandTokens(cmd: string): string[] {
  const out: string[] = [];
  for (const raw of cmd.split(/[\s;&|<>()]+/)) {
    const t = raw.replace(/^["']+/, '').replace(/["']+$/, '').replace(/[,;:]+$/, '');
    if (!t) continue;
    out.push(t);
    const eq = t.indexOf('=');
    if (eq > 0 && eq < t.length - 1) out.push(t.slice(eq + 1));
  }
  return out;
}

/**
 * يقسّم أمراً مركّباً (&& || ; | سطر جديد &) إلى أجزائه خارج علامات الاقتباس.
 * risky = فيه استبدال أوامر أو إعادة توجيه أو أقواس: لا يُسمح له تلقائياً أبداً بقاعدة allow.
 */
export function splitCommand(cmd: string): { parts: string[]; risky: boolean } {
  const src = cmd.replace(/\d?>&\d/g, ' '); // 2>&1 شائعة وآمنة
  const parts: string[] = [];
  let cur = '';
  let quote: '' | "'" | '"' = '';
  let risky = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote === "'") {
      cur += c;
      if (c === "'") quote = '';
      continue;
    }
    if (c === '\\' && i + 1 < src.length) {
      cur += c + src[++i];
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '`' || (c === '$' && src[i + 1] === '(')) risky = true;
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '`' || (c === '$' && src[i + 1] === '(') || c === '(' || c === ')' || c === '>' || c === '<') {
      risky = true;
      cur += c;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '\n') {
      if ((c === '&' || c === '|') && src[i + 1] === c) i++;
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (quote) risky = true; // اقتباس غير مغلق
  parts.push(cur);
  return { parts: parts.map((p) => p.trim()).filter(Boolean), risky };
}

// ---------- المطابقة ----------

const escRe = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

function matchCommandPattern(pattern: string, cmd: string): boolean {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  return new RegExp(`^${pattern.split('*').map(escRe).join('.*')}$`, 's').test(cmd);
}

function matchPathPattern(pattern: string, rel: string): boolean {
  const p = pattern.replace(/^\.\//, '');
  const re = globToRegExp(p);
  if (!p.includes('/')) return re.test(rel.slice(rel.lastIndexOf('/') + 1)) || re.test(rel);
  return re.test(rel) || (p.endsWith('/**') && rel === p.slice(0, -3));
}

function matchUrlPattern(pattern: string, url: string): boolean {
  if (pattern.startsWith('domain:')) {
    const d = pattern.slice(7).toLowerCase();
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === d || host.endsWith('.' + d);
    } catch {
      return false;
    }
  }
  return new RegExp(`^${pattern.split('*').map(escRe).join('.*')}$`).test(url);
}

function ruleMatches(rule: string, name: string, subject: Subject, cmdPart?: string): boolean {
  const r = parseRuleString(rule);
  if (!r || !r.tools.test(name)) return false;
  if (r.pattern === undefined) return true;
  if (subject.text === undefined) return false;
  switch (subject.kind) {
    case 'command':
      return matchCommandPattern(r.pattern, cmdPart ?? subject.text);
    case 'path':
      return matchPathPattern(r.pattern, subject.text);
    case 'url':
      return matchUrlPattern(r.pattern, subject.text);
    default:
      return false;
  }
}

export interface Decision {
  action: 'deny' | 'ask' | 'allow' | 'default';
  rule?: string;
}

/**
 * هل يشير أمر shell إلى مسار تطابقه قاعدة مسارات (deny/ask)؟
 * يغلق هذا ثغرة موثّقة: `deny read_file(.env*)` كانت لا تمنع `run_command(cat .env)`.
 * تُطبَّق على قواعد المنع والسؤال فقط (تزيد الحماية)، ولا تُطبَّق على allow أبداً.
 */
function ruleHitsCommandPath(rule: string, subject: Subject): boolean {
  if (subject.kind !== 'command' || subject.text === undefined) return false;
  const r = parseRuleString(rule);
  if (!r || r.pattern === undefined || r.pattern.startsWith('domain:')) return false;
  if (!PATH_TOOL_NAMES.some((t) => r.tools.test(t))) return false;
  return commandTokens(subject.text).some((tok) => matchPathPattern(r.pattern!, tok));
}

export function decide(perms: Permissions, name: string, args: any, root: string): Decision {
  const subject = subjectOf(name, args, root);
  // الأوامر المركّبة: نفحص كل جزء على حدة، فلا تمرّ "npm test && rm -rf x" بقاعدة npm test
  const cmd = subject.kind === 'command' ? splitCommand(subject.text ?? '') : null;
  const targets: (string | undefined)[] = cmd ? [subject.text, ...cmd.parts] : [undefined];

  for (const r of perms.deny) if (targets.some((t) => ruleMatches(r, name, subject, t)) || ruleHitsCommandPath(r, subject)) return { action: 'deny', rule: r };
  for (const r of perms.ask) if (targets.some((t) => ruleMatches(r, name, subject, t)) || ruleHitsCommandPath(r, subject)) return { action: 'ask', rule: r };

  if (cmd) {
    if (cmd.risky || !cmd.parts.length) return { action: 'default' };
    let last = '';
    const all = cmd.parts.every((part) => {
      const hit = perms.allow.find((r) => ruleMatches(r, name, subject, part));
      if (hit) last = hit;
      return !!hit;
    });
    return all ? { action: 'allow', rule: last } : { action: 'default' };
  }
  const hit = perms.allow.find((r) => ruleMatches(r, name, subject));
  return hit ? { action: 'allow', rule: hit } : { action: 'default' };
}

// ---------- اقتراح قاعدة "اسمح دائماً" ----------

const NO_SUGGEST = new Set(['bash', 'sh', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh', 'eval', 'exec', 'xargs', 'env', 'find', 'sudo', 'ssh', 'curl', 'wget', 'nc', 'ncat']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'php', 'deno', 'bun', 'npx']);

/** قاعدة مقترحة لزر "اسمح دائماً"، أو null إن لم يكن آمناً اقتراح قاعدة واسعة */
export function suggestRule(name: string, args: any, root: string): string | null {
  const s = subjectOf(name, args, root);
  if (name === 'run_command') {
    const { parts, risky } = splitCommand(s.text ?? '');
    if (risky || parts.length !== 1) return null;
    const t = parts[0].split(/\s+/);
    if (NO_SUGGEST.has(t[0])) return null;
    const simple = (x?: string) => !!x && /^[\w:./@-]+$/.test(x) && !x.startsWith('-');
    if (INTERPRETERS.has(t[0]) && !simple(t[1])) return null;
    let prefix = t[0];
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(t[0]) && t[1] === 'run' && simple(t[2])) prefix = `${t[0]} run ${t[2]}`;
    else if (simple(t[1])) prefix = `${t[0]} ${t[1]}`;
    return `run_command(${prefix}:*)`;
  }
  if (name === 'write_file' || name === 'edit_file') {
    if (s.kind !== 'path' || !s.text) return null;
    const dir = s.text.includes('/') ? s.text.slice(0, s.text.lastIndexOf('/')) : '';
    return dir ? `write_file|edit_file(${dir}/**)` : `${name}(${s.text})`;
  }
  if (name.startsWith('mcp__')) return name;
  if (name === 'web_fetch') {
    try {
      return `web_fetch(domain:${new URL(s.text ?? '').hostname})`;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- الـ Hooks ----------

export interface HookInfo {
  root: string;
  name: string;
  args: any;
  result?: string;
  isError?: boolean;
}

export interface HookOutcome {
  ran: number;
  blocked: boolean;
  /** سبب المنع (PreToolUse، خروج بالرمز 2) */
  message: string;
  notices: string[];
  /** نص يُلحق بنتيجة الأداة (PostToolUse) */
  appended: string;
}

function hookApplies(h: HookDef, name: string, subject: Subject): boolean {
  if (h.matcher && h.matcher !== '*') {
    try {
      if (!new RegExp(`^(?:${h.matcher})$`).test(name)) return false;
    } catch {
      return false;
    }
  }
  if (h.paths?.length) {
    if (subject.kind !== 'path' || subject.text === undefined) return false;
    if (!h.paths.some((p) => matchPathPattern(p, subject.text!))) return false;
  }
  return true;
}

const clipHook = (s: string) => (s.length > 4000 ? s.slice(0, 4000) + '\n…[اقتُطع]' : s).trim();

export async function runHooks(phase: HookPhase, hooks: HookDef[], info: HookInfo, signal?: AbortSignal): Promise<HookOutcome> {
  const out: HookOutcome = { ran: 0, blocked: false, message: '', notices: [], appended: '' };
  if (!hooks.length) return out;
  const subject = subjectOf(info.name, info.args, info.root);

  for (const h of hooks) {
    if (!hookApplies(h, info.name, subject)) continue;
    out.ran++;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FREECODE_PHASE: phase,
      FREECODE_TOOL: info.name,
      FREECODE_PROJECT_DIR: info.root,
    };
    if (subject.kind === 'path' && subject.text) {
      env.FREECODE_FILE = subject.text;
      env.FREECODE_FILE_ABS = path.resolve(info.root, subject.text);
    }
    if (subject.kind === 'command') env.FREECODE_COMMAND = subject.text ?? '';
    const input = JSON.stringify({ phase, tool: info.name, args: info.args, result: info.result, isError: info.isError, cwd: info.root });
    const r = await runShell(h.command, { cwd: info.root, env, input, timeoutMs: (h.timeout ?? 30) * 1000, signal });
    const text = clipHook(r.output);
    const label = h.command.length > 60 ? h.command.slice(0, 60) + '…' : h.command;

    if (r.aborted) break;
    if (r.timedOut) {
      out.notices.push(`hook تجاوز المهلة (${h.timeout ?? 30}ث): ${label}`);
      if (phase === 'PostToolUse') out.appended += `\n[hook تجاوز المهلة: ${label}]`;
      continue;
    }
    if (r.code === 0) {
      if (phase === 'PostToolUse' && h.feedback && text) out.appended += `\n[hook: ${label}]\n${text}`;
      continue;
    }
    if (phase === 'PreToolUse' && r.code === 2) {
      out.blocked = true;
      out.message = text || `منعه hook: ${label}`;
      out.notices.push(`hook منع العملية: ${label}`);
      break; // لا داعي لبقية الـ hooks
    }
    out.notices.push(`hook فشل (${r.code}): ${label}`);
    if (phase === 'PostToolUse') out.appended += `\n[hook فشل بالرمز ${r.code}: ${label}]\n${text}`;
  }
  return out;
}

// ---------- التحميل والثقة ----------

export interface LoadedRules {
  rules: RulesConfig;
  userPath: string;
  projectPath: string;
  projectPresent: boolean;
  /** يحوي allow أو hooks، فيحتاج موافقتك */
  projectSensitive: boolean;
  projectTrusted: boolean;
  needsTrust: boolean;
  hash: string;
  errors: string[];
  /** وصف قابل للعرض لما يطلبه المشروع */
  projectSummary: string[];
}

async function readJson(file: string): Promise<{ text: string; json: any } | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    return { text, json: JSON.parse(text) };
  } catch (e: any) {
    return { text, json: { __error: String(e?.message ?? e) } };
  }
}

export async function loadRules(userFile: string, ws: string, isTrusted: (hash: string) => boolean): Promise<LoadedRules> {
  const errors: string[] = [];
  const projectPath = path.join(ws, '.freecode', 'rules.json');

  let rules = emptyRules();
  const u = await readJson(userFile);
  if (u) {
    if (u.json?.__error) errors.push(`rules.json (المستخدم): ${u.json.__error}`);
    else {
      const p = parseRules(u.json);
      rules = p.rules;
      errors.push(...p.errors.map((e) => `rules.json (المستخدم): ${e}`));
    }
  }

  const pr = await readJson(projectPath);
  let projectSensitive = false;
  let projectTrusted = false;
  let hash = '';
  const projectSummary: string[] = [];
  if (pr) {
    if (pr.json?.__error) errors.push(`.freecode/rules.json: ${pr.json.__error}`);
    else {
      const p = parseRules(pr.json);
      errors.push(...p.errors.map((e) => `.freecode/rules.json: ${e}`));
      const hookCount = p.rules.hooks.PreToolUse.length + p.rules.hooks.PostToolUse.length;
      projectSensitive = p.rules.permissions.allow.length > 0 || hookCount > 0;
      hash = createHash('sha256').update(JSON.stringify(p.rules)).digest('hex');
      projectTrusted = projectSensitive && isTrusted(hash);
      for (const a of p.rules.permissions.allow) projectSummary.push(`سماح تلقائي: ${a}`);
      for (const ph of ['PreToolUse', 'PostToolUse'] as const)
        for (const h of p.rules.hooks[ph]) projectSummary.push(`${ph}${h.matcher ? ` [${h.matcher}]` : ''}: ${h.command}`);
      const restrict: RulesConfig = emptyRules();
      restrict.permissions.deny = p.rules.permissions.deny;
      restrict.permissions.ask = p.rules.permissions.ask;
      // deny/ask تقيّد فقط فتعمل دائماً؛ allow والـ hooks تحتاج الثقة
      rules = mergeRules(rules, !projectSensitive || projectTrusted ? p.rules : restrict);
    }
  }

  return {
    rules,
    userPath: userFile,
    projectPath,
    projectPresent: !!pr,
    projectSensitive,
    projectTrusted,
    needsTrust: projectSensitive && !projectTrusted,
    hash,
    errors,
    projectSummary,
  };
}

/** يضيف قاعدة allow لملف المستخدم (زر "اسمح دائماً") */
export async function addUserAllow(userFile: string, rule: string): Promise<boolean> {
  if (!parseRuleString(rule)) return false;
  let json: any = {};
  const cur = await readJson(userFile);
  if (cur) {
    if (cur.json?.__error) return false; // لا نفسد ملفاً يحرره المستخدم
    json = cur.json;
  }
  json.permissions = json.permissions ?? {};
  json.permissions.allow = Array.isArray(json.permissions.allow) ? json.permissions.allow : [];
  if (!json.permissions.allow.includes(rule)) json.permissions.allow.push(rule);
  await fs.mkdir(path.dirname(userFile), { recursive: true });
  await fs.writeFile(userFile, JSON.stringify(json, null, 2), { mode: 0o600 });
  return true;
}

export const RULES_TEMPLATE = `{
  "permissions": {
    "allow": ["run_command(npm test:*)", "run_command(git status)", "run_command(git diff:*)"],
    "ask": ["run_command(git push:*)"],
    "deny": ["read_file(.env*)", "write_file|edit_file(.env*)"]
  },
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": []
  }
}
`;
