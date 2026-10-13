// الإضافات (Plugins): حزمة واحدة تجمع مهارات + hooks + قواعد سماح + خوادم MCP،
// فتُوزَّع كمجلد واحد ويُفعّلها المستخدم بنقرة.
//
// الشكل (متوافق مع فكرة إضافات Claude Code لكن أبسط):
//   <userData>/plugins/<slug>/plugin.json          إضافاتك (كل المشاريع)
//   <المشروع>/.freecode/plugins/<slug>/plugin.json إضافات المشروع (تحتاج ثقة صريحة)
//
//   <slug>/
//     plugin.json
//     skills/<اسم-المهارة>/SKILL.md      ← تُضاف لمهارات الوكيل
//     hooks/…                            ← أوامر hooks المشار إليها في plugin.json
//
// إضافة المشروع لا تُفعّل hooks/صلاحياتها قبل أن يثق بها المستخدم (نفس منطق rules.json/MCP)،
// وإلا صار استنساخ مستودع خطراً. مهارات الإضافة وأوامرها تُقرأ كملفات فقط.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { HookDef, RulesConfig } from './rules';
import type { McpServerConfig } from './mcp';

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** مجلدات المهارات داخل الإضافة (الافتراضي: skills) */
  skills?: string[];
  hooks?: { PreToolUse?: HookDef[]; PostToolUse?: HookDef[] } | Record<string, unknown>;
  permissions?: { allow?: string[]; ask?: string[]; deny?: string[] };
  mcp?: Record<string, McpServerConfig>;
}

export interface Plugin {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  dir: string;
  manifestFile: string;
  source: 'project' | 'user';
  /** بصمة المحتوى: يُطلب تجديد الثقة إن تغيّرت */
  hash: string;
  /** مجلدات مهارات موجودة فعلاً على القرص */
  skillDirs: string[];
  hooks: { PreToolUse: HookDef[]; PostToolUse: HookDef[] };
  permissions: { allow: string[]; ask: string[]; deny: string[] };
  mcp: Record<string, McpServerConfig>;
  /** هل تحتاج ثقة لم تُمنح بعد؟ (إضافات المشروع فقط) */
  needsTrust: boolean;
  /** خطأ في الملف (يُعرض ولا يعطّل البقية) */
  error?: string;
  disabled?: boolean;
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;

export function pluginDirs(root: string, userDataDir: string): { project: string; user: string } {
  return { project: path.join(root, '.freecode', 'plugins'), user: path.join(userDataDir, 'plugins') };
}

/** بصمة الإضافة: المانيفست + ملفات المهارات (فيكتشف المستخدم تغيّرها) */
export async function pluginFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  const walk = async (d: string, depth = 0): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 200)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        try {
          const st = await fs.stat(p);
          parts.push(`${path.relative(dir, p)}:${st.size}`);
        } catch {
          /* تجاهل */
        }
      }
    }
  };
  await walk(dir);
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

function parseHooks(raw: unknown): { PreToolUse: HookDef[]; PostToolUse: HookDef[] } {
  const out = { PreToolUse: [] as HookDef[], PostToolUse: [] as HookDef[] };
  if (!raw || typeof raw !== 'object') return out;
  for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
    const list = (raw as any)[phase];
    if (!Array.isArray(list)) continue;
    for (const h of list.slice(0, 50)) {
      if (!h || typeof h.command !== 'string' || !h.command.trim()) continue;
      out[phase].push({
        matcher: typeof h.matcher === 'string' ? h.matcher : undefined,
        paths: Array.isArray(h.paths) ? h.paths.filter((p: unknown) => typeof p === 'string') : undefined,
        command: h.command,
        timeout: Number.isFinite(h.timeout) ? Math.max(1, Math.min(600, Number(h.timeout))) : undefined,
        feedback: h.feedback === true,
      });
    }
  }
  return out;
}

async function readPlugin(dir: string, slug: string, source: 'project' | 'user'): Promise<Plugin | null> {
  const manifestFile = path.join(dir, 'plugin.json');
  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  } catch (e: any) {
    // مجلد فيه ملف مانيفست تالف: نُظهر الخطأ بدل تجاهله بصمت
    const exists = await fs
      .access(manifestFile)
      .then(() => true)
      .catch(() => false);
    if (!exists) return null;
    return {
      slug,
      name: slug,
      version: '',
      description: '',
      author: '',
      dir,
      manifestFile,
      source,
      hash: '',
      skillDirs: [],
      hooks: { PreToolUse: [], PostToolUse: [] },
      permissions: { allow: [], ask: [], deny: [] },
      mcp: {},
      needsTrust: source === 'project',
      error: String(e?.message ?? e).slice(0, 200),
    };
  }

  const name = String(raw.name ?? slug).trim() || slug;
  const skillsRaw = asArray(raw.skills);
  const skillDirs: string[] = [];
  for (const s of skillsRaw.length ? skillsRaw : ['skills']) {
    const p = path.join(dir, s);
    const ok = await fs
      .stat(p)
      .then((st) => st.isDirectory())
      .catch(() => false);
    if (ok) skillDirs.push(p);
  }

  const permissions = {
    allow: asArray(raw.permissions?.allow),
    ask: asArray(raw.permissions?.ask),
    deny: asArray(raw.permissions?.deny),
  };

  const mcp: Record<string, McpServerConfig> = {};
  if (raw.mcp && typeof raw.mcp === 'object') {
    for (const [n, c] of Object.entries<any>(raw.mcp)) {
      if (!c || typeof c.command !== 'string') continue;
      mcp[n] = {
        command: c.command,
        args: asArray(c.args),
        env: c.env && typeof c.env === 'object' ? c.env : undefined,
        cwd: typeof c.cwd === 'string' ? path.join(dir, c.cwd) : dir,
        disabled: c.disabled === true,
      };
    }
  }

  return {
    slug,
    name,
    version: String(raw.version ?? ''),
    description: String(raw.description ?? '').slice(0, 300),
    author: String(raw.author ?? ''),
    dir,
    manifestFile,
    source,
    hash: await pluginFingerprint(dir),
    skillDirs,
    hooks: parseHooks(raw.hooks),
    permissions,
    mcp,
    needsTrust: source === 'project',
  };
}

async function scanDir(base: string, source: 'project' | 'user'): Promise<Plugin[]> {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Plugin[] = [];
  for (const e of entries.slice(0, 100)) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    if (!SLUG_RE.test(e.name)) continue;
    const p = await readPlugin(path.join(base, e.name), e.name, source);
    if (p) out.push(p);
  }
  return out;
}

/**
 * يكتشف الإضافات من المشروع ومن المستخدم. إضافة المستخدم تتقدم عند تعارض الأسماء
 * (المستخدم هو من ثبّتها بنفسه)، وإضافة المشروع تحمل needsTrust حتى يوافق المستخدم.
 */
export async function discoverPlugins(
  root: string,
  userDataDir: string,
  opts: { trusted?: Record<string, string>; disabled?: string[] } = {},
): Promise<Plugin[]> {
  const dirs = pluginDirs(root, userDataDir);
  const list = [...(await scanDir(dirs.user, 'user')), ...(await scanDir(dirs.project, 'project'))];
  const trusted = opts.trusted ?? {};
  const disabled = new Set(opts.disabled ?? []);
  const found = new Map<string, Plugin>();
  for (const p of list) {
    // إضافة المستخدم لا تُزيح إضافة مشروع بنفس الاسم إن كانت معطّلة
    const key = p.slug;
    if (found.has(key)) continue;
    p.needsTrust = p.source === 'project' && !p.error && trusted[p.dir] !== p.hash;
    p.disabled = disabled.has(p.slug) || disabled.has(p.dir);
    found.set(key, p);
  }
  return [...found.values()];
}

/** الإضافات الفعّالة: بلا خطأ، وغير معطّلة، ومُوثوق بها إن كانت من المشروع */
export function activePlugins(plugins: Plugin[]): Plugin[] {
  return plugins.filter((p) => !p.error && !p.disabled && !p.needsTrust);
}

/** يدمج hooks الإضافات في قواعد الجلسة (تُضاف بعد قواعد المستخدم والمشروع) */
export function mergePluginRules(rules: RulesConfig, plugins: Plugin[]): RulesConfig {
  const out: RulesConfig = { permissions: { ...rules.permissions }, hooks: { PreToolUse: [...rules.hooks.PreToolUse], PostToolUse: [...rules.hooks.PostToolUse] } };
  for (const p of activePlugins(plugins)) {
    out.permissions.allow.push(...p.permissions.allow);
    out.permissions.ask.push(...p.permissions.ask);
    out.permissions.deny.push(...p.permissions.deny);
    out.hooks.PreToolUse.push(...p.hooks.PreToolUse);
    out.hooks.PostToolUse.push(...p.hooks.PostToolUse);
  }
  return out;
}

/** خوادم MCP التي تجلبها الإضافات الفعّالة */
export function pluginMcpServers(plugins: Plugin[]): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const p of activePlugins(plugins)) for (const [n, c] of Object.entries(p.mcp)) out[`${p.slug}__${n}`] = c;
  return out;
}

export const PLUGIN_TEMPLATE = `{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "وصف قصير: ماذا تضيف هذه الإضافة؟",
  "author": "",
  "skills": ["skills"],
  "hooks": {
    "PostToolUse": [{ "matcher": "edit_file|write_file", "command": "echo 'تم تعديل ملف: $FILE'", "feedback": false }]
  },
  "permissions": { "allow": [] },
  "mcp": {}
}
`;

export const SKILL_SAMPLE = `---
name: example-skill
description: مثال مهارة تُضيفها هذه الإضافة — عدّلها أو احذفها
---

# الهدف
اشرح هنا ما تفعله المهارة وكيف يعمل الوكيل.
`;

/** ينشئ إضافة جديدة في مجلد المستخدم ويعيد مسارها */
export async function scaffoldPlugin(userDataDir: string, name: string): Promise<{ ok: boolean; dir?: string; error?: string }> {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!slug || !SLUG_RE.test(slug)) return { ok: false, error: 'اختر اسماً لاتينياً بسيطاً (a-z، أرقام، شرطات)' };
  const dir = path.join(pluginDirs('', userDataDir).user, slug);
  if (await fs.stat(dir).then(() => true).catch(() => false)) return { ok: false, error: `الإضافة «${slug}» موجودة مسبقاً` };
  await fs.mkdir(path.join(dir, 'skills', 'example-skill'), { recursive: true });
  await fs.writeFile(path.join(dir, 'plugin.json'), PLUGIN_TEMPLATE.replace('"my-plugin"', `"${slug}"`), 'utf8');
  await fs.writeFile(path.join(dir, 'skills', 'example-skill', 'SKILL.md'), SKILL_SAMPLE, 'utf8');
  return { ok: true, dir };
}

/** وصف عربي مختصر لحالة الإضافة (للواجهة والأوامر) */
export function describePlugin(p: Plugin): string {
  if (p.error) return `خطأ في المانيفست: ${p.error}`;
  if (p.disabled) return 'معطّلة';
  if (p.needsTrust) return 'تحتاج ثقة';
  const bits: string[] = [];
  if (p.skillDirs.length) bits.push('مهارات');
  if (p.hooks.PreToolUse.length + p.hooks.PostToolUse.length) bits.push('hooks');
  if (p.permissions.allow.length || p.permissions.ask.length || p.permissions.deny.length) bits.push('قواعد');
  if (Object.keys(p.mcp).length) bits.push('خوادم MCP');
  return bits.length ? `مفعّلة (${bits.join(' · ')})` : 'مفعّلة';
}
