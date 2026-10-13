// سوق الإضافات: تثبيت إضافة من مستودع Git (أو من مجلد محلي للتطوير والاختبار)
// بمراجعة أمنية إلزامية قبل التثبيت — لا ثقة عمياء بمستودع مجهول.
//
// دورة الحياة:
//   1) /plugins install <url>            ← تنزيل إلى منطقة مؤقتة + عرض مراجعة (لا تثبيت)
//   2) /plugins install <url> --yes      ← تثبيت بعد المراجعة (يُنقل من المؤقت إلى plugins/)
//   3) /plugins update <الاسم>           ← تنزيل + مقارنة البصمة ثم تحديث إن تغيّرت
//   4) /plugins remove <الاسم>           ← نقل إلى سلة داخل مجلد الإضافات (لا حذف نهائي فوري)
//
// مبادئ الأمان المتّبعة هنا:
//   • لا نُشغّل أي شيء من الإضافة أثناء التثبيت: لا npm install، لا hooks، لا سكربتات.
//   • hooks وأوامر MCP تُفحص نصياً وتُعرض للمستخدم قبل التثبيت (مع كشف الأنماط الخطرة).
//   • إضافة المشروع تبقى تحتاج ثقة صريحة (/plugins trust) — وهذه إضافات المستخدم.
//   • سقوف حجم وعدد ملفات لمنع تحميل مستودع ضخم بغير علم المستخدم.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pluginFingerprint, type PluginManifest } from './plugins';

export type InstallSourceKind = 'git' | 'local';

export interface InstallSource {
  kind: InstallSourceKind;
  /** القيمة الأصلية كما كتبها المستخدم */
  raw: string;
  /** ما سيُنفَّذ فعلاً (للشفافية) */
  command: string;
}

const URL_RE = /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)[^\s]+$/i;

/** يقبل روابط git العادية، والمسارات المحلية (للتطوير والاختبار بلا إنترنت) */
export function parseInstallSource(raw: string): { ok: true; source: InstallSource } | { ok: false; error: string } {
  const value = String(raw ?? '').trim().replace(/^file:\/\//, '/');
  if (!value) return { ok: false, error: 'اكتب مصدر الإضافة: رابط مستودع git أو مسار مجلد محلي.' };
  if (/^\.\.?\//.test(value) || path.isAbsolute(value)) {
    return { ok: true, source: { kind: 'local', raw: value, command: `نسخ المجلد ${value}` } };
  }
  if (!URL_RE.test(value)) {
    return { ok: false, error: 'المصدر غير مقبول. الصيغ المدعومة: https://host/user/repo (أو .git) · git@host:user/repo · مسار مجلد محلي.' };
  }
  return { ok: true, source: { kind: 'git', raw: value, command: `git clone --depth 1 ${value}` } };
}

// ---------- الفحص الأمني ----------

const DANGEROUS_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: 'حذف متكرر قسري (rm -rf)' },
  { re: /\bsudo\b/, why: 'استخدام صلاحيات الجذر (sudo)' },
  { re: /curl[^|]*\|\s*(ba|z|d)?sh/i, why: 'تنزيل وتشغيل سكربت مباشرة (curl | sh)' },
  { re: /wget[^|]*\|\s*(ba|z|d)?sh/i, why: 'تنزيل وتشغيل سكربت مباشرة (wget | sh)' },
  { re: /\bchmod\s+777\b/, why: 'فتح صلاحيات الملفات للجميع (chmod 777)' },
  { re: /\bdd\s+if=/, why: 'كتابة قرص مباشرة (dd)' },
  { re: /\/dev\/sd[a-z]/, why: 'كتابة على قرص النظام' },
  { re: /\b(nc|ncat|netcat)\s+-/, why: 'فتح اتصال شبكي خام (netcat)' },
  { re: /\bbase64\s+-d[^|]*\|\s*(ba|z|d)?sh/i, why: 'تنفيذ نص مُشفَّر (base64 | sh)' },
  { re: /\beval\b/, why: 'تنفيذ نص كبرمجة (eval)' },
  { re: /:\(\)\s*\{.*\};\s*:/, why: 'قنبلة تفريع (fork bomb)' },
  { re: /\bhistory\s+-c|\.bash_history|credentials|id_rsa|\.ssh\b/i, why: 'لمس ملفات حساسة (مفاتيح/سجل)' },
];

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  text: string;
}

function scanText(text: string): string[] {
  const hits: string[] = [];
  for (const p of DANGEROUS_PATTERNS) if (p.re.test(text)) hits.push(p.why);
  return hits;
}

const MAX_FILES = 500;
const MAX_BYTES = 5 * 1024 * 1024;

async function measure(dir: string): Promise<{ files: number; bytes: number; truncated: boolean }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string, depth = 0): Promise<void> => {
    if (depth > 6 || files > MAX_FILES || bytes > MAX_BYTES) return;
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        files++;
        try {
          bytes += (await fs.stat(p)).size;
        } catch {
          /* تجاهل */
        }
      }
    }
  };
  await walk(dir);
  return { files, bytes, truncated: files > MAX_FILES || bytes > MAX_BYTES };
}

// ---------- المراجعة ----------

export interface PluginReview {
  ok: boolean;
  error?: string;
  source: InstallSource;
  /** مجلد المراجعة المؤقت (يُحذف عند discardReview) */
  staging: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  files: number;
  bytes: number;
  skills: number;
  hooks: { phase: 'PreToolUse' | 'PostToolUse'; matcher: string; command: string }[];
  rules: { allow: string[]; ask: string[]; deny: string[] };
  mcp: { name: string; command: string; args: string[] }[];
  findings: ReviewFinding[];
  risk: 'low' | 'medium' | 'high';
  /** بصمة المحتوى (تُستخدم لمقارنة التحديثات) */
  hash: string;
  /** نسخة مثبّتة سابقاً بنفس الاسم؟ */
  installedHash?: string;
  changes: string[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,48}$/;

function slugify(name: string, fallback: string): string {
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return SLUG_RE.test(base) ? base : fallback;
}

function gitClone(url: string, dest: string, timeoutMs: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile('git', ['clone', '--depth', '1', '--single-branch', url, dest], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const msg = String((err as any)?.killed ? 'انتهت مهلة التنزيل' : stderr || (err as any)?.message || err).slice(0, 300);
      resolve({ ok: false, error: msg });
    });
  });
}

async function copyDir(src: string, dest: string, depth = 0): Promise<void> {
  if (depth > 6) return;
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d, depth + 1);
    else if (e.isFile()) await fs.copyFile(s, d);
  }
}

/**
 * ينزّل الإضافة إلى منطقة مؤقتة ويُنتج تقرير مراجعة كامل — **بلا تثبيت**.
 * التثبيت خطوة منفصلة صريحة (applyInstall) لئلا يتحوّل لصق رابط إلى تنفيذ.
 */
export async function reviewInstall(raw: string, userDataDir: string, opts: { gitTimeoutMs?: number } = {}): Promise<PluginReview> {
  const parsed = parseInstallSource(raw);
  const empty: PluginReview = {
    ok: false,
    source: parsed.ok ? parsed.source : { kind: 'git', raw: String(raw), command: '' },
    staging: '',
    slug: '',
    name: '',
    version: '',
    description: '',
    author: '',
    files: 0,
    bytes: 0,
    skills: 0,
    hooks: [],
    rules: { allow: [], ask: [], deny: [] },
    mcp: [],
    findings: [],
    risk: 'low',
    hash: '',
    changes: [],
  };
  if (!parsed.ok) return { ...empty, error: parsed.error };

  const source = parsed.source;
  const stagingRoot = path.join(userDataDir, '.market-staging');
  const staging = path.join(stagingRoot, `review-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`);
  try {
    await fs.mkdir(stagingRoot, { recursive: true });
    await fs.rm(staging, { recursive: true, force: true });
    if (source.kind === 'git') {
      const r = await gitClone(source.raw, staging, opts.gitTimeoutMs ?? 180_000);
      if (!r.ok) return { ...empty, error: `تعذّر تنزيل المستودع: ${r.error}` };
    } else {
      const src = path.resolve(source.raw);
      const isDir = await fs.stat(src).then((st) => st.isDirectory()).catch(() => false);
      if (!isDir) return { ...empty, error: `المسار المحلي غير موجود أو ليس مجلداً: ${src}` };
      await copyDir(src, staging);
    }

    // لا نُبقي مجلد .git في النسخة: الإضافة ملفات لا مستودع، والبصمة تتجاهله فتبقى المقارنة دقيقة
    await fs.rm(path.join(staging, '.git'), { recursive: true, force: true }).catch(() => {});

    // مانيفست الإضافة إلزامي في الجذر (أو في مجلد واحد داخل الجذر — حالة المستودعات المغلّفة)
    let root = staging;
    let manifestFile = path.join(root, 'plugin.json');
    let exists = await fs.stat(manifestFile).then((st) => st.isFile()).catch(() => false);
    if (!exists) {
      const entries = await fs.readdir(staging, { withFileTypes: true }).catch(() => []);
      const dirs = entries.filter((e) => e.isDirectory());
      for (const d of dirs) {
        const candidate = path.join(staging, d.name, 'plugin.json');
        if (await fs.stat(candidate).then((st) => st.isFile()).catch(() => false)) {
          root = path.join(staging, d.name);
          manifestFile = candidate;
          exists = true;
          break;
        }
      }
    }
    if (!exists) {
      return { ...empty, staging, error: 'المستودع لا يحتوي `plugin.json` في الجذر (ولا داخل مجلد واحد) — هذا ليس إضافة FreeCode.' };
    }

    let manifest: PluginManifest & Record<string, unknown>;
    try {
      manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    } catch (e: any) {
      return { ...empty, staging, error: `ملف plugin.json غير صالح: ${String(e?.message ?? e).slice(0, 200)}` };
    }

    // لو وجدنا الجذر داخل مجلد فرعي نُسوّي المسار: ننقل محتواه إلى جذر منطقة المراجعة
    if (root !== staging) {
      const inner = root;
      const tmp = `${staging}__inner`;
      await fs.rename(inner, tmp);
      await fs.rm(staging, { recursive: true, force: true });
      await fs.rename(tmp, staging);
    }

    const { files, bytes, truncated } = await measure(staging);
    const findings: ReviewFinding[] = [];
    if (truncated) findings.push({ severity: 'high', text: `حجم المستودع كبير (${files} ملفاً · ${Math.round(bytes / 1024)} كB) وتجاوز الحد المسموح — راجعه يدوياً قبل التثبيت.` });

    const hooksRaw = (manifest.hooks && typeof manifest.hooks === 'object' ? manifest.hooks : {}) as Record<string, unknown>;
    const hooks: PluginReview['hooks'] = [];
    for (const phase of ['PreToolUse', 'PostToolUse'] as const) {
      const list = Array.isArray(hooksRaw[phase]) ? (hooksRaw[phase] as any[]) : [];
      for (const h of list.slice(0, 50)) {
        if (!h || typeof h.command !== 'string') continue;
        hooks.push({ phase, matcher: String(h.matcher ?? '*'), command: h.command });
      }
    }
    const rules = {
      allow: Array.isArray((manifest.permissions as any)?.allow) ? ((manifest.permissions as any).allow as string[]).map(String) : [],
      ask: Array.isArray((manifest.permissions as any)?.ask) ? ((manifest.permissions as any).ask as string[]).map(String) : [],
      deny: Array.isArray((manifest.permissions as any)?.deny) ? ((manifest.permissions as any).deny as string[]).map(String) : [],
    };
    const mcp: PluginReview['mcp'] = [];
    if (manifest.mcp && typeof manifest.mcp === 'object') {
      for (const [name, cfg] of Object.entries<any>(manifest.mcp)) {
        if (!cfg || typeof cfg.command !== 'string') continue;
        mcp.push({ name, command: cfg.command, args: Array.isArray(cfg.args) ? cfg.args.map(String) : [] });
      }
    }

    // الفحص النصي: أوامر hooks وأوامر MCP + نصوص الخطوات في المهارات (نصاً فقط، بلا تنفيذ)
    const high: string[] = [];
    for (const h of hooks) high.push(...scanText(h.command));
    for (const s of mcp) high.push(...scanText([s.command, ...s.args].join(' ')));
    if (rules.allow.length) findings.push({ severity: 'medium', text: `طلبت الإضافة سماحاً تلقائياً لـ${rules.allow.length} قاعدة (تتجاوز سؤالك عند المطابقة): ${rules.allow.slice(0, 4).join(' · ')}` });
    if (hooks.length) findings.push({ severity: 'medium', text: `فيها ${hooks.length} hook — أوامر تُنفَّذ تلقائياً على جهازك عند استخدام الأدوات المطابقة.` });
    if (mcp.length) findings.push({ severity: 'medium', text: `تشغّل ${mcp.length} خادم MCP كعملية محلية دائمة أثناء الجلسة.` });
    for (const why of [...new Set(high)]) findings.push({ severity: 'high', text: `نمط خطير في أوامر الإضافة: ${why}` });
    if (!hooks.length && !mcp.length && !rules.allow.length && !rules.ask.length && !rules.deny.length) {
      findings.push({ severity: 'low', text: 'لا hooks ولا قواعد صلاحيات ولا خوادم MCP — مهارات/ملفات فقط.' });
    }

    const skillDirsRaw = Array.isArray(manifest.skills) ? manifest.skills.map(String) : ['skills'];
    let skills = 0;
    for (const s of skillDirsRaw) {
      const dir = path.join(staging, s);
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory() && (await fs.stat(path.join(dir, e.name, 'SKILL.md')).then((st) => st.isFile()).catch(() => false))) skills++;
      }
    }

    const slug = slugify((manifest as any).name ?? '', 'plugin');
    const risk: PluginReview['risk'] = findings.some((f) => f.severity === 'high') ? 'high' : findings.some((f) => f.severity === 'medium') ? 'medium' : 'low';
    const hash = await pluginFingerprint(staging);

    // نسخة مثبّتة سابقاً بنفس الاسم؟ (للمقارنة والتحديث)
    const target = path.join(userDataDir, 'plugins', slug);
    const installed = await fs.stat(target).then((st) => st.isDirectory()).catch(() => false);
    let installedHash: string | undefined;
    let changes: string[] = [];
    if (installed) {
      installedHash = await pluginFingerprint(target);
      changes = hash === installedHash ? ['لا تغيير في المحتوى (نفس البصمة)'] : ['المحتوى تغيّر منذ التثبيت — التثبيت سيستبدل النسخة الحالية.'];
    }

    return {
      ok: true,
      source,
      staging,
      slug,
      name: String(manifest.name ?? slug),
      version: String(manifest.version ?? ''),
      description: String(manifest.description ?? ''),
      author: String(manifest.author ?? ''),
      files,
      bytes,
      skills,
      hooks,
      rules,
      mcp,
      findings,
      risk,
      hash,
      installedHash,
      changes,
    };
  } catch (e: any) {
    return { ...empty, staging, error: `فشل تجهيز المراجعة: ${String(e?.message ?? e).slice(0, 300)}` };
  }
}

/** يحذف منطقة المراجعة المؤقتة (يُستدعى عند الإلغاء أو بعد التثبيت) */
export async function discardReview(review: PluginReview): Promise<void> {
  if (!review.staging) return;
  await fs.rm(review.staging, { recursive: true, force: true }).catch(() => {});
}

const MARKET_FILE = '.market.json';

export interface InstalledRecord {
  slug: string;
  source: string;
  installedAt: number;
  version: string;
  description: string;
  files: number;
  risk: string;
  hash: string;
}

async function readMarket(userDataDir: string): Promise<Record<string, InstalledRecord>> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, 'plugins', MARKET_FILE), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, InstalledRecord>) : {};
  } catch {
    return {};
  }
}

async function writeMarket(userDataDir: string, data: Record<string, InstalledRecord>): Promise<void> {
  const dir = path.join(userDataDir, 'plugins');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, MARKET_FILE), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * يثبّت المراجعة في مجلد إضافات المستخدم. النسخة السابقة (إن وُجدت) تُنقل إلى
 * `.backup-…` بدل حذفها، فيمكن الرجوع يدوياً بلا فقدان.
 */
export async function applyInstall(review: PluginReview, userDataDir: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean; dir?: string; error?: string; backup?: string }> {
  if (!review.ok || !review.staging) return { ok: false, error: review.error ?? 'لا مراجعة صالحة — أعد /plugins install أولاً.' };
  const stage = await fs.stat(review.staging).then((st) => st.isDirectory()).catch(() => false);
  if (!stage) return { ok: false, error: 'انتهت صلاحية منطقة المراجعة المؤقتة — أعد /plugins install.' };

  const pluginsDir = path.join(userDataDir, 'plugins');
  const target = path.join(pluginsDir, review.slug);
  await fs.mkdir(pluginsDir, { recursive: true });

  let backup: string | undefined;
  const exists = await fs.stat(target).then(() => true).catch(() => false);
  if (exists) {
    if (!opts.force) return { ok: false, error: `توجد إضافة مثبّتة بالاسم «${review.slug}». استخدم --force للاستبدال (تُحفظ نسخة احتياطية).` };
    backup = path.join(pluginsDir, `.backup-${review.slug}-${Date.now()}`);
    await fs.rename(target, backup);
  }

  try {
    await fs.rename(review.staging, target);
  } catch (e: any) {
    if (backup) await fs.rename(backup, target).catch(() => {});
    return { ok: false, error: `تعذّر نقل الإضافة إلى مجلد الإضافات: ${String(e?.message ?? e).slice(0, 200)}` };
  }

  const market = await readMarket(userDataDir);
  market[review.slug] = {
    slug: review.slug,
    source: review.source.raw,
    installedAt: Date.now(),
    version: review.version,
    description: review.description,
    files: review.files,
    risk: review.risk,
    hash: review.hash,
  };
  await writeMarket(userDataDir, market);
  return { ok: true, dir: target, backup };
}

export async function listInstalled(userDataDir: string): Promise<InstalledRecord[]> {
  const market = await readMarket(userDataDir);
  const out = Object.values(market).sort((a, b) => b.installedAt - a.installedAt);
  // تحقق أن المجلدات ما زالت موجودة فعلاً
  const alive: InstalledRecord[] = [];
  for (const r of out) {
    const ok = await fs.stat(path.join(userDataDir, 'plugins', r.slug)).then((st) => st.isDirectory()).catch(() => false);
    if (ok) alive.push(r);
  }
  return alive;
}

/** يزيل إضافة مستخدم: نقل إلى سلة `.trash-…` داخل مجلد الإضافات (قابل للاسترجاع يدوياً) */
export async function removeInstall(slug: string, userDataDir: string): Promise<{ ok: boolean; error?: string; trashed?: string }> {
  const clean = String(slug ?? '').trim();
  if (!SLUG_RE.test(clean)) return { ok: false, error: 'اسم إضافة غير صالح.' };
  const dir = path.join(userDataDir, 'plugins', clean);
  const exists = await fs.stat(dir).then((st) => st.isDirectory()).catch(() => false);
  if (!exists) return { ok: false, error: `لا توجد إضافة مثبّتة بالاسم «${clean}».` };
  const trashed = path.join(userDataDir, 'plugins', `.trash-${clean}-${Date.now()}`);
  await fs.rename(dir, trashed);
  const market = await readMarket(userDataDir);
  delete market[clean];
  await writeMarket(userDataDir, market);
  return { ok: true, trashed };
}

/** تحديث إضافة مثبّتة: يُرجع المراجعة الجديدة للمقارنة (والتثبيت بـ--yes/force) */
export async function reviewUpdate(slug: string, userDataDir: string, opts: { gitTimeoutMs?: number } = {}): Promise<PluginReview | { ok: false; error: string }> {
  const market = await readMarket(userDataDir);
  const rec = market[String(slug ?? '').trim()];
  if (!rec) return { ok: false, error: `لا يوجد سجل تثبيت للاسم «${slug}» — الإضافات المنشأة يدوياً تُحدَّث يدوياً.` };
  return reviewInstall(rec.source, userDataDir, opts);
}

// ---------- عرض عربي ----------

const RISK_AR: Record<PluginReview['risk'], string> = { low: 'منخفض ✅', medium: 'متوسط ⚠️', high: 'خطير ⛔' };

export function formatReview(r: PluginReview): string {
  if (!r.ok) return `**تعذّرت المراجعة.** ${r.error ?? ''}`;
  const lines: string[] = [];
  lines.push(`#### مراجعة إضافة: ${r.name}${r.version ? ` · ${r.version}` : ''}`);
  lines.push('');
  lines.push(`**المصدر:** \`${r.source.raw}\``);
  if (r.description) lines.push(`**الوصف:** ${r.description}`);
  if (r.author) lines.push(`**المؤلف:** ${r.author}`);
  lines.push(`**الاسم المستخدم (slug):** \`${r.slug}\``);
  lines.push('');
  lines.push('| ما تحتويه | العدد |');
  lines.push('|---|---|');
  lines.push(`| ملفات | ${r.files} (${Math.round(r.bytes / 1024)} كB) |`);
  lines.push(`| مهارات | ${r.skills} |`);
  lines.push(`| hooks (أوامر تلقائية) | ${r.hooks.length} |`);
  lines.push(`| قواعد صلاحيات | سماح ${r.rules.allow.length} · سؤال ${r.rules.ask.length} · منع ${r.rules.deny.length} |`);
  lines.push(`| خوادم MCP | ${r.mcp.length} |`);
  lines.push('');
  if (r.hooks.length) {
    lines.push('**أوامر hooks التي ستعمل على جهازك:**');
    lines.push('');
    lines.push('```');
    for (const h of r.hooks.slice(0, 10)) lines.push(`[${h.phase}] ${h.matcher} ← ${h.command}`);
    lines.push('```');
    lines.push('');
  }
  if (r.mcp.length) {
    lines.push('**خوادم MCP:**');
    lines.push('');
    for (const s of r.mcp) lines.push(`- \`${s.name}\`: ${s.command} ${s.args.join(' ')}`.trim());
    lines.push('');
  }
  lines.push(`**تقييم المخاطر: ${RISK_AR[r.risk]}**`);
  lines.push('');
  for (const f of r.findings) lines.push(`- ${f.severity === 'high' ? '⛔' : f.severity === 'medium' ? '⚠️' : 'ℹ️'} ${f.text}`);
  lines.push('');
  if (r.changes.length) {
    lines.push('**مقارنة بالنسخة المثبّتة:**');
    for (const c of r.changes) lines.push(`- ${c}`);
    lines.push('');
  }
  lines.push('> التثبيت لا يُشغّل أي شيء من الإضافة: لا `npm install` ولا hooks — ننسخ الملفات فقط. الـ hooks تُنفَّذ لاحقاً عند استخدام الأدوات حسب قواعد المشروع، ويمكنك تعطيل الإضافة متى شئت.');
  lines.push('');
  lines.push(`للتثبيت: \`/plugins install ${r.source.raw} --yes\` · للإلغاء: \`/plugins install ${r.source.raw} --cancel\``);
  return lines.join('\n');
}

export function formatInstalled(list: InstalledRecord[]): string {
  if (!list.length) return 'لا إضافات مثبّتة من مصدر خارجي بعد. ثبّت واحدة بـ`/plugins install <رابط git>` (أو `/plugins new <اسم>` لقالب محلي).';
  const lines: string[] = ['| الإضافة | الإصدار | المصدر | تاريخ التثبيت | المخاطر |', '|---|---|---|---|---|'];
  for (const r of list) {
    lines.push(`| ${r.slug} | ${r.version || '—'} | \`${r.source.slice(0, 60)}\` | ${new Date(r.installedAt).toISOString().slice(0, 10)} | ${r.risk} |`);
  }
  return lines.join('\n');
}
