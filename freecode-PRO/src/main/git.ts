// أدوات git كأدوات مخصّصة (لا عبر run_command)، فيسري عليها نظام الصلاحيات والموافقات
// مثل بقية الأدوات، وتظهر بطاقة موافقة واضحة قبل أي التزام.
import { execFile } from 'node:child_process';
import type { ToolDef } from './tools';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** تشغيل git بلا shell (لا حقن أوامر ولا تفسير للرموز) */
export function git(root: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

const repoCache = new Map<string, { at: number; isRepo: boolean }>();

export async function isRepo(root: string): Promise<boolean> {
  const c = repoCache.get(root);
  if (c && Date.now() - c.at < 15_000) return c.isRepo;
  const r = await git(root, ['rev-parse', '--is-inside-work-tree'], 8_000);
  const isRepo = r.code === 0 && r.stdout.trim() === 'true';
  repoCache.set(root, { at: Date.now(), isRepo });
  return isRepo;
}

const NOT_REPO = 'هذا المجلد ليس مستودع git. لا تعتمد على أدوات git هنا؛ أخبر المستخدم أو استخدم أدوات الملفات.';
const clip = (s: string, max = 12_000): string => (s.length > max ? `${s.slice(0, max)}\n…[اقتُطع ${s.length - max} حرفاً]` : s);

function spec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDef['spec'] {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export const gitTools: ToolDef[] = [
  {
    kind: 'read',
    spec: spec('git_status', 'اعرض حالة git: الفرع والملفات المعدَّلة والمُجهّزة (git status --short --branch).', {}, []),
    async run(_args, ctx) {
      if (!(await isRepo(ctx.root))) return NOT_REPO;
      const r = await git(ctx.root, ['status', '--short', '--branch']);
      return clip(r.stdout.trim() || '(نظيف — لا تغييرات)');
    },
  },
  {
    kind: 'read',
    spec: spec(
      'git_diff',
      'اعرض فرق git للتغييرات غير المُلتزَم بها (أو المُجهّزة). استخدمه لمراجعة ما تغيّر قبل الالتزام أو لإعادة قراءة تعديل سابق.',
      { staged: { type: 'boolean', description: 'اعرض المُجهّز (--staged) بدل الحالي' }, path: { type: 'string', description: 'ملف أو مجلد محدّد' }, stat: { type: 'boolean', description: 'ملخّص إحصائي فقط (--stat)' } },
      [],
    ),
    async run(args, ctx) {
      if (!(await isRepo(ctx.root))) return NOT_REPO;
      const a = ['diff'];
      if (args.staged) a.push('--staged');
      if (args.stat) a.push('--stat');
      if (args.path) a.push('--', String(args.path));
      const r = await git(ctx.root, a, 20_000);
      return clip(r.stdout.trim() || '(لا فروق)');
    },
  },
  {
    kind: 'read',
    spec: spec('git_log', 'اعرض آخر الالتزامات (الهاش، الرسالة، الكاتب، التاريخ).', { limit: { type: 'integer', description: 'عدد الالتزامات (الافتراضي 15)' } }, []),
    async run(args, ctx) {
      if (!(await isRepo(ctx.root))) return NOT_REPO;
      const n = Math.min(Math.max(1, Number(args.limit) || 15), 50);
      const r = await git(ctx.root, ['log', `-${n}`, '--pretty=format:%h %ad %an: %s', '--date=short']);
      return clip(r.stdout.trim() || '(لا التزامات بعد)');
    },
  },
  {
    kind: 'edit',
    spec: spec(
      'git_commit',
      'أنشئ التزاماً (commit) واضح الصيغة. يجمع التغييرات المحدّدة أو كل التغييرات كما تطلب. لا ينفّذ push أبداً. اكتب رسالة موجزة بصيغة conventional commits (feat/fix/refactor/docs/test/chore).',
      {
        message: { type: 'string', description: 'رسالة الالتزام' },
        all: { type: 'boolean', description: 'أضف كل التغييرات المتابَعة والمعدَّلة (git add -u). الافتراضي: الملفات المذكورة في paths' },
        paths: { type: 'array', items: { type: 'string' }, description: 'ملفات لإضافتها ثم الالتزام بها' },
      },
      ['message'],
    ),
    async preview(args) {
      const msg = String(args.message ?? '').trim();
      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      const what = paths.length ? paths.join(' ') : args.all ? 'كل التغييرات المتابَعة' : 'المُجهّز حالياً';
      return { kind: 'command', command: `git commit -m "${msg}"  (${what})`, dangerous: false };
    },
    async run(args, ctx) {
      const msg = String(args.message ?? '').trim();
      if (!msg) return 'خطأ: رسالة الالتزام مطلوبة.';
      if (!(await isRepo(ctx.root))) return NOT_REPO;

      const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
      if (paths.length) {
        const add = await git(ctx.root, ['add', '--', ...paths]);
        if (add.code !== 0) return `خطأ في git add: ${(add.stderr || add.stdout).trim()}`;
      } else if (args.all) {
        const add = await git(ctx.root, ['add', '-u']);
        if (add.code !== 0) return `خطأ في git add -u: ${(add.stderr || add.stdout).trim()}`;
      }

      const staged = await git(ctx.root, ['diff', '--cached', '--name-only']);
      if (!staged.stdout.trim()) {
        return 'لا توجد تغييرات مُجهّزة للالتزام. أضف ملفات بـ paths أو all=true، أو تحقق من git_status.';
      }
      const r = await git(ctx.root, ['commit', '-m', msg]);
      if (r.code !== 0) return `خطأ في الالتزام: ${(r.stderr || r.stdout).trim().slice(0, 500)}`;
      const files = staged.stdout.trim().split('\n').length;
      const first = r.stdout.trim().split('\n')[0] ?? '';
      return `تم الالتزام (${files} ملفاً): ${first}`;
    },
  },
  {
    kind: 'edit',
    spec: spec(
      'git_branch',
      'أنشئ فرعاً جديداً أو بدّل إلى فرع (git switch). مفيد لعزل عمل الوكيل قبل الدمج.',
      { name: { type: 'string' }, create: { type: 'boolean', description: 'أنشئ الفرع إن لم يوجد (-c)' } },
      ['name'],
    ),
    async preview(args) {
      return { kind: 'command', command: `git switch ${args.create ? '-c ' : ''}${String(args.name ?? '')}`, dangerous: false };
    },
    async run(args, ctx) {
      const name = String(args.name ?? '').trim();
      if (!/^[\w.\-/]+$/.test(name)) return 'خطأ: اسم فرع غير صالح.';
      if (!(await isRepo(ctx.root))) return NOT_REPO;
      const r = await git(ctx.root, args.create ? ['switch', '-c', name] : ['switch', name]);
      if (r.code !== 0) return `خطأ: ${(r.stderr || r.stdout).trim().slice(0, 400)}`;
      return `تم التبديل إلى الفرع: ${name}`;
    },
  },
];

/** يلتزم تلقائياً بتغييرات الوكيل إن فعّل المستخدم الخيار (كأسلوب Aider) */
export async function autoCommit(root: string, summary: string): Promise<string | null> {
  if (!(await isRepo(root))) return null;
  const status = await git(root, ['status', '--porcelain']);
  const changed = status.stdout.trim();
  if (!changed) return null;
  await git(root, ['add', '-A']);
  const msg = summary.replace(/\s+/g, ' ').trim().slice(0, 72) || 'freecode: تحديث آلي';
  const r = await git(root, ['commit', '-m', msg]);
  if (r.code !== 0) return null;
  const n = changed.split('\n').length;
  return `التزام تلقائي (${n} ملفاً): ${msg}`;
}
