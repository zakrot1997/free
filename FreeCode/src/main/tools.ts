import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { listManagedProcesses, managedProcess, runShell, startManagedProcess, stopManagedProcess } from './shell';
import { MEMORY_REL, appendMemory } from './memory';
import { formatResults, performSearch, type SearchProvider } from './search';
import { gitTools } from './git';
import type { ToolSpec } from './llm';
import { diffLines, type DiffResult } from './diff';
import type { CheckpointStore } from './checkpoints';

export type ToolKind = 'read' | 'edit' | 'command';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'done';
}

export interface ToolContext {
  root: string;
  /** جذور قراءة إضافية (مهارات الإضافات والمستخدم) خارج مجلد المشروع */
  readRoots?: string[];
  signal?: AbortSignal;
  checkpoints?: CheckpointStore;
  /** بث مخرجات الأوامر مباشرة للواجهة */
  onOutput?: (chunk: string) => void;
  setTodos?: (todos: TodoItem[]) => void;
  /** يشغّل وكيلاً فرعياً للقراءة فقط ويعيد تقريره النهائي */
  runSubagent?: (prompt: string, onProgress: (line: string) => void) => Promise<string>;
  /** يشغّل وكلاء كاتبين بالتوازي في نسخ عمل معزولة ويعيد تقريراً */
  runDelegates?: (tasks: { label: string; task: string }[]) => Promise<string>;
  /** ذكاء الكود: تعريف/مراجع/تلميح/تشخيص عبر خادم لغة (LSP) مع بديل نصي */
  lsp?: {
    definition(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }>;
    references(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }>;
    hover(file: string, line: number, character: number): Promise<{ ok: boolean; text: string }>;
    diagnostics(file: string): Promise<{ ok: boolean; text: string }>;
    symbolFallback(name: string): Promise<string>;
  };
  /** وضع الحماية: يحوّل الأمر للتنفيذ داخل حاوية إن كان مفعّلاً */
  sandbox?: (command: string) => { command: string; sandboxed: boolean; note: string; fatal: boolean };
  /** قياس الموثوقية: كيف طُبّق التعديل فعلاً (تام/متسامح) */
  reportEdit?: (file: string, strategy: string, replacements: number) => void;
  /** إعدادات بحث الويب (من إعدادات المستخدم) */
  search?: { provider: SearchProvider; apiKey: string };
}

export type Preview =
  | { kind: 'diff'; path: string; isNew: boolean; diff: DiffResult }
  | { kind: 'command'; command: string; dangerous: boolean }
  | { kind: 'generic'; text: string };

export interface ToolDef {
  spec: ToolSpec;
  kind: ToolKind;
  /** أداة من خادم MCP: لا تشملها الموافقة التلقائية العامة ولا موافقة الدورة */
  mcp?: boolean;
  /** معاينة ما سيحدث قبل الموافقة (فرق الملف أو الأمر). قد ترمي خطأً إذا كانت الوسائط غير صالحة. */
  preview?(args: any, ctx: ToolContext): Promise<Preview>;
  run(args: any, ctx: ToolContext): Promise<string>;
}

const MAX_OUTPUT = 20_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '.next', '__pycache__', '.venv', 'build', 'target']);

function clip(s: string, keepTail = false): string {
  if (s.length <= MAX_OUTPUT) return s;
  return keepTail
    ? `…[تم اقتطاع ${s.length - MAX_OUTPUT} حرف من البداية]\n` + s.slice(-MAX_OUTPUT)
    : s.slice(0, MAX_OUTPUT) + `\n…[تم اقتطاع ${s.length - MAX_OUTPUT} حرف]`;
}

/** realpath متسامح: يعمل حتى لو لم يوجد الملف بعد، ويتتبع الروابط الرمزية المقطوعة */
function realpathLoose(p: string, depth = 0): string {
  if (depth > 20) return p;
  let cur = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fsSync.realpathSync(cur);
      return tail.length ? path.join(real, ...[...tail].reverse()) : real;
    } catch {
      /* غير موجود أو رابط مقطوع */
    }
    try {
      if (fsSync.lstatSync(cur).isSymbolicLink()) {
        const target = path.resolve(path.dirname(cur), fsSync.readlinkSync(cur));
        return realpathLoose(tail.length ? path.join(target, ...[...tail].reverse()) : target, depth + 1);
      }
    } catch {
      /* لا شيء */
    }
    const parent = path.dirname(cur);
    if (parent === cur) return p;
    tail.push(path.basename(cur));
    cur = parent;
  }
}

const escapes = (rel: string) => rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);

/** يمنع الخروج من مجلد العمل (مثل ../../etc/passwd) وكذلك عبر الروابط الرمزية */
export function resolveInside(root: string, p: unknown): string {
  if (typeof p !== 'string' || !p) throw new Error('المسار مطلوب');
  const abs = path.resolve(root, p);
  if (escapes(path.relative(root, abs))) throw new Error(`المسار خارج مجلد العمل: ${p}`);
  if (escapes(path.relative(realpathLoose(root), realpathLoose(abs)))) throw new Error(`المسار يشير خارج مجلد العمل عبر رابط رمزي: ${p}`);
  return abs;
}

/**
 * مثل resolveInside لكن يسمح أيضاً بجذور قراءة إضافية (مجلدات الإضافات ومهارات المستخدم)،
 * فالوكيل يحتاج فتح ملفات SKILL.md الموجودة خارج مجلد المشروع. الكتابة تبقى محصورة بالمشروع.
 */
export function resolveForRead(root: string, extra: string[] | undefined, p: unknown): string {
  try {
    return resolveInside(root, p);
  } catch (e) {
    if (!extra?.length || typeof p !== 'string' || !p) throw e;
    for (const base of extra) {
      try {
        return resolveInside(base, p.startsWith(base) ? path.relative(base, p) : p);
      } catch {
        /* جرّب الجذر التالي */
      }
    }
    throw e;
  }
}

const DANGEROUS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/,
  /\brm\s+-[a-zA-Z]*r\b.*\s(\/|~|\$HOME|\*)(\s|$)/,
  /\bsudo\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/(sd|nvme|disk)/,
  /:\(\)\s*\{/,
  /\bchmod\s+-R\s+7?77\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bgit\s+push\b.*(--force|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bformat\s+[a-zA-Z]:/i,
  /\bdel\s+\/[sfq]/i,
  /\bRemove-Item\b.*-Recurse/i,
];

/** أوامر لا تُنفَّذ تلقائياً حتى لو فعّل المستخدم الموافقة التلقائية. */
export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS.some((re) => re.test(cmd));
}

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

async function walk(dir: string, onFile: (file: string) => Promise<boolean | void>): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (await walk(path.join(dir, e.name), onFile)) return true;
    } else if (e.isFile()) {
      if ((await onFile(path.join(dir, e.name))) === true) return true;
    }
  }
  return false;
}

/** glob بسيط: ** يطابق أي عمق، * أي شيء ضمن المجلد، ? حرف واحد */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * استراتيجيات مطابقة `old_text`: التامة أولاً، ثم المتسامحة تدريجياً.
 * التسامح ضروري عملياً: النموذج ينسخ النص فيخطئ في المسافات أو نهايات الأسطر أو الإزاحة،
 * وبلا هذه المرونة يفشل التعديل ويستهلك دورة كاملة لإعادة القراءة (وهو أكثر أسباب الفشل شيوعاً).
 */
export type EditStrategy = 'exact' | 'line-endings' | 'trailing-ws' | 'indent';

const STRATEGY_NOTE: Record<EditStrategy, string> = {
  exact: '',
  'line-endings': ' (طُوبقت نهايات الأسطر تلقائياً)',
  'trailing-ws': ' (تجاهُل مسافات في نهاية الأسطر)',
  indent: ' (طُوبقت الإزاحة البادئة تلقائياً)',
};

const fileEol = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n');
const normEol = (s: string): string => s.replace(/\r\n/g, '\n');
const indentationOf = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/** بدايات الأسطر في النص الأصلي (للتبديل الموضعي دون إعادة بناء الملف كله) */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') out.push(i + 1);
  return out;
}

function shiftIndent(block: string, delta: string, remove: boolean): string {
  if (!delta) return block;
  return block
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      if (remove) {
        let rest = line;
        let left = delta.length;
        while (left > 0 && (rest.startsWith(' ') || rest.startsWith('\t'))) {
          rest = rest.slice(1);
          left--;
        }
        return rest;
      }
      return delta + line;
    })
    .join('\n');
}

export interface EditResult {
  text: string;
  strategy: EditStrategy;
  /** ملاحظة تُعرض للنموذج عند استخدام مطابقة متسامحة */
  note: string;
  replacements: number;
}

/**
 * يطبّق تعديلاً بنص قديم. يجرّب بالترتيب: مطابقة تامة → تطبيع نهايات الأسطر →
 * تجاهل مسافات نهاية السطر → مطابقة الكتلة مع تصحيح الإزاحة البادئة.
 * أي استراتيجية متسامحة يجب أن تُطابق موضعاً واحداً فقط (أو replace_all) لتفادي تعديل خاطئ.
 */
export function applyEditDetailed(text: string, oldRaw: string, newRaw: string, replaceAll = false): EditResult {
  if (!oldRaw) throw new Error('old_text فارغ');
  const eol = fileEol(text);

  // 1) مطابقة تامة
  const exactHits = text.split(oldRaw).length - 1;
  if (exactHits > 0) {
    if (exactHits > 1 && !replaceAll) throw new Error(`old_text يظهر ${exactHits} مرات؛ أضف سياقاً أكثر ليصبح فريداً، أو مرّر replace_all=true`);
    const out = replaceAll ? text.split(oldRaw).join(newRaw) : text.replace(oldRaw, () => newRaw);
    return { text: out, strategy: 'exact', note: '', replacements: exactHits };
  }

  // مطابقات سطرية متسامحة: نبني نسخة موحّدة نهايات الأسطر للمقارنة، ونبدّل موضعياً في النص الأصلي
  const hay = normEol(text).split('\n');
  const needle = normEol(oldRaw).split('\n');
  const newNorm = normEol(newRaw);
  const starts = lineStarts(text);
  const n = needle.length;

  const tryLines = (cmp: (a: string, b: string) => boolean, strategy: EditStrategy): EditResult | null => {
    const hits: number[] = [];
    for (let i = 0; i + n <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < n; j++) {
        if (!cmp(needle[j], hay[i + j])) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    if (!hits.length) return null;
    if (hits.length > 1 && !replaceAll) {
      throw new Error(`old_text يظهر ${hits.length} مرات (بمطابقة متسامحة)؛ أضف سياقاً أكثر ليصبح فريداً، أو مرّر replace_all=true`);
    }

    const at = hits[0];
    const from = starts[at];
    const to = at + n < starts.length ? starts[at + n] : text.length;

    let replacement = newNorm;
    if (strategy === 'indent') {
      const want = indentationOf(needle.find((l) => l.trim()) ?? '');
      const got = indentationOf(hay.slice(at, at + n).find((l) => l.trim()) ?? '');
      if (want !== got) {
        const extra = got.length >= want.length;
        const delta = extra ? got.slice(want.length) : want.slice(got.length);
        replacement = shiftIndent(replacement, delta, !extra);
      }
    }
    // الكتلة المُطابقة تمتد حتى بداية السطر التالي، أي أنها تشمل فاصل السطر الأخير إن وُجد؛
    // فعلينا إبقاء فاصل في نهاية البديل وإلا التصق بسطر لاحق.
    if (to > 0 && text[to - 1] === '\n' && !replacement.endsWith('\n')) replacement += '\n';
    if (eol !== '\n') replacement = replacement.replace(/\n/g, eol);

    return { text: text.slice(0, from) + replacement + text.slice(to), strategy, note: STRATEGY_NOTE[strategy], replacements: hits.length };
  };

  const rstrip = (l: string) => l.replace(/[ \t]+$/, '');
  return (
    tryLines((a, b) => a === b, 'line-endings') ??
    tryLines((a, b) => rstrip(a) === rstrip(b), 'trailing-ws') ??
    tryLines((a, b) => a.trim() === b.trim(), 'indent') ??
    (() => {
      throw new Error(
        'old_text غير موجود في الملف (جرّبت: المطابقة التامة، نهايات الأسطر، مسافات نهاية السطر، والإزاحة البادئة). اقرأ الملف مجدداً وانسخ النص بالضبط، أو استخدم سياقاً أقصر وأدق.',
      );
    })()
  );
}

function applyEdit(text: string, args: any): string {
  return applyEditDetailed(text, String(args.old_text ?? ''), String(args.new_text ?? ''), args.replace_all === true).text;
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  middot: '·',
  copy: '©',
};

/** يحوّل الكيانات الرقمية (&#160; و &#x27;) مع تجاهل القيم غير الصالحة */
const codePoint = (n: number): string => (Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&([a-z]+|#\d+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** يقرأ جسم الرد بحدّ أقصى من البايتات، فلا تستهلك صفحة ضخمة الذاكرة ولا السياق */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const declared = Number(res.headers.get('content-length'));
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  let truncated = Number.isFinite(declared) && declared > maxBytes;
  if (size >= maxBytes) {
    truncated = true;
    try {
      await reader.cancel();
    } catch {
      /* الأنبوب مغلق أصلاً */
    }
  }
  return { text: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'), truncated };
}

export const tools: ToolDef[] = [
  {
    kind: 'read',
    spec: spec('list_dir', 'اعرض محتويات مجلد داخل مشروع العمل.', { path: { type: 'string', description: 'مسار نسبي، "." للجذر' } }, ['path']),
    async run(args, ctx) {
      const dir = resolveForRead(ctx.root, ctx.readRoots, args.path ?? '.');
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(مجلد فارغ)';
    },
  },
  {
    kind: 'read',
    spec: spec(
      'read_file',
      'اقرأ ملفاً نصياً. يمكن تحديد نطاق أسطر بـ start_line و end_line (تبدأ من 1) وعندها تُرقَّم الأسطر.',
      { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
      ['path'],
    ),
    async run(args, ctx) {
      const file = resolveForRead(ctx.root, ctx.readRoots, args.path);
      const text = await fs.readFile(file, 'utf8');
      if (args.start_line || args.end_line) {
        const lines = text.split('\n');
        const s = Math.max(1, Number(args.start_line ?? 1) || 1);
        const e = Math.min(lines.length, Number(args.end_line ?? lines.length) || lines.length);
        // نطاق غير صالح (start > end أو بداية بعد نهاية الملف): نوضّح للنموذج بدل نص فارغ مربك
        if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return `نطاق أسطر غير صالح. الملف فيه ${lines.length} سطراً.`;
        return clip(lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join('\n'));
      }
      return clip(text);
    },
  },
  {
    kind: 'read',
    spec: spec(
      'glob',
      'ابحث عن ملفات بالاسم/النمط، مثل "**/*.ts" أو "src/**/test_*.py". يتجاهل node_modules و .git.',
      { pattern: { type: 'string' } },
      ['pattern'],
    ),
    async run(args, ctx) {
      const re = globToRegExp(String(args.pattern));
      const hits: string[] = [];
      let capped = false;
      await walk(ctx.root, async (file) => {
        const rel = path.relative(ctx.root, file).split(path.sep).join('/');
        // نمط بدون "/" يُطابَق على اسم الملف فقط
        const target = String(args.pattern).includes('/') ? rel : path.basename(rel);
        if (re.test(target)) {
          hits.push(rel);
          if (hits.length >= 200) {
            capped = true;
            return true;
          }
        }
      });
      if (!hits.length) return 'لا توجد ملفات مطابقة';
      // نُخبر النموذج أن القائمة اقتُطعت حتى يضيّق النمط بدل افتراض أنها كاملة
      return hits.join('\n') + (capped ? '\n…[توقف البحث عند 200 نتيجة؛ ضيّق النمط للمزيد]' : '');
    },
  },
  {
    kind: 'read',
    spec: spec(
      'search',
      'ابحث في محتوى الملفات عن نص أو تعبير نمطي (regex). اختيارياً قيّد البحث بمجلد أو بامتداد (include مثل "*.ts").',
      {
        pattern: { type: 'string' },
        path: { type: 'string', description: 'مجلد البحث، الافتراضي "."' },
        include: { type: 'string', description: 'نمط أسماء الملفات، مثل *.ts' },
      },
      ['pattern'],
    ),
    async run(args, ctx) {
      const base = resolveForRead(ctx.root, ctx.readRoots, args.path ?? '.');
      let re: RegExp;
      try {
        re = new RegExp(String(args.pattern));
      } catch {
        re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      const inc = args.include ? globToRegExp(String(args.include)) : null;
      const out: string[] = [];
      await walk(base, async (file) => {
        if (inc && !inc.test(path.basename(file))) return;
        const stat = await fs.stat(file);
        if (stat.size > 1_000_000) return;
        let text: string;
        try {
          text = await fs.readFile(file, 'utf8');
        } catch {
          return;
        }
        if (text.includes('\u0000')) return;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            out.push(`${path.relative(ctx.root, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (out.length >= 100) return true;
          }
        }
      });
      return out.join('\n') || 'لا توجد نتائج';
    },
  },
  {
    kind: 'edit',
    spec: spec(
      'write_file',
      'أنشئ ملفاً جديداً أو استبدل محتوى ملف موجود بالكامل. للتعديلات الصغيرة فضّل edit_file.',
      { path: { type: 'string' }, content: { type: 'string' } },
      ['path', 'content'],
    ),
    async preview(args, ctx) {
      const file = resolveInside(ctx.root, args.path);
      let old: string | null = null;
      try {
        old = await fs.readFile(file, 'utf8');
      } catch {
        old = null;
      }
      return { kind: 'diff', path: String(args.path), isNew: old === null, diff: diffLines(old ?? '', String(args.content ?? '')) };
    },
    async run(args, ctx) {
      const file = resolveInside(ctx.root, args.path);
      await ctx.checkpoints?.snapshot(ctx.root, file);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(args.content ?? ''), 'utf8');
      return `تمت الكتابة إلى ${args.path} (${String(args.content ?? '').length} حرف)`;
    },
  },
  {
    kind: 'edit',
    spec: spec(
      'edit_file',
      'عدّل ملفاً بواسطة استبدال نص محدد. old_text يجب أن يظهر مرة واحدة بالضبط (أو مرّر replace_all=true).',
      {
        path: { type: 'string' },
        old_text: { type: 'string' },
        new_text: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      ['path', 'old_text', 'new_text'],
    ),
    async preview(args, ctx) {
      const file = resolveInside(ctx.root, args.path);
      const text = await fs.readFile(file, 'utf8');
      return { kind: 'diff', path: String(args.path), isNew: false, diff: diffLines(text, applyEdit(text, args)) };
    },
    async run(args, ctx) {
      const file = resolveForRead(ctx.root, ctx.readRoots, args.path);
      const text = await fs.readFile(file, 'utf8');
      const r = applyEditDetailed(text, String(args.old_text ?? ''), String(args.new_text ?? ''), args.replace_all === true);
      ctx.reportEdit?.(String(args.path), r.strategy, r.replacements);
      await ctx.checkpoints?.snapshot(ctx.root, file);
      await fs.writeFile(file, r.text, 'utf8');
      return `تم التعديل في ${args.path}${r.note}`;
    },
  },
  {
    kind: 'command',
    spec: spec(
      'run_command',
      'نفّذ أمر shell داخل مجلد المشروع (المهلة 120 ثانية). استخدمه للبناء والاختبار وgit وتثبيت الحزم.',
      { command: { type: 'string' } },
      ['command'],
    ),
    async preview(args) {
      const command = String(args.command ?? '');
      return { kind: 'command', command, dangerous: isDangerousCommand(command) };
    },
    async run(args, ctx) {
      const raw = String(args.command);
      const prep = ctx.sandbox?.(raw);
      if (prep?.fatal) {
        // المستخدم طلب الحماية صراحةً ولا تتوفر: لا نخفض الحماية بصمت
        return `لم أنفّذ الأمر: ${prep.note}\nأخبر المستخدم بذلك، أو اقترح عليه تغيير وضع الحماية من الإعدادات (أو /sandbox on|off).`;
      }
      const r = await runShell(prep?.command ?? raw, {
        cwd: ctx.root,
        env: { ...process.env, FORCE_COLOR: '0', CI: '1' },
        timeoutMs: 120_000,
        signal: ctx.signal,
        onOutput: ctx.onOutput,
      });
      const head = prep?.sandboxed ? `[${prep.note}]\n` : '';
      return clip(`${head}exit code: ${r.timedOut ? 'timeout (120s)' : r.aborted ? 'aborted' : r.code}\n${r.output}`, true);
    },
  },
  {
    kind: 'read',
    spec: spec(
      'web_fetch',
      'اجلب صفحة ويب (http/https) وأعد نصها المقروء. مفيد لقراءة توثيق مكتبة.',
      { url: { type: 'string' } },
      ['url'],
    ),
    async run(args, ctx) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new Error('الرابط يجب أن يبدأ بـ http:// أو https://');
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      const onAbort = () => ctl.abort();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'FreeCode/0.4' } });
        // حدّ 512 كيلوبايت: يكفي للتوثيق، ويمنع صفحة ضخمة أو ملف ISO من استهلاك الذاكرة
        const { text: body, truncated } = await readBodyCapped(res, 512_000);
        const type = res.headers.get('content-type') ?? '';
        const text = /html/i.test(type) ? htmlToText(body) : body;
        const head = `HTTP ${res.status}${truncated ? ' (اقتُطع المحتوى عند 512KB)' : ''}`;
        return clip(`${head}\n${text}`);
      } finally {
        clearTimeout(t);
        ctx.signal?.removeEventListener('abort', onAbort);
      }
    },
  },
  {
    kind: 'read',
    spec: spec(
      'todo_write',
      'حدّث قائمة المهام المعروضة للمستخدم. استخدمها في المهام متعددة الخطوات: اكتب الخطوات أولاً ثم حدّث حالتها أثناء التقدم. أرسل القائمة كاملة في كل مرة.',
      {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } },
            required: ['content', 'status'],
          },
        },
      },
      ['todos'],
    ),
    async run(args, ctx) {
      const todos: TodoItem[] = (Array.isArray(args.todos) ? args.todos : []).map((t: any) => ({
        content: String(t.content ?? ''),
        status: t.status === 'done' || t.status === 'in_progress' ? t.status : 'pending',
      }));
      ctx.setTodos?.(todos);
      const done = todos.filter((t) => t.status === 'done').length;
      return `تم تحديث القائمة (${done}/${todos.length} مكتملة)`;
    },
  },
];

tools.push({
  kind: 'read',
  spec: spec(
    'task',
    'فوّض مهمة بحث أو استكشاف مستقلة إلى وكيل فرعي للقراءة فقط (يملك سياقاً نظيفاً خاصاً به). مثالي لأسئلة مثل "أين يُعالَج تسجيل الدخول؟" أو "لخّص هذه الوحدة" دون ملء سياقك بالملفات. يمكنك استدعاء task عدة مرات في نفس الدور ليعملوا بالتوازي. اكتب في prompt كل ما يحتاجه الوكيل لأنه لا يرى محادثتك، واطلب منه تقريراً مختصراً بمسارات الملفات والاستنتاجات.',
    { description: { type: 'string', description: 'عنوان قصير للمهمة' }, prompt: { type: 'string' } },
    ['prompt'],
  ),
  async run(args, ctx) {
    if (!ctx.runSubagent) throw new Error('الوكلاء الفرعيون غير متاحين هنا');
    return clip(await ctx.runSubagent(String(args.prompt ?? ''), (line) => ctx.onOutput?.(line)));
  },
});

tools.push({
  kind: 'edit',
  spec: spec(
    'delegate',
    'فوّض حتى 4 مهام تنفيذية (كتابة كود) إلى وكلاء متوازين مستقلين. يعمل كل وكيل في نسخة عمل معزولة (git worktree) على فرع خاص به، فلا يتعارضون ولا يلمسون ملفات المشروع حتى يوافق المستخدم على الدمج. استخدمه لمهام مستقلة يمكن تقسيمها (كل واحدة تلمس ملفات مختلفة عادة): مثلاً "أضف اختبارات للوحدة أ" و"حدّث التوثيق" و"أصلح تحذيرات الوحدة ب". لا تستخدمه للمهام المتسلسلة أو التي تلمس الملفات نفسها. اكتب لكل وكيل مهمة مكتفية بذاتها (لا يرى محادثتك).',
    {
      tasks: {
        type: 'array',
        description: 'المهام (واحدة إلى أربع)',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'عنوان قصير بالعربية (يُستخدم في اسم الفرع والبطاقة)' },
            task: { type: 'string', description: 'المهمة كاملة ومكتفية بذاتها' },
          },
          required: ['label', 'task'],
        },
      },
    },
    ['tasks'],
  ),
  async preview(args) {
    const tasks: any[] = Array.isArray(args.tasks) ? args.tasks : [];
    const lines = tasks.map((t: any, i: number) => `${i + 1}. ${String(t?.label ?? 'وكيل')}: ${String(t?.task ?? '').slice(0, 160)}`);
    return {
      kind: 'generic',
      text: `سأشغّل ${Math.min(tasks.length, 4)} وكيل في نسخ عمل معزولة (git worktree)، وكل واحد على فرع خاص:\n${lines.join('\n')}\n\nلن تُلمس ملفات مشروعك حتى تدمج ما تريد من لوحة «الوكلاء».`,
    };
  },
  async run(args, ctx) {
    if (!ctx.runDelegates) throw new Error('الوكلاء المتوازيون غير متاحين هنا');
    const tasks = (Array.isArray(args.tasks) ? args.tasks : [])
      .map((t: any) => ({ label: String(t?.label ?? 'وكيل').trim().slice(0, 60), task: String(t?.task ?? '').trim() }))
      .filter((t: { task: string }) => t.task);
    if (!tasks.length) throw new Error('tasks مطلوبة');
    return clip(await ctx.runDelegates(tasks.slice(0, 4)));
  },
});

// ---------- أدوات ذكاء الكود (LSP) ----------
// أداة واحدة لكل عملية، تستخدم خادم اللغة إن توفّر، وإلا تشرح البديل (أو تستخدم الفهرسة النصية).

tools.push(
  {
    kind: 'read',
    spec: spec(
      'code_definition',
      'اذهب إلى تعريف رمز: مرّر الملف والسطر والعمود (1-based). يعطي مواضع التعريف عبر خادم اللغة (LSP) بدقة الأنواع، وبلا خادم يبحث نصياً عن التعريف.',
      { path: { type: 'string' }, line: { type: 'integer' }, character: { type: 'integer' }, symbol: { type: 'string', description: 'اسم الرمز (للبديل النصي بلا خادم)' } },
      ['path'],
    ),
    async run(args, ctx) {
      if (!ctx.lsp) return 'ذكاء الكود غير متاح في هذا السياق.';
      const line = Math.max(1, Number(args.line) || 1);
      const ch = Math.max(1, Number(args.character) || 1);
      const r = await ctx.lsp.definition(String(args.path), line, ch);
      if (r.ok && !r.text.startsWith('لم أجد')) return r.text;
      const fallback = args.symbol ? await ctx.lsp.symbolFallback(String(args.symbol)) : '';
      return fallback ? `${r.text}\n\n(بلا خادم لغة — نتيجة الفهرسة النصية:)\n${fallback}` : r.text;
    },
  },
  {
    kind: 'read',
    spec: spec('code_references', 'اعرض كل مواضع استخدام رمز (مراجع) عبر خادم اللغة.', {
      path: { type: 'string' },
      line: { type: 'integer' },
      character: { type: 'integer' },
    }, ['path']),
    async run(args, ctx) {
      if (!ctx.lsp) return 'ذكاء الكود غير متاح في هذا السياق.';
      const r = await ctx.lsp.references(String(args.path), Math.max(1, Number(args.line) || 1), Math.max(1, Number(args.character) || 1));
      return r.text;
    },
  },
  {
    kind: 'read',
    spec: spec('code_hover', 'اعرض النوع/التوقيع عند موضع (كما يفعل تمرير المؤشر في المحرر).', {
      path: { type: 'string' },
      line: { type: 'integer' },
      character: { type: 'integer' },
    }, ['path']),
    async run(args, ctx) {
      if (!ctx.lsp) return 'ذكاء الكود غير متاح في هذا السياق.';
      const r = await ctx.lsp.hover(String(args.path), Math.max(1, Number(args.line) || 1), Math.max(1, Number(args.character) || 1));
      return r.text;
    },
  },
  {
    kind: 'read',
    spec: spec('code_diagnostics', 'أخطاء وتحذيرات الملف كما يراها خادم اللغة (أدق من البناء الكامل وسريع).', { path: { type: 'string' } }, ['path']),
    async run(args, ctx) {
      if (!ctx.lsp) return 'ذكاء الكود غير متاح في هذا السياق.';
      const r = await ctx.lsp.diagnostics(String(args.path));
      return r.text;
    },
  },
);

// ---------- أدوات إضافية: بحث الويب، الذاكرة، العمليات الخلفية، git ----------

tools.push(
  {
    kind: 'read',
    spec: spec(
      'web_search',
      'ابحث في الويب وأعد أهم النتائج (عنوان، رابط، مقتطف). استخدمه لمعرفة إصدار مكتبة أو واجهة حديثة أو حل خطأ، ثم web_fetch لقراءة الصفحة كاملة.',
      { query: { type: 'string' }, count: { type: 'integer', description: 'عدد النتائج (1-10، الافتراضي 5)' } },
      ['query'],
    ),
    async run(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query مطلوب');
      const res = await performSearch(query, {
        provider: ctx.search?.provider ?? 'auto',
        apiKey: ctx.search?.apiKey ?? '',
        count: Number(args.count) || 5,
        signal: ctx.signal,
      });
      return clip(formatResults(res));
    },
  },
  {
    kind: 'edit',
    spec: spec(
      'remember',
      `أضف ملاحظة دائمة إلى ذاكرة المشروع (${MEMORY_REL}) تُقرأ تلقائياً في كل محادثة. استخدمها لتفضيلات المستخدم وقرارات المشروع الثابتة (لغة، أسلوب، مكتبات ممنوعة، أوامر البناء) — لا تسجّل فيها تفاصيل مؤقتة أو ما هو موجود في الكود.`,
      { note: { type: 'string', description: 'الملاحظة، سطر أو سطران' } },
      ['note'],
    ),
    async preview(args) {
      return { kind: 'generic', text: `حفظ في ذاكرة المشروع:\n${String(args.note ?? '').slice(0, 500)}` };
    },
    async run(args, ctx) {
      const ok = await appendMemory(ctx.root, String(args.note ?? ''));
      return ok ? `حُفظت الملاحظة في ${MEMORY_REL}` : 'لم تُحفظ (نص فارغ أو مكرر حرفياً).';
    },
  },
  {
    kind: 'command',
    spec: spec(
      'start_process',
      'شغّل أمراً طويل الأمد في الخلفية (خادم تطوير، مراقب ملفات، قاعدة بيانات) وأعد معرّفه. لا تستخدمه لأوامر تنتهي سريعاً — لتلك استخدم run_command.',
      { command: { type: 'string' }, note: { type: 'string', description: 'وصف قصير للعملية' } },
      ['command'],
    ),
    async preview(args) {
      const command = String(args.command ?? '');
      return { kind: 'command', command, dangerous: isDangerousCommand(command) };
    },
    async run(args, ctx) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('command مطلوب');
      const prep = ctx.sandbox?.(command);
      if (prep?.fatal) return `لم أشغّل العملية: ${prep.note}`;
      const proc = startManagedProcess(prep?.command ?? command, { cwd: ctx.root, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
      await new Promise((r) => setTimeout(r, 1500)); // نلتقط مخرجات البدء أو فشلاً فورياً
      const p = managedProcess(proc.id);
      const out = (p?.output ?? '').slice(-2500);
      if (p && p.code !== null) return `انتهت العملية فوراً (code ${p.code}):\n${out}`;
      return `بدأت العملية في الخلفية [${proc.id}] PID ${proc.pid ?? '؟'}\nالمخرجات الأولى:\n${out || '(لا مخرجات بعد)'}\n\nتابع بـ process_output، وأوقفها بـ stop_process عند الانتهاء.`;
    },
  },
  {
    kind: 'read',
    spec: spec(
      'process_output',
      'اقرأ آخر مخرجات عملية خلفية شغّلتها بـ start_process (للتأكد أن خادم التطوير جاهز مثلاً).',
      { id: { type: 'string' }, tail_lines: { type: 'integer', description: 'آخر كم سطر (الافتراضي 200)' } },
      ['id'],
    ),
    async run(args) {
      const p = managedProcess(String(args.id ?? ''));
      if (!p) {
        const live = listManagedProcesses().filter((x) => x.code === null);
        return `لا عملية بالمعرّف "${args.id}".${live.length ? ` العمليات الجارية: ${live.map((x) => `${x.id} (${x.command.slice(0, 40)})`).join('، ')}` : ' لا عمليات خلفية.'}`;
      }
      const lines = Math.min(Math.max(20, Number(args.tail_lines) || 200), 2000);
      const tail = p.output.split('\n').slice(-lines).join('\n');
      const status = p.code === null ? 'تعمل' : `انتهت (code ${p.code})`;
      return `[${p.id}] ${p.command}\nالحالة: ${status}\nالمخرجات:\n${tail || '(لا مخرجات)'}`;
    },
  },
  {
    kind: 'command',
    spec: spec('stop_process', 'أوقف عملية خلفية شغّلتها بـ start_process (مثل خادم تطوير انتهيت منه).', { id: { type: 'string' } }, ['id']),
    async preview(args) {
      return { kind: 'command', command: `إيقاف العملية ${String(args.id ?? '')}`, dangerous: false };
    },
    async run(args) {
      const id = String(args.id ?? '');
      const p = managedProcess(id);
      if (!p) return `لا عملية بالمعرّف "${id}".`;
      if (p.code !== null) return `العملية ${id} انتهت بالفعل (code ${p.code}).`;
      return stopManagedProcess(id) ? `أُوقفت العملية ${id} (${p.command.slice(0, 60)}).` : `العملية ${id} انتهت بالفعل.`;
    },
  },
);

tools.push(...gitTools);

export const toolsByName = new Map(tools.map((t) => [t.spec.function.name, t]));

/** يبحث في الأدوات المدمجة ثم في الإضافية (MCP) */
export function lookupTool(name: string, extra: ToolDef[] = []): ToolDef | undefined {
  return toolsByName.get(name) ?? extra.find((t) => t.spec.function.name === name);
}

export function specsForMode(mode: 'plan' | 'act', extra: ToolDef[] = [], exclude: ReadonlySet<string> = new Set()): ToolSpec[] {
  return [...tools, ...extra]
    .filter((t) => (mode === 'act' || t.kind === 'read') && !exclude.has(t.spec.function.name))
    .map((t) => t.spec);
}
