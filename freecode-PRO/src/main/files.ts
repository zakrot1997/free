// عمليات الملفات الخاصة بالواجهة: شجرة الملفات، البحث السريع لـ @mentions، المعاينة، وإرفاق الملفات بالرسالة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { resolveInside } from './tools';

const HIDE = new Set(['node_modules', '.git', 'dist', 'release', '.next', '__pycache__', '.venv', 'build', 'target', '.DS_Store']);

export interface TreeEntry {
  name: string;
  path: string; // نسبي بفواصل /
  isDir: boolean;
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

export async function listDir(root: string, rel: string): Promise<TreeEntry[]> {
  const dir = resolveInside(root, rel || '.');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => !HIDE.has(e.name))
    .map((e) => ({ name: e.name, path: toRel(root, path.join(dir, e.name)), isDir: e.isDirectory() }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

let cache: { root: string; at: number; files: string[] } | null = null;

export async function allFiles(root: string, limit = 5000): Promise<string[]> {
  if (cache && cache.root === root && Date.now() - cache.at < 5000) return cache.files;
  const files: string[] = [];
  async function go(dir: string, depth: number): Promise<void> {
    if (files.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (HIDE.has(e.name) || files.length >= limit) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await go(p, depth + 1);
      else if (e.isFile()) files.push(toRel(root, p));
    }
  }
  await go(root, 0);
  cache = { root, at: Date.now(), files };
  return files;
}

/** بحث تقريبي: كل أحرف الاستعلام بالترتيب داخل المسار، مع ترجيح التطابق المتصل واسم الملف */
export async function searchFiles(root: string, query: string, max = 8): Promise<string[]> {
  const files = await allFiles(root);
  const q = query.toLowerCase();
  if (!q) return files.slice(0, max);
  const scored: [number, string][] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf('/') + 1);
    let score = -1;
    if (base === q) score = 1000;
    else if (base.startsWith(q)) score = 800 - base.length;
    else if (base.includes(q)) score = 600 - base.length;
    else if (lower.includes(q)) score = 400 - lower.length;
    else {
      let i = 0;
      for (const ch of lower) if (ch === q[i]) i++;
      if (i === q.length) score = 100 - lower.length;
    }
    if (score >= 0) scored.push([score, f]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, max).map((x) => x[1]);
}

export interface FilePreview {
  ok: boolean;
  text?: string;
  truncated?: boolean;
  binary?: boolean;
  error?: string;
}

export async function readPreview(root: string, rel: string, maxBytes = 300_000): Promise<FilePreview> {
  try {
    const abs = resolveInside(root, rel);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return { ok: false, error: 'ليس ملفاً' };
    const fh = await fs.open(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(stat.size, maxBytes));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.includes(0)) return { ok: true, binary: true };
      return { ok: true, text: buf.toString('utf8'), truncated: stat.size > maxBytes };
    } finally {
      await fh.close();
    }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * يلتقط إشارات @path في رسالة المستخدم ويُلحق محتوى الملفات الموجودة فعلاً.
 * يعيد النص المُجهّز للنموذج وقائمة الملفات المرفقة.
 */
export async function attachMentions(root: string, text: string): Promise<{ text: string; attached: string[] }> {
  const attached: string[] = [];
  const seen = new Set<string>();
  const blocks: string[] = [];
  let total = 0;
  for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
    const rel = m[1].replace(/[.,;:!?)\]}،؛؟]+$/, '');
    if (seen.has(rel) || attached.length >= 5) continue;
    seen.add(rel);
    try {
      const abs = resolveInside(root, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > 120_000 || total + stat.size > 240_000) continue;
      const content = await fs.readFile(abs, 'utf8');
      if (content.includes('\u0000')) continue;
      total += stat.size;
      attached.push(rel);
      blocks.push(`\n\n<attached_file path="${rel}">\n${content}\n</attached_file>`);
    } catch {
      /* ليس ملفاً صالحاً، نتجاهله */
    }
  }
  return { text: text + blocks.join(''), attached };
}

export interface CustomCommand {
  name: string;
  desc: string;
  prompt: string;
}

/** أوامر / مخصصة: ملفات markdown داخل .freecode/commands ، ويُستبدل $ARGUMENTS بنص المستخدم */
export async function listCustomCommands(root: string): Promise<CustomCommand[]> {
  const dir = path.join(root, '.freecode', 'commands');
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  for (const n of names.slice(0, 40)) {
    const name = n.slice(0, -3);
    if (!/^[\w-]+$/.test(name)) continue;
    try {
      const prompt = (await fs.readFile(path.join(dir, n), 'utf8')).trim().slice(0, 8000);
      if (!prompt) continue;
      const first = prompt.split('\n').find((l) => l.trim()) ?? '';
      out.push({ name, desc: first.replace(/^#+\s*/, '').slice(0, 70), prompt });
    } catch {
      /* ملف غير قابل للقراءة */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
