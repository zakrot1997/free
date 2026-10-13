// الفحص الأمني (/security): يفحص المشروع فحصاً حقيقياً بلا استهلاك نموذج —
// سرّية الملفات المتبعة، أسرار مكتوبة في الكود، أنماط خطرة، واعتماديات قديمة/مصابة.
// النتائج تُرتَّب بالخطورة وتُعرض بالعربية، ويمكن للوكيل بعدها إصلاح ما يقرره المستخدم.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { git } from './git';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  severity: Severity;
  /** عنوان قصير */
  title: string;
  file?: string;
  line?: number;
  /** ما وجدناه بالتحديد (مقتطف) */
  detail?: string;
  /** ماذا تفعل */
  fix: string;
  category: 'secrets' | 'files' | 'code' | 'deps' | 'git';
}

export interface SecurityReport {
  ok: boolean;
  findings: Finding[];
  scanned: { files: number; skipped: number };
  checks: { deps: boolean; git: boolean };
  text: string;
  counts: Record<Severity, number>;
  error?: string;
}

const SEV_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** أنماط الأسرار: مفاتيح ورمزات شائعة بأشكالها الحقيقية */
const SECRET_PATTERNS: { re: RegExp; title: string; severity: Severity }[] = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, title: 'مفتاح AWS', severity: 'high' },
  { re: /\bsk-[A-Za-z0-9]{20,}\b/, title: 'مفتاح OpenAI/Anthropic محتمل', severity: 'high' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, title: 'رمز GitHub', severity: 'high' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, title: 'رمز Slack', severity: 'high' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, title: 'مفتاح Google API', severity: 'high' },
  { re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, title: 'مفتاح خاص داخل الملف', severity: 'high' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, title: 'JWT مكشوف', severity: 'medium' },
  { re: /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*['"][^'"\n]{8,}['"]/i, title: 'كلمة مرور/مفتاح مكتوب صراحة', severity: 'medium' },
];

/** ملفات لا يجوز أن تكون متتبَّعة في git */
const SENSITIVE_FILES: { re: RegExp; title: string; severity: Severity; fix: string }[] = [
  { re: /(^|\/)\.env(\.|$)/, title: 'ملف .env متتبَّع في git', severity: 'high', fix: 'أضف .env إلى .gitignore، ثم أزل الملف من التتبّع: git rm --cached .env، ثم بدّل كل الأسرار التي فيه لأنها صارت في التاريخ.' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, title: 'مفتاح SSH خاص متتبَّع', severity: 'high', fix: 'أزل المفتاح من التتبّع فوراً: git rm --cached <الملف>، وأنشئ مفتاحاً جديداً — المفتاح المكشوف يُعد محروقاً.' },
  { re: /(^|\/)(credentials|secrets?)\.(json|ya?ml|txt)$/i, title: 'ملف أسرار متتبَّع', severity: 'high', fix: 'انقله خارج المستودع واستخدم متغيرات بيئة، وأزل الملف من التتبّع.' },
  { re: /(^|\/)\.npmrc$/, title: '.npmrc متتبَّع (قد يحوي رمز نشر)', severity: 'medium', fix: 'تأكد أنه بلا رموز؛ وإلا أزل التتبّع واستخدم مصادقة البيئة.' },
  { re: /\.(pem|key|p12|pfx)$/i, title: 'ملف مفاتيح/شهادة متتبَّع', severity: 'medium', fix: 'إن كان مفتاحاً خاصاً فأزله من التتبّع وبدّله.' },
  { re: /(^|\/)(\.aws|\.ssh|\.kube)(\/|$)/, title: 'مجلد إعدادات حساس متتبَّع', severity: 'medium', fix: 'أضفه إلى .gitignore وأزل ما تتبّع منه.' },
];

/** أنماط كود خطرة (نداءات تنفيذ، تعطيل تحقق TLS، SQL مركّب) */
const CODE_PATTERNS: { re: RegExp; title: string; severity: Severity; fix: string }[] = [
  { re: /\beval\s*\(/, title: 'استخدام eval', severity: 'medium', fix: 'استبدل eval بتحليل صريح (JSON.parse أو دالة مخصّصة) — eval ينفّذ أي نص يصل إليه.' },
  { re: /new\s+Function\s*\(/, title: 'new Function (تنفيذ نص)', severity: 'medium', fix: 'تجنّب بناء الدوال من نصوص قادمة من المستخدم.' },
  { re: /child_process[^\n]*\bexec\s*\(|\bexecSync\s*\(/, title: 'exec/execSync قد تقبل نصاً مركّباً', severity: 'medium', fix: 'استخدم execFile/spawn بوسائط منفصلة بدل تركيب نص أمر واحد.' },
  { re: /rejectUnauthorized\s*:\s*false/, title: 'تعطيل التحقق من شهادة TLS', severity: 'high', fix: 'أعد التحقق إلى true وأصلح سلسلة الشهادات بدلاً من تعطيلها.' },
  { re: /verify\s*=\s*False|ssl_verify\s*=\s*False/, title: 'تعطيل التحقق من TLS (بايثون)', severity: 'high', fix: 'أعد التحقق وثبّت CA المناسب.' },
  { re: /StrictHostKeyChecking=no/, title: 'تعطيل تحقق مفتاح SSH المضيف', severity: 'medium', fix: 'أزل الخيار وأضف مفتاح المضيف إلى known_hosts.' },
  { re: /(SELECT|INSERT|UPDATE|DELETE)[^;\n]{0,80}(\$\{|\+\s*req\.|\+\s*request\.|\+\s*params)/i, title: 'استعلام SQL مبني بتركيب نصي', severity: 'high', fix: 'استخدم استعلامات مُعاملة (placeholders/Bound Params) بدل دمج نص المستخدم.' },
  { re: /\bmkdtemp\s*\(/, title: 'مجلدات مؤقتة (تأكد من الصلاحيات)', severity: 'low', fix: 'تأكد أن المجلد المؤقت لا يُنشأ بصلاحيات مفتوحة، وأنك لا تثق بمحتواه.' },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'release', '.next', 'target', 'coverage', 'vendor', '__pycache__', '.venv', 'venv']);
const CODE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh', '.sql', '.yml', '.yaml', '.json', '.toml', '.ini', '.env', '.cfg', '.conf', '.tf', '.dockerfile', '.md', '.txt', '.gradle', 'dockerfile',
]);
const MAX_FILE = 1_500_000;
const MAX_FILES = 4000;

function isBinaryish(buf: Buffer): boolean {
  const n = Math.min(buf.length, 2000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function maskSecret(s: string): string {
  const t = s.trim();
  if (t.length <= 12) return '*'.repeat(t.length);
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/** يمرّ على ملفات المشروع (مع تجاهل مجلدات مبنية/ضخمة) ويجمع الملفات النصية */
async function collectFiles(root: string): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.env.local') {
        if (e.isDirectory()) continue;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        const base = e.name.toLowerCase();
        const rel = path.relative(root, abs).split(path.sep).join('/');
        // نُدرج أيضاً الملفات الحساسة بأي امتداد (id_rsa، credentials.json، …)
        if (base === 'dockerfile' || CODE_EXT.has(ext) || SENSITIVE_FILES.some((s) => s.re.test(rel))) out.push({ rel, abs });
      }
    }
  };
  await walk(root, 0);
  return out;
}

export interface SecurityOptions {
  /** فحص الاعتماديات (npm audit / outdated) — يمكن تعطيله لسرعة أكبر */
  deps?: boolean;
  signal?: AbortSignal;
  /** ملفات فحصها فقط (الافتراضي: كل المشروع) */
  only?: string[];
}

/** الفحص الرئيسي: ملفات + كود + git + اعتماديات */
export async function runSecurityScan(root: string, opts: SecurityOptions = {}): Promise<SecurityReport> {
  const findings: Finding[] = [];
  const files = opts.only?.length ? opts.only.map((rel) => ({ rel, abs: path.join(root, rel) })) : await collectFiles(root);
  let skipped = 0;

  // 1) أسرار وأنماط كود داخل الملفات
  for (const f of files) {
    if (opts.signal?.aborted) break;
    let buf: Buffer;
    try {
      const st = await fs.stat(f.abs);
      if (st.size > MAX_FILE) {
        skipped++;
        continue;
      }
      buf = await fs.readFile(f.abs);
    } catch {
      skipped++;
      continue;
    }
    if (isBinaryish(buf)) {
      skipped++;
      continue;
    }
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      for (const p of SECRET_PATTERNS) {
        const m = p.re.exec(line);
        if (m) {
          // نتجاهل الأمثلة الواضحة في التوثيق
          if (/example|sample|placeholder|your[-_ ]?(key|token)|xxxx|<.*>|\*{4,}/i.test(line)) continue;
          findings.push({
            severity: p.severity,
            title: p.title,
            file: f.rel,
            line: i + 1,
            detail: maskSecret(m[0]),
            fix: 'انقل القيمة إلى متغير بيئة (أو مدير أسرار)، وأبطل القيمة المكشوفة من مزوّدها — إبطال المفتاح أهم من حذف السطر.',
            category: 'secrets',
          });
        }
      }
      for (const p of CODE_PATTERNS) {
        if (p.re.test(line)) {
          if (/security\.ts|SECRET_PATTERNS|CODE_PATTERNS/.test(f.rel)) continue; // لا نُبلّغ عن ملف الفحص نفسه
          findings.push({ severity: p.severity, title: p.title, file: f.rel, line: i + 1, detail: line.trim().slice(0, 160), fix: p.fix, category: 'code' });
        }
      }
    }
  }

  // 2) ملفات حساسة موجودة في المشروع (سواء كانت متتبَّعة أم لا)
  const onDiskSensitive: { rel: string; title: string; severity: Severity; fix: string }[] = [];
  for (const f of files) {
    for (const s of SENSITIVE_FILES) {
      if (s.re.test(f.rel)) onDiskSensitive.push({ rel: f.rel, title: s.title, severity: s.severity, fix: s.fix });
    }
  }

  // 3) ملفات حساسة متتبَّعة في git
  let gitOk = false;
  const inRepo = await git(root, ['rev-parse', '--is-inside-work-tree'], 8000);
  if (inRepo.code === 0 && inRepo.stdout.trim() === 'true') {
    gitOk = true;
    const tracked = await git(root, ['ls-files'], 30_000);
    const list = tracked.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const trackedSet = new Set(list);
    for (const rel of list.slice(0, 20_000)) {
      for (const s of SENSITIVE_FILES) {
        if (s.re.test(rel)) findings.push({ severity: s.severity, title: s.title, file: rel, detail: 'متتبَّع في git', fix: s.fix, category: 'files' });
      }
    }
    // هل .gitignore موجود أصلاً؟
    if (!list.includes('.gitignore')) {
      const gi = await fs.access(path.join(root, '.gitignore')).then(() => true).catch(() => false);
      if (!gi) findings.push({ severity: 'low', title: 'لا يوجد ملف .gitignore', fix: 'أضف .gitignore يستثني node_modules وملفات البيئة والمفاتيح والبناء.', category: 'git' });
    }
    // أسرار في آخر 50 التزاماً (بحث عن مفاتيح أُضيفت ثم حُذفت)
    const grepLog = await git(root, ['log', '-p', '-n', '50', '--no-color', '--', ':(exclude)*.lock', ':(exclude)package-lock.json'], 60_000);
    if (grepLog.code === 0 && grepLog.stdout) {
      const hits = new Set<string>();
      for (const line of grepLog.stdout.split('\n')) {
        if (!line.startsWith('+')) continue;
        for (const p of SECRET_PATTERNS.slice(0, 6)) {
          const m = p.re.exec(line);
          if (m && !/example|xxxx|placeholder/i.test(line)) hits.add(`${p.title}: ${maskSecret(m[0])}`);
        }
      }
      for (const h of [...hits].slice(0, 5)) {
        findings.push({ severity: 'high', title: 'سرّ ظهر في تاريخ git', detail: h, fix: 'السرّ باقٍ في التاريخ حتى لو حُذف من الملف. أبطل القيمة، ثم نظّف التاريخ بـgit filter-repo إن كان المستودع مشتركاً.', category: 'secrets' });
      }
    }
  }

  // ملفات حساسة موجودة لكن غير متتبَّعة: خطر أقل (لا تُنسخ مع المستودع) لكنها تحتاج توضيح
  const reported = new Set(findings.filter((f) => f.category === 'files').map((f) => f.file));
  const trackedNow = new Set<string>();
  if (gitOk) {
    const tl = await git(root, ['ls-files'], 30_000);
    for (const l of tl.stdout.split('\n')) if (l.trim()) trackedNow.add(l.trim());
  }
  for (const d of onDiskSensitive) {
    if (reported.has(d.rel) || trackedNow.has(d.rel)) continue;
    findings.push({
      severity: d.severity === 'high' ? 'medium' : 'low',
      title: `${d.title} (غير متتبَّع)`,
      file: d.rel,
      detail: 'موجود في مجلد المشروع',
      fix: `${d.fix} تأكد أيضاً أنه في .gitignore حتى لا يُلتزم بالخطأ.`,
      category: 'files',
    });
  }

  // 4) الاعتماديات: ثغرات معروفة + قديمة
  let depsChecked = false;
  const pkgFile = path.join(root, 'package.json');
  const hasPkg = await fs.access(pkgFile).then(() => true).catch(() => false);
  if (opts.deps !== false && hasPkg && !opts.signal?.aborted) {
    depsChecked = true;
    const audit = await runNpm(root, ['audit', '--json'], 120_000);
    if (audit) {
      try {
        const j = JSON.parse(audit);
        const vulns = j.vulnerabilities ?? {};
        for (const [name, v] of Object.entries<any>(vulns)) {
          const sev: Severity = v.severity === 'critical' || v.severity === 'high' ? 'high' : v.severity === 'moderate' ? 'medium' : 'low';
          if (v.severity === 'info' || v.severity === 'low') continue;
          findings.push({
            severity: sev,
            title: `ثغرة معروفة في ${name}`,
            detail: `${v.via?.[0]?.title ?? v.via?.[0] ?? 'ثغرة'} · النطاق المصاب: ${v.range ?? '—'}`,
            fix: v.fixAvailable
              ? `الترقية متاحة: npm install ${name}@${typeof v.fixAvailable === 'object' ? v.fixAvailable.version : 'latest'} — شغّل npm audit fix للتحقق.`
              : 'لا إصلاح جاهز؛ حدّث الاعتمادية يدوياً أو عزلها في عملية منفصلة.',
            category: 'deps',
          });
        }
      } catch {
        /* مخرجات غير JSON: نتجاهل */
      }
    }
    const outdated = await runNpm(root, ['outdated', '--json'], 90_000);
    if (outdated) {
      try {
        const j = JSON.parse(outdated);
        const majors = Object.entries<any>(j).filter(([, v]) => {
          const cur = String(v.current ?? '');
          const latest = String(v.latest ?? '');
          return cur && latest && cur.split('.')[0] !== latest.split('.')[0];
        });
        for (const [name, v] of majors.slice(0, 8)) {
          findings.push({
            severity: 'low',
            title: `ترقية رئيسية متاحة: ${name}`,
            detail: `الحالي ${v.current} ← الأحدث ${v.latest}`,
            fix: 'راجع سجل تغييرات الحزمة قبل الترقية الرئيسية، ثم حدّث واختبر.',
            category: 'deps',
          });
        }
      } catch {
        /* لا مخرجات */
      }
    }
  }

  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    ok: counts.high === 0,
    findings,
    scanned: { files: files.length, skipped },
    checks: { deps: depsChecked, git: gitOk },
    counts,
    text: formatSecurityReport(findings, { files: files.length, skipped }, { deps: depsChecked, git: gitOk }),
  };
}

function runNpm(cwd: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('npm', args, { cwd, timeout, maxBuffer: 12 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } }, (err: any, stdout, stderr) => {
      const out = String(stdout ?? '').trim();
      // npm audit يعيد رمز خروج غير صفري عند وجود ثغرات — لكن مخرجاته صالحة
      if (out.startsWith('{')) return resolve(out);
      void err;
      void stderr;
      resolve(null);
    });
  });
}

const SEV_AR: Record<Severity, string> = { high: 'خطيرة', medium: 'متوسطة', low: 'منخفضة' };

export function formatSecurityReport(
  findings: Finding[],
  scanned: { files: number; skipped: number },
  checks: { deps: boolean; git: boolean },
): string {
  const counts: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  const head = [
    '# تقرير الفحص الأمني',
    `الملفات المفحوصة: ${scanned.files}${scanned.skipped ? ` (تُجوهل ${scanned.skipped} ملفاً ثنائياً/ضخماً)` : ''}`,
    `الاعتماديات: ${checks.deps ? 'فُحصت (npm audit + outdated)' : 'لم تُفحص'} · تاريخ git: ${checks.git ? 'فُحص' : 'لا مستودع'}`,
    counts.high ? `⚠️ ${counts.high} نتيجة خطيرة · ${counts.medium} متوسطة · ${counts.low} منخفضة` : `✅ لا نتائج خطيرة (${counts.medium} متوسطة · ${counts.low} منخفضة)`,
  ].join('\n');

  if (!findings.length) return `${head}\n\nلم أجد شيئاً يستحق التحذير في الأنماط التي أفحصها (أسرار، ملفات حساسة، أنماط كود خطرة، اعتماديات). هذا لا يعني ضماناً كاملاً — راجع منطق التطبيق يدوياً.`;

  const body = findings
    .map((f, i) => {
      const loc = f.file ? ` — ${f.file}${f.line ? `:${f.line}` : ''}` : '';
      const detail = f.detail ? `\n   التفصيل: ${f.detail}` : '';
      return `${i + 1}. [${SEV_AR[f.severity]}] ${f.title}${loc}${detail}\n   الإصلاح: ${f.fix}`;
    })
    .join('\n');

  return `${head}\n\n${body}`;
}

/** أنواع الملفات التي يفحصها الفحص (للاستخدام في الاختبارات والتوثيق) */
export const SCANNED_EXTENSIONS = [...CODE_EXT];
export const SKIPPED_DIRS = [...SKIP_DIRS];
