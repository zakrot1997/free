// خريطة المستودع: تستخرج الرموز (دوال/أصناف/تصديرات) والاعتماديات بين الملفات،
// ثم ترتّب الملفات بأهميتها بترتيب الصفحات (PageRank) على رسم الاستيراد — كما تفعل Aider.
// تُضاف لرسالة النظام ضمن ميزانية محدودة، فيفهم الوكيل بنية المشاريع الكبيرة دون قراءتها كلها.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface FileMap {
  rel: string;
  symbols: string[];
  imports: string[];
  lines: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'release', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache', 'coverage', '.cache',
  'vendor', '.idea', '.vscode', 'Pods', '.gradle', '.terraform', 'site-packages',
]);

interface LangDef {
  exts: string[];
  symbols: RegExp[];
  imports: RegExp[];
}

const LANGS: LangDef[] = [
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'],
    symbols: [
      /^\s*export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:export\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
    ],
    imports: [/(?:from|import)\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g],
  },
  {
    exts: ['py'],
    symbols: [/^\s*(?:async\s+)?def\s+(\w+)/gm, /^\s*class\s+(\w+)/gm],
    imports: [/^\s*from\s+([\w.]+)\s+import/gm, /^\s*import\s+([\w.]+)/gm],
  },
  {
    exts: ['go'],
    symbols: [/^func\s+(?:\([^)]*\)\s*)?(\w+)/gm, /^type\s+(\w+)/gm],
    imports: [/^\s*(?:\w+\s+)?"([^"]+)"/gm],
  },
  {
    exts: ['rs'],
    symbols: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/gm, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/gm],
    imports: [/^\s*(?:pub\s+)?use\s+([\w:]+)/gm],
  },
  {
    exts: ['java', 'kt', 'kts', 'cs', 'scala', 'swift'],
    symbols: [
      /^\s*(?:public|private|protected|internal|open|final|abstract|\s)*\s*(?:class|interface|enum|record|struct|protocol|object|trait)\s+(\w+)/gm,
      /^\s*(?:public|private|protected|internal)\s+(?:static\s+|final\s+|override\s+|open\s+)*[\w<>[\],.\s?]+\s+(\w+)\s*\(/gm,
    ],
    imports: [/^\s*import\s+(?:static\s+)?([\w.]+)/gm],
  },
  {
    exts: ['rb'],
    symbols: [/^\s*(?:def|class|module)\s+([\w:]+)/gm],
    imports: [/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm],
  },
  {
    exts: ['php'],
    symbols: [/^\s*(?:abstract\s+|final\s+)?(?:class|interface|trait|function)\s+(\w+)/gim],
    imports: [/^\s*(?:use|require(?:_once)?|include(?:_once)?)\s+([^\s;]+)/gm],
  },
  {
    exts: ['c', 'h', 'cpp', 'cc', 'hpp'],
    symbols: [/^\s*(?:[\w:*&<>,\s]+?)\s+(\w+)\s*\([^;]*\)\s*(?:const\s*)?\{/gm, /^\s*(?:class|struct|enum)\s+(\w+)/gm],
    imports: [/#include\s+["<]([^">]+)[">]/g],
  },
];

const langOf = (ext: string): LangDef | undefined => LANGS.find((l) => l.exts.includes(ext));

const extOf = (rel: string): string => {
  const i = rel.lastIndexOf('.');
  return i < 0 ? '' : rel.slice(i + 1).toLowerCase();
};

const MAX_FILE_BYTES = 200_000;

/** يستخرج الرموز والاعتماديات من ملفات الكود تحت الجذر (يتجاهل المجلدات المولّدة والضخمة) */
export async function scanFiles(root: string, limit = 600): Promise<FileMap[]> {
  const out: FileMap[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= limit || depth > 12) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        const lang = langOf(ext);
        if (!lang) continue;
        let text: string;
        try {
          const st = await fs.stat(full);
          if (st.size > MAX_FILE_BYTES) continue;
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        const symbols: string[] = [];
        for (const re of lang.symbols) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) && symbols.length < 40) {
            if (m[1] && !symbols.includes(m[1])) symbols.push(m[1]);
          }
        }
        const imports: string[] = [];
        for (const re of lang.imports) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) && imports.length < 60) {
            if (m[1] && !imports.includes(m[1])) imports.push(m[1]);
          }
        }
        out.push({ rel: path.relative(root, full).split(path.sep).join('/'), symbols, imports, lines: text.split('\n').length });
      }
    }
  }

  await walk(root, 0);
  return out;
}

/** يحوّل مسار استيراد إلى مسار ملف معروف (للبناء على رسم الاعتماديات) */
export function resolveImport(fromRel: string, spec: string, known: Set<string>): string | null {
  const dir = path.posix.dirname(fromRel);

  if (spec.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(dir, spec));
    const tries = [
      base,
      `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`, `${base}.vue`, `${base}.svelte`,
      `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
    ];
    for (const t of tries) if (known.has(t)) return t;
    return null;
  }
  if (spec.includes('.') && !spec.includes('/')) {
    // بايثون: from pkg.mod import x  /  استيراد نمطي
    const py = spec.replace(/\./g, '/');
    for (const t of [`${py}.py`, `${py}/__init__.py`]) if (known.has(t)) return t;
  }
  if (spec.includes('/')) {
    for (const k of known) {
      if (k.endsWith(spec) || k.endsWith(`${spec}.ts`) || k.endsWith(`${spec}.py`) || k.endsWith(`${spec}.js`)) return k;
    }
  }
  return null;
}

/** ترتيب الملفات بأهميتها: PageRank على رسم «من يستورد من» */
export function rankFiles(files: FileMap[], iterations = 12): Map<string, number> {
  const known = new Set(files.map((f) => f.rel));
  const edges = new Map<string, string[]>();
  for (const f of files) {
    const targets: string[] = [];
    for (const spec of f.imports) {
      const t = resolveImport(f.rel, spec, known);
      if (t && t !== f.rel) targets.push(t);
    }
    edges.set(f.rel, targets);
  }

  const n = files.length;
  let rank = new Map<string, number>(files.map((f) => [f.rel, 1 / Math.max(1, n)]));
  const d = 0.85;
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>(files.map((f) => [f.rel, (1 - d) / Math.max(1, n)]));
    for (const f of files) {
      const targets = edges.get(f.rel) ?? [];
      if (!targets.length) continue;
      const share = (rank.get(f.rel) ?? 0) / targets.length;
      for (const t of targets) next.set(t, (next.get(t) ?? 0) + d * share);
    }
    rank = next;
  }
  return rank;
}

/** يبني نص خريطة المستودع ضمن ميزانية أحرف محددة */
export function formatMap(files: FileMap[], rank: Map<string, number>, maxChars = 4200): string {
  const ranked = [...files].sort((a, b) => (rank.get(b.rel) ?? 0) - (rank.get(a.rel) ?? 0));
  const lines: string[] = [];
  let used = 0;
  for (const f of ranked) {
    if (!f.symbols.length) continue;
    const syms = f.symbols.slice(0, 12).join(', ');
    const more = f.symbols.length > 12 ? `, +${f.symbols.length - 12}` : '';
    const line = `${f.rel} — ${syms}${more}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export interface RepoMapCache {
  root: string;
  at: number;
  text: string;
}

const TTL_MS = 30_000;

/**
 * خريطة المستودع مع تخزين مؤقت قصير: تُحسب مرة كل 30 ثانية كحد أقصى،
 * فيبقى أثرها على زمن الاستجابة ضئيلاً مع تغيّر الملفات أثناء العمل.
 */
export async function repoMap(root: string, cache: RepoMapCache | null, maxChars = 4200): Promise<{ text: string; cache: RepoMapCache | null; files: number }> {
  if (cache && cache.root === root && Date.now() - cache.at < TTL_MS) return { text: cache.text, cache, files: 0 };
  const files = await scanFiles(root);
  if (!files.length) return { text: '', cache: { root, at: Date.now(), text: '' }, files: 0 };
  const rank = rankFiles(files);
  const text = formatMap(files, rank, maxChars);
  return { text, cache: { root, at: Date.now(), text }, files: files.length };
}
