import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Agent, DEFAULT_OPTIONS, type AgentEvents, type AgentOptions } from './agent';
import { Telemetry } from './telemetry';
import type { LLMConfig } from './llm';
import { EVAL_TASKS, solutionFor, type EvalTask } from './evaltasks';

/**
 * «اختيار الموديل بالأرقام»: نشغّل مهام كود حقيقية على كل موديل متاح ونحكم
 * على النتيجة لا على الكلام. كل مهمة تبدأ بمشروع نظيف، وبعد انتهاء الموديل
 * نشغّل محاسباً مخفياً (خارج مجلد المشروع) يفحص السلوك فعلاً.
 *
 * كل هذا محلي: بلا إنترنت سوى خادم FreeLLMAPI عندك، وبلا رفع أي شيء لأي جهة.
 */

export interface ModelTarget {
  /** اسم للعرض في التقرير */
  label: string;
  cfg: LLMConfig;
}

export interface TaskOutcome {
  taskId: string;
  title: string;
  category: string;
  ok: boolean;
  /** سبب الفشل (فارغ عند النجاح) */
  reason: string;
  steps: number;
  tokens: number;
  durationMs: number;
  toolCalls: number;
  fuzzyEdits: number;
  /** هل انتهت الدورة بجواب نهائي أم بسقف خطوات/إيقاف */
  outcome: string;
}

export interface ModelReport {
  label: string;
  model: string;
  outcomes: TaskOutcome[];
  passed: number;
  total: number;
  durationMs: number;
  tokens: number;
  /** متوسط الخطوات في المهام الناجحة */
  stepsPerPass: number;
}

export interface EvalOptions {
  tasks?: EvalTask[];
  maxSteps?: number;
  /** زمن أقصى للمحاسب المخفي لكل مهمة */
  checkTimeoutMs?: number;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  agentOptions?: Partial<AgentOptions>;
}

/** المهمة الواحدة: مشروع مؤقت + وكيل + محاسب مخفي */
export async function runTaskForModel(target: ModelTarget, task: EvalTask, opts: EvalOptions = {}): Promise<TaskOutcome> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `freecode-eval-${task.id}-`));
  const checkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-eval-check-'));
  const telemetry = new Telemetry();
  let reason = '';
  let steps = 0;
  let tokens = 0;
  let durationMs = 0;
  let outcome = 'answer';
  let toolCalls = 0;

  try {
    for (const [rel, content] of Object.entries(task.files)) {
      const abs = path.join(ws, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    // مهام «من عطل المشروع» تبدأ بنسخة من المشروع الحقيقي (بلا node_modules الثقيل)
    if (task.copyFrom) await seedProject(task, ws);

    const agent = new Agent(target.cfg, ws, {
      ...DEFAULT_OPTIONS,
      mode: 'act',
      // في التقييم لا نزعج أحداً: الموافقات تمرّ تلقائياً، والتحقق التلقائي والخريطة معطّلان
      // لأننا نحاسب النتيجة النهائية بأنفسنا بمحاسب واحد موحّد لكل الموديلات.
      // (هذه القيم قبل الدمج أدناه عمداً: التجاوز الصريح عبر agentOptions يُحترم — وهو ما
      // يستخدمه A/B محاور السياق لقياس أثر repoMap/autoVerify نفسه.)
      autoApproveEdits: true,
      autoApproveCommands: true,
      autoVerify: false,
      repoMap: false,
      ...(opts.agentOptions ?? {}),
      maxSteps: task.maxSteps ?? opts.agentOptions?.maxSteps ?? opts.maxSteps ?? 12,
      searchProvider: 'duckduckgo',
    });
    agent.telemetry = telemetry;

    const ev: AgentEvents = {
      onText: () => {},
      onToolCall: () => {
        toolCalls++;
      },
      onToolOutput: () => {},
      onToolResult: () => {},
      approve: async () => true,
      onTodos: () => {},
      onUsage: () => {},
      onRetry: () => {},
      onChanges: () => {},
      onNotice: () => {},
    };

    const started = Date.now();
    try {
      await agent.run(task.prompt, ev, opts.signal);
    } catch (e: any) {
      reason = `انهيار أثناء التنفيذ: ${String(e?.message ?? e).slice(0, 160)}`;
    }
    durationMs = Date.now() - started;

    const turn = telemetry.events.filter((e) => e.kind === 'turn').slice(-1)[0];
    steps = Number(turn?.steps ?? 0);
    tokens = Number(turn?.tokens ?? 0);
    outcome = String(turn?.outcome ?? 'answer');

    // المحاسب المخفي: ملف خارج المشروع، يعمل داخل مجلد المشروع، ويحكم على السلوك
    if (!reason) {
      const res = await runTaskCheck(task, ws, opts.checkTimeoutMs ?? 60_000);
      if (!res.ok) reason = res.reason;
    }
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.rmSync(checkParent, { recursive: true, force: true });
  }

  return {
    taskId: task.id,
    title: task.title,
    category: task.category,
    ok: !reason,
    reason,
    steps,
    tokens,
    durationMs,
    toolCalls,
    fuzzyEdits: telemetry.events.filter((e) => e.kind === 'edit' && e.strategy !== 'exact').length,
    outcome,
  };
}


/** مجلدات لا تُنسخ في مهام المشروع (ثقيلة أو غير لازمة) */
const COPY_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.venv', 'target', 'release', '__pycache__']);

/**
 * يجهّز نسخة عمل من مشروع حقيقي: نسخ الملفات النصية + ربط node_modules رمزياً.
 * الربط الرمزي يجعل أدوات المشروع (tsc/jest/eslint) تعمل بلا نسخ مئات الميغابايت،
 * ومع ذلك يبقى تعديل الوكيل على نسخة معزولة لا تمسّ مشروع المستخدم.
 */
async function seedProject(task: EvalTask, ws: string): Promise<void> {
  const root = task.copyFrom!;
  const walk = async (rel: string, depth = 0): Promise<void> => {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 400)) {
      if (COPY_SKIP.has(e.name) || e.name.startsWith('.git')) continue;
      const relPath = rel ? path.join(rel, e.name) : e.name;
      const abs = path.join(root, relPath);
      const dest = path.join(ws, relPath);
      if (e.isDirectory()) await walk(relPath, depth + 1);
      else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(abs);
          if (st.size > 2 * 1024 * 1024) continue; // لا ننسخ ملفات ضخمة
          await fs.promises.copyFile(abs, dest);
        } catch {
          /* ملف غير قابل للقراءة */
        }
      }
    }
  };
  await fs.promises.mkdir(ws, { recursive: true });
  await walk('');
  if (task.linkNodeModules !== false) {
    try {
      await fs.promises.symlink(path.join(root, 'node_modules'), path.join(ws, 'node_modules'), 'junction');
    } catch {
      /* لا node_modules أو تعذّر الربط: الفحص سيخبرنا */
    }
  }
  // نقل أدوات المهام المشتركة (إن وُجدت) لا يلزم: المحاسب يقرأ من مشروعه الأصلي
}

export function runNodeCheck(script: string, cwd: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, reason: '' });
      const killed = (err as any)?.killed;
      const msg = (stderr || stdout || String((err as any)?.message ?? err)).replace(/\s+/g, ' ').trim().slice(0, 220);
      resolve({ ok: false, reason: killed ? `انتهت مهلة الفحص (${Math.round(timeoutMs / 1000)}ث)` : msg || 'فشل المحاسب' });
    });
  });
}

/** يشغّل بنك المهام على موديل واحد ويعيد تقريره */
export async function evalModel(target: ModelTarget, opts: EvalOptions = {}): Promise<ModelReport> {
  const tasks = opts.tasks ?? EVAL_TASKS;
  const outcomes: TaskOutcome[] = [];
  let i = 0;
  for (const task of tasks) {
    i++;
    opts.onProgress?.(`[${target.label}] ${i}/${tasks.length} — ${task.title}`);
    const o = await runTaskForModel(target, task, opts);
    outcomes.push(o);
    opts.onProgress?.(`[${target.label}] ${o.ok ? '✅' : '❌'} ${task.id}${o.ok ? '' : ` — ${o.reason}`} (${o.steps} خطوة · ${o.tokens} توكن)`);
    if (opts.signal?.aborted) break;
  }
  const passed = outcomes.filter((o) => o.ok).length;
  return {
    label: target.label,
    model: target.cfg.model,
    outcomes,
    passed,
    total: outcomes.length,
    durationMs: outcomes.reduce((a, o) => a + o.durationMs, 0),
    tokens: outcomes.reduce((a, o) => a + o.tokens, 0),
    stepsPerPass: passed ? Math.round((outcomes.filter((o) => o.ok).reduce((a, o) => a + o.steps, 0) / passed) * 10) / 10 : 0,
  };
}

/** يشغّل التقييم على عدة موديلات بالتسلسل (عدالة: نفس الظروف ونفس الترتيب) */
export async function evalModels(targets: ModelTarget[], opts: EvalOptions = {}): Promise<ModelReport[]> {
  const reports: ModelReport[] = [];
  for (const t of targets) {
    reports.push(await evalModel(t, opts));
    if (opts.signal?.aborted) break;
  }
  return reports;
}

/** الترتيب: نسبة النجاح ثم التوكنات الأقل ثم الزمن الأقل */
export function rankReports(reports: ModelReport[]): ModelReport[] {
  return [...reports].sort((a, b) => {
    const ra = a.total ? a.passed / a.total : 0;
    const rb = b.total ? b.passed / b.total : 0;
    if (rb !== ra) return rb - ra;
    if (a.tokens !== b.tokens) return a.tokens - b.tokens;
    return a.durationMs - b.durationMs;
  });
}

export interface Recommendation {
  label: string;
  why: string;
}

/** توصية مبنية على الأرقام: الأفضل نجاحاً، ثم الأقل استهلاكاً، مع تحذير صريح عند التعادل */
export function recommendModel(reports: ModelReport[]): Recommendation | null {
  if (!reports.length) return null;
  const ranked = rankReports(reports);
  const best = ranked[0];
  const rate = best.total ? Math.round((best.passed / best.total) * 100) : 0;
  if (best.passed === 0) {
    return {
      label: '',
      why:
        'لا موديل نجح في أي مهمة. هذا في الغالب خلل إعداد لا ضعف موديل: تحقّق من عنوان الخادم والمفتاح، ومن أن الموديل يعرف استدعاء الأدوات (tool calling) — راجع «أسباب الفشل» أدناه فهي تسمّي المشكلة بدقة.',
    };
  }
  if (ranked.length === 1) {
    return {
      label: best.label,
      why:
        `الموديل الوحيد الذي جُرّب: نجح في ${best.passed}/${best.total} (${rate}%) بمتوسط ${best.stepsPerPass} خطوة و${best.tokens} توكن.` +
        (best.passed === best.total ? ' نتيجة كاملة — قِس عليه الموديلات الأخرى لتعرف الفرق.' : ' جرّب موديلاً آخر للمقارنة، أو أعد التشغيل بمهام أسهل لتحديد مستوى الفشل.'),
    };
  }
  const same = ranked.filter((r) => r.passed === best.passed && r.total === best.total);
  if (same.length > 1) {
    const cheapest = [...same].sort((a, b) => a.tokens - b.tokens)[0];
    if (cheapest.label === best.label) {
      return {
        label: best.label,
        why: `الأعلى نجاحاً (${best.passed}/${best.total} · ${rate}%) والأقل استهلاكاً للتوكنات بين المتعادلين (${best.tokens} توكن · ${best.stepsPerPass} خطوة للمهمة الناجحة).`,
      };
    }
  }
  const second = ranked[1];
  const gap = second ? best.passed - second.passed : 0;
  return {
    label: best.label,
    why:
      `الأعلى نجاحاً: ${best.passed}/${best.total} (${rate}%)` +
      (gap > 0 && second ? ` — متقدّم على «${second.label}» بـ${gap} مهمة.` : ' — متعادل مع الأعلى نجاحاً لكنه أقل استهلاكاً (توكنات/زمن).') +
      ` استهلك ${best.tokens} توكن بمتوسط ${best.stepsPerPass} خطوة للمهمة الناجحة.`,
  };
}

/** صفوف مصفوفة النجاح: موديل × مهمة */
function matrix(reports: ModelReport[], tasks: string[]): string[] {
  const head = `| الموديل | ${tasks.map((t) => t.replace(/^(fix|implement|multi|write)-/, '')).join(' | ')} | النتيجة |`;
  const sep = `|---|${tasks.map(() => '---').join('|')}|---|`;
  const rows = reports.map((r) => {
    const cells = tasks.map((id) => {
      const o = r.outcomes.find((x) => x.taskId === id);
      if (!o) return '—';
      return o.ok ? '✅' : '❌';
    });
    return `| ${r.label} | ${cells.join(' | ')} | ${r.passed}/${r.total} |`;
  });
  return [head, sep, ...rows];
}

/** تقرير عربي كامل: جدول عام + مصفوفة مهام + توصية + ملاحظات */
export function formatEvalReport(reports: ModelReport[], opts: { tasksLabel?: string } = {}): string {
  if (!reports.length) return 'لا نتائج تقييم.';
  const ranked = rankReports(reports);
  const tasks = reports[0].outcomes.map((o) => o.taskId);
  const lines: string[] = [];
  lines.push(`### تقييم الموديلات على مهام كود حقيقية (${tasks.length} مهمة${opts.tasksLabel ? ` · ${opts.tasksLabel}` : ''})`);
  lines.push('');
  lines.push('| الموديل | نجاح | نسبة النجاح | توكنات | متوسط الخطوات (ناجحة) | الزمن |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of ranked) {
    lines.push(
      `| ${r.label} | ${r.passed}/${r.total} | ${r.total ? Math.round((r.passed / r.total) * 100) : 0}% | ${r.tokens} | ${r.stepsPerPass || '—'} | ${(r.durationMs / 1000).toFixed(1)}ث |`,
    );
  }
  lines.push('');
  lines.push('**تفصيل المهام لكل موديل:**');
  lines.push('');
  lines.push(...matrix(ranked, tasks));
  lines.push('');
  const rec = recommendModel(ranked);
  if (rec) lines.push(rec.label ? `**التوصية:** استخدم «${rec.label}» — ${rec.why}` : `**التوصية:** ${rec.why}`);
  const failing = ranked.flatMap((r) => r.outcomes.filter((o) => !o.ok).map((o) => ({ label: r.label, o })));
  if (failing.length) {
    lines.push('');
    lines.push('**أسباب الفشل (مفيدة لتحسين الإعداد أو نص المهمة):**');
    for (const f of failing.slice(0, 12)) lines.push(`- «${f.label}» × \`${f.o.taskId}\`: ${f.o.reason}`);
  }
  lines.push('');
  lines.push('> كل مهام التقييم محلية وبلا اعتمادات خارجية: تحتاج Node فقط. الحكم يأتي من محاسب مخفي يفحص سلوك الكود لا من كلام الموديل.');
  return lines.join('\n');
}

/** التقرير بصيغة JSON (للسكربتات ولوحات المتابعة) */
export function evalReportJson(reports: ModelReport[]): string {
  const ranked = rankReports(reports);
  return JSON.stringify({ generatedAt: Date.now(), ranked: ranked.map((r) => ({ ...r, rank: ranked.indexOf(r) + 1 })), recommendation: recommendModel(ranked) }, null, 2);
}

/** نتيجة فحص مهمة واحدة في فحص سلامة البنك */
export interface BankCheck {
  id: string;
  title: string;
  /** هل فشلت المهمة في حالتها الأولى (المطلوب: نعم) */
  startFails: boolean;
  /** هل نجحت بعد تطبيق الحل المرجعي (المطلوب: نعم) */
  solutionPasses: boolean;
  /** تفصيل عند الانحراف */
  note: string;
}

/**
 * فحص سلامة البنك: لكل مهمة نتحقق من شيئين —
 *  1) الحالة الأولى تفشل (وإلا فالمهمة مُهداة ولا تقيس شيئاً)
 *  2) الحل المرجعي ينجح (وإلا فالمهمة مستحيلة أو المحاسب معطوب)
 * هذا يجعل البنك قابلاً للتدقيق بدل الثقة العمياء.
 */
export async function verifyBank(tasks: EvalTask[] = EVAL_TASKS, timeoutMs = 60_000): Promise<BankCheck[]> {
  const out: BankCheck[] = [];
  for (const task of tasks) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `freecode-bank-${task.id}-`));
    const note: string[] = [];
    try {
      for (const [rel, content] of Object.entries(task.files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      }
      const start = await runTaskCheck(task, dir, timeoutMs);
      if (start.ok) note.push('المهمة تنجح في حالتها الأولى (لا تقيس شيئاً)');
      const solution = solutionFor(task.id);
      if (!solution) note.push('لا يوجد حل مرجعي لهذه المهمة');
      else {
        for (const [rel, content] of Object.entries(solution)) {
          const abs = path.join(dir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
        }
      }
      const after = solution ? await runTaskCheck(task, dir, timeoutMs) : { ok: false, reason: '' };
      if (!after.ok) note.push(`الحل المرجعي فشل: ${after.reason.slice(0, 160)}`);
      out.push({ id: task.id, title: task.title, startFails: !start.ok, solutionPasses: after.ok, note: note.join(' · ') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return out;
}

/** يُشغّل محاسب المهمة المخفي على مجلد مشروع (خارج المشروع نفسه) */
async function runTaskCheck(task: EvalTask, projectDir: string, timeoutMs: number): Promise<{ ok: boolean; reason: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freecode-eval-check-'));
  const file = path.join(dir, 'check.cjs');
  fs.writeFileSync(file, task.checkScript, 'utf8');
  try {
    return await runNodeCheck(file, projectDir, timeoutMs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatBankChecks(checks: BankCheck[]): string {
  const bad = checks.filter((c) => !c.startFails || !c.solutionPasses);
  const lines = [`فحص سلامة البنك: ${checks.length - bad.length}/${checks.length} مهمة سليمة`];
  for (const c of checks) {
    const flag = c.startFails && c.solutionPasses ? '✅' : '❌';
    lines.push(`${flag} ${c.id} — ${c.title}${c.note ? ` (${c.note})` : ''}`);
  }
  if (bad.length) lines.push(`⚠️ ${bad.length} مهمة تحتاج مراجعة`);
  return lines.join('\n');
}
