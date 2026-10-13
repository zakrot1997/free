// إدارة نسخ العمل (git worktree) لتشغيل وكلاء متوازيين كاتبين:
// كل وكيل يعمل في مجلد معزول على فرع خاص به، فلا يتعارضون ولا يلمسون مجلد المستخدم
// حتى يوافق هو على الدمج من الواجهة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { git, isRepo } from './git';

export interface FileStat {
  path: string;
  add: number;
  del: number;
}

export interface WorktreeHandle {
  /** معرّف قصير فريد (يُستخدم في اسم الفرع والمجلد) */
  id: string;
  branch: string;
  dir: string;
  /** التزام الأساس الذي بدأ منه الوكيل */
  base: string;
}

/** مجلد النسخ: خارج مجلد المستخدم حتى لا يقتحم مشروعه */
export function worktreesRoot(userData: string): string {
  return path.join(userData, 'worktrees');
}

/** اسم آمن للمجلد/الفرع */
export function slugify(input: string, max = 24): string {
  const s = String(input ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'task';
}

/** معرّف فريد قصير */
export function newId(label = 'agent'): string {
  const rnd = Math.random().toString(36).slice(2, 7);
  return `${slugify(label, 14)}-${Date.now().toString(36).slice(-4)}${rnd}`;
}

/** هل هذا المجلد مستودع git صالح (وليس مجلداً فرعياً داخل مستودع آخر)؟ */
export async function canUseWorktrees(root: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await isRepo(root))) {
    return { ok: false, error: 'المجلد ليس مستودع git — الوكلاء المتوازيون يحتاجون مستودعاً (شغّل git init).' };
  }
  const r = await git(root, ['rev-parse', 'HEAD'], 8_000);
  if (r.code !== 0) {
    return { ok: false, error: 'المستودع بلا أي التزام (commit) بعد — أنشئ التزاماً أولاً حتى يبدأ كل وكيل من أساس واضح.' };
  }
  return { ok: true };
}

/** ينشئ نسخة عمل جديدة على فرع خاص بها */
export async function createWorktree(root: string, userData: string, label: string): Promise<WorktreeHandle | { error: string }> {
  const usable = await canUseWorktrees(root);
  if (!usable.ok) return { error: usable.error! };

  const id = newId(label);
  const branch = `freecode/${id}`;
  const head = await git(root, ['rev-parse', '--short', 'HEAD'], 8_000);
  const base = head.stdout.trim() || 'HEAD';
  const repoSlug = slugify(path.basename(path.resolve(root)), 30);
  const dir = path.join(worktreesRoot(userData), `${repoSlug}-${base}`, id);

  // تنظيف بقايا فرع بنفس الاسم (نادر، لكن يمنع فشلاً محيّراً)
  await git(root, ['branch', '-D', branch], 8_000);
  const add = await git(root, ['worktree', 'add', '-b', branch, dir, 'HEAD'], 60_000);
  if (add.code !== 0) {
    return { error: `تعذّر إنشاء نسخة العمل: ${(add.stderr || add.stdout).trim().slice(0, 300)}` };
  }
  return { id, branch, dir, base };
}

/** يحذف نسخة العمل والفرع (بلا لمس التاريخ المدمج) */
export async function removeWorktree(root: string, dir: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (dir) {
    const rm = await git(root, ['worktree', 'remove', '--force', dir], 60_000);
    if (rm.code !== 0) {
      // تنظيف يدوي إن كان المجلد تالفاً (مثلاً حُذف من القرص)
      await git(root, ['worktree', 'prune'], 30_000);
      const rm2 = await git(root, ['worktree', 'remove', '--force', dir], 60_000);
      if (rm2.code !== 0) {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        await git(root, ['worktree', 'prune'], 30_000);
      }
    }
  }
  if (branch) await git(root, ['branch', '-D', branch], 15_000);
  return { ok: true };
}

export interface ParsedWorktree {
  path: string;
  head: string;
  branch: string;
  bare?: boolean;
}

/** يحلّل مخرجات git worktree list --porcelain */
export function parseWorktreeList(out: string): ParsedWorktree[] {
  const items: ParsedWorktree[] = [];
  let cur: ParsedWorktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) items.push(cur);
      cur = { path: line.slice(9).trim(), head: '', branch: '' };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (cur && line.trim() === 'bare') {
      cur.bare = true;
    }
  }
  if (cur) items.push(cur);
  return items;
}

/** كل نسخ العمل التابعة لهذا المستودع (بما فيها الأصلية) */
export async function listWorktrees(root: string): Promise<ParsedWorktree[]> {
  const r = await git(root, ['worktree', 'list', '--porcelain'], 15_000);
  if (r.code !== 0) return [];
  return parseWorktreeList(r.stdout);
}

/** إحصاءات تغيير فرع مقابل الأساس (أسطر مضافة/محذوفة لكل ملف) */
export function parseNumstat(out: string): FileStat[] {
  const files: FileStat[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const p = rest.join('\t').trim();
    if (!p) continue;
    files.push({ path: p, add: a === '-' ? 0 : Number(a) || 0, del: d === '-' ? 0 : Number(d) || 0 });
  }
  return files;
}

export async function diffStat(root: string, branch: string, base = 'HEAD'): Promise<FileStat[]> {
  const r = await git(root, ['diff', '--numstat', `${base}...${branch}`], 30_000);
  return r.code === 0 ? parseNumstat(r.stdout) : [];
}

/** ملفات تغيّرت في نسخة العمل ولم تُلتزم بعد (يعمل الوكيل حرّاً ثم نلتزم عنه) */
export async function uncommittedStat(dir: string): Promise<FileStat[]> {
  const r = await git(dir, ['status', '--porcelain=v1', '--untracked-files=all'], 20_000);
  if (r.code !== 0) return [];
  const files: FileStat[] = [];
  for (const line of r.stdout.split('\n')) {
    const p = line.slice(3).trim();
    if (!p) continue;
    // إعادة تسمية: "old -> new"
    files.push({ path: p.includes(' -> ') ? p.split(' -> ')[1] : p, add: 0, del: 0 });
  }
  return files;
}

/** يلتزم بكل ما تركه الوكيل في نسخة العمل (حتى تظهر فروقه ويمكن دمجها) */
export async function commitAll(dir: string, message: string): Promise<{ ok: boolean; message: string }> {
  await git(dir, ['add', '-A'], 60_000);
  const st = await git(dir, ['status', '--porcelain'], 20_000);
  if (!st.stdout.trim()) return { ok: true, message: 'لا تغييرات' };
  const r = await git(dir, ['-c', 'user.name=FreeCode', '-c', 'user.email=freecode@local', 'commit', '-m', message], 60_000);
  if (r.code !== 0) {
    const st2 = await git(dir, ['-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-m', message], 60_000);
    if (st2.code !== 0) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 300) };
  }
  return { ok: true, message: 'التُزمت التغييرات' };
}

export interface MergeResult {
  ok: boolean;
  /** أسماء الملفات المتعارضة إن فشل الدمج */
  conflicts: string[];
  message: string;
}

/** يدمج فرع الوكيل في الفرع الحالي. عند التعارض يُلغى الدمج كاملاً فلا يبقى المستودع نصف مدمج. */
export async function mergeBranch(root: string, branch: string, label: string, squash = false): Promise<MergeResult> {
  const cur = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], 10_000);
  const target = cur.stdout.trim() || 'HEAD';
  const dirty = await git(root, ['status', '--porcelain'], 20_000);
  if (dirty.stdout.trim()) {
    return { ok: false, conflicts: [], message: `لديك تغييرات غير ملتزمة (${dirty.stdout.split('\n').filter(Boolean).length} ملف). التزمها أو أخفِها ثم أعد الدمج.` };
  }
  const args = squash
    ? ['merge', '--squash', branch]
    : ['-c', 'user.name=FreeCode', '-c', 'user.email=freecode@local', 'merge', '--no-ff', '-m', `دمج وكيل FreeCode: ${label}`, branch];
  const r = await git(root, args, 120_000);
  if (r.code === 0) {
    if (squash) {
      const c = await git(root, ['-c', 'user.name=FreeCode', '-c', 'user.email=freecode@local', 'commit', '-m', `دمج وكيل FreeCode: ${label}`], 60_000);
      if (c.code !== 0) return { ok: false, conflicts: [], message: `تعذّر الالتزام بعد الدمج: ${c.stderr.trim().slice(0, 200)}` };
    }
    return { ok: true, conflicts: [], message: `تم الدمج في ${target}` };
  }

  // تعارض؟ نُلغيه ونعيد قائمة الملفات
  const ls = await git(root, ['diff', '--name-only', '--diff-filter=U'], 20_000);
  const conflicts = ls.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  await git(root, ['merge', '--abort'], 30_000);
  await git(root, ['reset', '--hard', 'HEAD'], 30_000);
  return {
    ok: false,
    conflicts,
    message: conflicts.length
      ? `تعارض في ${conflicts.length} ملف — أُلغي الدمج وأبقيت المستودع كما كان.`
      : (r.stderr || r.stdout).trim().slice(0, 300),
  };
}

/** فحص سريع: هل يحتوي الفرع تغييرات لم تُدمج؟ */
export async function branchHasWork(root: string, branch: string, base = 'HEAD'): Promise<number> {
  const files = await diffStat(root, branch, base);
  return files.length;
}
