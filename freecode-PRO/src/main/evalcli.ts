#!/usr/bin/env node
// «اختيار الموديل بالأرقام» — يعمل من سطر الأوامر بلا واجهة:
//   freecode-eval --models "freellmapi/auto,gpt-oss-120b" 
//   freecode-eval --models a,b --quick --out تقرير.md
//   freecode-eval --list
//
// يقيس كل موديل على بنك مهام كود حقيقية بمحاسب آلي لا بكلام الموديل.
import fs from 'node:fs';
import path from 'node:path';
import { evalModels, formatEvalReport, evalReportJson, formatBankChecks, verifyBank, type ModelTarget } from './modeleval';
import { EVAL_TASKS, quickTasks, taskById, formatTaskBank, type EvalTask } from './evaltasks';
import { normalizeBaseUrl } from './llm';
import { formatProjectTaskSet, projectTasksFromEvents } from './projecteval';
import { CONTEXT_AXES, axisSweepArchiveEntry, axisSweepJson, compareAxisSweep, contextAxisSweep, formatAbReport, formatAxisSweep, formatAxisSweepReadme, sweepVerifyCoverage, abReportJson, readVariant, runAbTest, taskFromPrompt, type ContextAxis } from './abtest';
import { abBadgeData, abBadgePng, abCardHtml, ctxSweepBadgePng, evalBadgeData, evalBadgePng, evalCardHtml, shareBadgePng } from './share';
import { Telemetry } from './telemetry';
import { formatSweepTimeline, loadSweepConfig, parseSweepConfig, pickVerifyCommand, readSweepArchive, sweepArchivePath, sweepConfigHash, sweepConfigPath, sweepConfigTemplate, sweepSignature, sweepTimeline, verifySourceLabel } from './sweepconfig';
import { detectVerify } from './verify';
import { userDataDir } from './cli';
import { FREECODE_DIR, ensureFreecodeIgnored } from './fcignore';

interface Args {
  models: string[];
  baseUrl: string;
  apiKey: string;
  tasks: string[];
  quick: boolean;
  json: boolean;
  out?: string;
  list: boolean;
  verifyBank: boolean;
  maxSteps?: number;
  help: boolean;
  fromProject?: string;
  listProject: boolean;
  ab?: string;
  prompt?: string;
  repeat: number;
  share?: string;
  outDir?: string;
  png?: string;
  ctxSweep: boolean;
  full: boolean;
  /** محاور الجرد المختارة (فارغ = كل المحاور) */
  axes: string;
  /** ملف ملصق PNG للجرد */
  badge?: string;
  /** أرشفة الجرد في .freecode/ctx-sweep.jsonl */
  save: boolean;
  /** مقارنة الجرد الحالي بآخر جرد محفوظ */
  compare: boolean;
  /** ملصق مربع 1080×1080 */
  square: boolean;
  /** ملف إعداد الجرد (افتراضياً .freecode/sweep.json في مجلد العمل) */
  config?: string;
  /** كتابة كتلة README المولَّدة آلياً */
  tableOut?: string;
  /** إنشاء ملف إعداد أولي */
  initSweep: boolean;
  /** أمر الفحص الحقيقي لمحور autoVerify (يتقدم على الإعداد والمكتشف) */
  verifyCmd?: string;
  /** طباعة السلسلة الزمنية لكل (موديل × محور) من كل الجردات المحفوظة */
  timeline: boolean;
}

const HELP = `اختيار الموديل بالأرقام (FreeCode)

الاستخدام:
  freecode-eval --models "موديل1,موديل2" [خيارات]

الخيارات:
      --models <قائمة>   الموديلات مفصولة بفواصل (إلزامي). لمقارنة خوادم مختلفة:
                         الاسم@العنوان — مثال: "نموذج1,نموذج2@http://127.0.0.1:41802"
      --base-url <عنوان> عنوان خادم متوافق مع OpenAI (افتراضي: http://127.0.0.1:31415 أو FREECODE_BASE_URL)
      --api-key <مفتاح>  المفتاح (أو FREECODE_API_KEY)
      --tasks <قائمة>    مهام محددة بالمعرّف (مثال: fix-off-by-one,write-tests)
      --quick            ثلاث مهام سريعة فقط
      --max-steps <n>    أقصى خطوات لكل مهمة (افتراضي: حسب المهمة)
      --json             أخرج النتائج JSON
      --out <ملف>        احفظ التقرير في ملف (Markdown افتراضاً، أو .json)
      --list             اعرض بنك المهام ومعايير القبول ثم اخرج
      --verify-bank      فحص سلامة البنك: كل مهمة تفشل قبل الحل وتنجح بعده
                         (مع --tasks: مهام محددة فقط — فحص سريع)
      --from-project <د> ابنِ المهام من أعطال مشروعك الحقيقية (سجل الموثوقية) في الدليل <د>
      --list-from-project أعرض فقط المهام المستخرجة من أعطال المشروع دون تقييم
      --ab <ملف1,ملف2>   قارن نسختين من ملف التعليمات على نفس المهام ونفس الموديل
      --prompt <نص>      مع --ab: مهمة حرة تُقاس في مشروعك بدل البنك
      --repeat <n>       مع --ab: عدد التكرارات لكل (مهمة × نسخة) — 1 إلى 3
      --share <ملف.json> بطاقة نتائج HTML قابلة للمشاركة من تقرير محفوظ (أرقام فقط)
      --png <ملف>        مع --share: احفظ ملصق PNG (صورة جاهزة للنشر) — أو بجانب --out تلقائياً
      --square           مع --share/--badge: مقاس مربع 1080×1080 (أفاتار وشبكات)
      --ctx-sweep        جرد محاور السياق: كل موديل × محاور repoMap/autoVerify/budget/memory
                         ويُنتج جدولاً وخلاصة جاهزين للتوثيق — يُنصح مع --from-project
      --axes <قائمة>     مع --ctx-sweep: محاور محددة مثل repoMap,budget (الافتراضي: الكل)
      --badge <ملف.png>  مع --ctx-sweep: احفظ ملصق PNG لنتيجة الجرد
      --save             مع --ctx-sweep: أرشف الجرد في .freecode/ctx-sweep.jsonl
      --compare          مع --ctx-sweep: اطبع ما تغيّر منذ آخر جرد محفوظ
      --config <ملف>     مع --ctx-sweep: اقرأ الموديلات والمحاور من ملف (افتراضياً .freecode/sweep.json في مجلد العمل)
      --table-out <ملف>  مع --ctx-sweep: اكتب كتلة ماركداون جاهزة للصق في README
      --init-sweep       اكتب ملف إعداد أولي (.freecode/sweep.json) عدّله بأسماء موديلاتك
      --verify-cmd <أمر> مع --ctx-sweep: أمر الفحص الحقيقي لمحور autoVerify (وإلا يُكتشف تلقائياً)
      --timeline         اطبع سلسلة الانحدارات من كل الجردات المحفوظة
                         (وحده بلا موديلات وبلا أعلام حفظ/مقارنة = عرض الأرشيف فقط بلا قياس جديد)
      --full             مع --ctx-sweep: البنك الكامل بدل المجموعة السريعة
      --out-dir <مجلد>   احفظ حزمة النتائج (تقرير md + json + ملصق png) في مجلد
  -h, --help             هذه المساعدة
`;

function parse(argv: string[]): Args {
  const a: Args = { models: [], baseUrl: process.env.FREECODE_BASE_URL ?? 'http://127.0.0.1:31415', apiKey: process.env.FREECODE_API_KEY ?? '', tasks: [], quick: false, json: false, list: false, verifyBank: false, listProject: false, repeat: 1, help: false, ctxSweep: false, full: false, axes: '', save: false, compare: false, square: false, initSweep: false, verifyCmd: undefined, timeline: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    const next = (): string => argv[++i] ?? '';
    if (x === '--models') a.models.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (x === '--base-url') a.baseUrl = next();
    else if (x === '--api-key') a.apiKey = next();
    else if (x === '--tasks') a.tasks.push(...next().split(',').map((s) => s.trim()).filter(Boolean));
    else if (x === '--max-steps') a.maxSteps = Number(next());
    else if (x === '--out') a.out = next();
    else if (x === '--quick') a.quick = true;
    else if (x === '--json') a.json = true;
    else if (x === '--list') a.list = true;
    else if (x === '--verify-bank') a.verifyBank = true;
    else if (x === '--from-project') a.fromProject = next();
    else if (x === '--list-from-project') {
      a.fromProject = next() || '.';
      a.listProject = true;
    }
    else if (x === '--ab') a.ab = next();
    else if (x === '--prompt') a.prompt = next();
    else if (x === '--repeat') a.repeat = Math.max(1, Math.min(3, Number(next()) || 1));
    else if (x === '--share') a.share = next();
    else if (x === '--out-dir') a.outDir = next();
    else if (x === '--png') a.png = next();
    else if (x === '--ctx-sweep') a.ctxSweep = true;
    else if (x === '--full') a.full = true;
    else if (x === '--axes') a.axes = next();
    else if (x === '--badge') a.badge = next();
    else if (x === '--save') a.save = true;
    else if (x === '--compare') a.compare = true;
    else if (x === '--square') a.square = true;
    else if (x === '--config') a.config = next();
    else if (x === '--table-out') a.tableOut = next();
    else if (x === '--init-sweep') a.initSweep = true;
    else if (x === '--verify-cmd') a.verifyCmd = next();
    else if (x === '--timeline') a.timeline = true;
    else if (x === '-h' || x === '--help') a.help = true;
  }
  return a;
}

// الأنابيب: لا نُسقط العملية بخطأ EPIPE إذا أُغلق القارئ (مثل `| head`)
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => {});

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.list) {
    process.stdout.write(`\nبنك مهام التقييم (${EVAL_TASKS.length} مهمة) — معايير القبول هي ما يفحصه المحاسب المخفي فعلاً:\n\n`);
    process.stdout.write(formatTaskBank() + '\n\n');
    return;
  }
  if (args.initSweep) {
    const file = args.config ? path.resolve(args.config) : sweepConfigPath(process.cwd());
    if (fs.existsSync(file)) {
      process.stderr.write(`الملف موجود مسبقاً: ${file} — احذفه أو استخدم --config <مسار آخر>\n`);
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (path.dirname(file) === path.join(process.cwd(), FREECODE_DIR)) ensureFreecodeIgnored(process.cwd());
    fs.writeFileSync(file, sweepConfigTemplate(), 'utf8');
    process.stdout.write(`\nأُنشئ ملف إعداد الجرد: ${file}\nعدّل «models» بأسماء موديلاتك ثم شغّل:\n  freecode-eval --ctx-sweep --save\n`);
    return;
  }
  if (args.verifyBank) {
    // --tasks يقتصر على مهام محددة (فحص سريع أثناء التطوير)؛ وبلا --tasks يُفحص البنك كله
    const picked = args.tasks.map((id) => taskById(id)).filter((t): t is EvalTask => !!t);
    const unknown = args.tasks.filter((id) => !taskById(id));
    if (unknown.length) {
      process.stderr.write(`معرّفات غير موجودة في بنك المهام: ${unknown.join(', ')}\n  اعرض المعرّفات بـ --list\n`);
      process.exit(2);
    }
    const bank = picked.length ? picked : EVAL_TASKS;
    process.stdout.write(`\nفحص سلامة البنك (${bank.length} مهمة × حالتان: قبل الحل وبعده)…\n\n`);
    const checks = await verifyBank(bank, 60_000);
    process.stdout.write(formatBankChecks(checks) + '\n');
    process.exit(checks.every((c) => c.startFails && c.solutionPasses) ? 0 : 1);
  }
  if (args.share) {
    // بطاقة من تقرير محفوظ: تقرأ JSON فقط، ولا تحتاج موديلاً ولا شبكة
    const raw = JSON.parse(fs.readFileSync(path.resolve(args.share), 'utf8'));
    // يقبل تقرير تقييم موديلات أو تقرير مقارنة A/B — البطاقة تتكيّف مع الشكل
    const html = Array.isArray(raw.summary) && Array.isArray(raw.tasks)
      ? abCardHtml(raw, { version: '' })
      : (() => {
          const reports = raw.reports ?? raw.ranked ?? raw;
          if (!Array.isArray(reports)) throw new Error('ملف غير معروف: ليس تقرير تقييم ولا تقرير A/B');
          return evalCardHtml(reports, { tasksLabel: `${reports[0]?.outcomes?.length ?? reports[0]?.total ?? 0} مهمة` });
        })();
    // ملصق PNG من نفس الملف المحفوظ (اختياري؛ PNG افتراضياً بجانب --out)
    const pngBuf = Array.isArray(raw.summary) && Array.isArray(raw.tasks)
      ? (args.square ? shareBadgePng(abBadgeData(raw, { version: '' }), { square: true }) : abBadgePng(raw, { version: '' }))
      : (() => {
          const r = raw.reports ?? raw.ranked ?? raw;
          if (!Array.isArray(r)) return null;
          return args.square ? shareBadgePng(evalBadgeData(r), { square: true }) : evalBadgePng(r);
        })();
    if (args.out) {
      fs.writeFileSync(path.resolve(args.out), html, 'utf8');
      process.stdout.write(`\nحُفظت البطاقة القابلة للمشاركة: ${path.resolve(args.out)} (أرقام فقط، بلا كود)\n`);
    }
    if (pngBuf && (args.png || args.out)) {
      const pngPath = path.resolve(args.png ?? String(args.out).replace(/\.html?$/i, '') + '.png');
      fs.writeFileSync(pngPath, pngBuf);
      process.stdout.write(`حُفظ ملصق PNG: ${pngPath}\n`);
    }
    if (!args.out && !args.png) process.stdout.write(html);
    return;
  }

  // مهام من أعطال مشروع المستخدم: تُبنى من سجل الموثوقية المحلي
  let projectTasks: typeof EVAL_TASKS | null = null;
  if (args.fromProject) {
    const root = path.resolve(args.fromProject);
    const events = await Telemetry.load(path.join(userDataDir(), 'telemetry.jsonl')).catch(() => []);
    const set = await projectTasksFromEvents(root, events, { limit: 5 });
    if (!set.tasks.length) {
      process.stderr.write(`\n${formatProjectTaskSet(set)}\n\nلا مهام قابلة للتحقق — شغّل FreeCode على المشروع حتى تُسجَّل أعطال، ثم أعد المحاولة.\n`);
      process.exit(3);
    }
    process.stdout.write(`\n${formatProjectTaskSet(set)}\n`);
    if (args.listProject) return;
    projectTasks = set.tasks;
  }

  if (!args.models.length && !args.ab && !args.ctxSweep) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  const tasks = projectTasks
    ? projectTasks
    : args.tasks.length
      ? (args.tasks.map((id) => taskById(id)).filter(Boolean) as typeof EVAL_TASKS)
      : args.quick
        ? quickTasks()
        : EVAL_TASKS;
  const targets: ModelTarget[] = args.models.map((entry) => {
    const at = entry.lastIndexOf('@');
    const model = at > 0 ? entry.slice(0, at) : entry;
    const base = at > 0 ? entry.slice(at + 1) : args.baseUrl;
    return { label: model, cfg: { baseUrl: normalizeBaseUrl(base), apiKey: args.apiKey, model } };
  });

  // مقارنة A/B لملف التعليمات: نفس المهام ونفس الموديل، والفرق نص التعليمات فقط
  if (args.ab) {
    const [fileA, fileB] = args.ab.split(',').map((x) => x.trim()).filter(Boolean);
    if (!fileA || !fileB || !targets.length) {
      process.stderr.write('\nالاستخدام: --ab <ملف-أ,ملف-ب> --models <موديل> [--quick|--tasks …|--prompt "…"]\n');
      process.exit(2);
    }
    const root = args.fromProject ? path.resolve(args.fromProject) : process.cwd();
    const variantA = await readVariant(root, fileA);
    const variantB = await readVariant(root, fileB);
    let abTasks: typeof EVAL_TASKS = tasks;
    if (args.prompt) {
      const t = await taskFromPrompt(root, args.prompt);
      if ('error' in t) {
        process.stderr.write(`\n${t.error}\n`);
        process.exit(3);
      }
      abTasks = [t as typeof EVAL_TASKS[number]];
    }
    process.stdout.write(`\nA/B: «${variantA.label}» مقابل «${variantB.label}» × ${abTasks.length} مهمة × ${args.repeat} تكرار — ${targets[0].label}\n\n`);
    const report = await runAbTest(targets[0], abTasks, {
      variants: [variantA, variantB],
      repeats: args.repeat,
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
    });
    if (args.json) process.stdout.write(abReportJson(report) + '\n');
    else process.stdout.write('\n' + formatAbReport(report) + '\n');
    if (args.out) fs.writeFileSync(path.resolve(args.out), args.json ? abReportJson(report) : formatAbReport(report), 'utf8');
    return;
  }

  // جرد محاور السياق: كل موديل × كل محور، بفرق واحد فقط — جدول جاهز للصق
  if (args.ctxSweep) {
    // وضع «عرض فقط»: `--ctx-sweep --timeline` بلا موديلات وبلا أي علم تنفيذ/حفظ ⇒ اطبع السلسلة المحفوظة واخرج
    const acts = args.save || args.compare || args.badge || args.tableOut || args.out || args.outDir;
    if (args.timeline && !args.models.length && !acts) {
      const saved = await readSweepArchive(process.cwd());
      if (!saved.length) {
        process.stdout.write(`لا جرد محفوظ في ${sweepArchivePath(process.cwd())} — شغّل جرداً مع --save أولاً.\n`);
        return;
      }
      const tl = sweepTimeline(saved);
      if (tl) process.stdout.write('\n' + formatSweepTimeline(tl) + '\n');
      return;
    }
    // إعداد جرد محفوظ (.freecode/sweep.json) يُغني عن الأعلام الطويلة — وأي علم صريح يتقدم عليه
    let cfg = null as Awaited<ReturnType<typeof loadSweepConfig>>['config'];
    if (args.config || !args.models.length) {
      const file = args.config ? path.resolve(args.config) : sweepConfigPath(process.cwd());
      const loaded = args.config
        ? await (async () => {
            try {
              return { ...parseSweepConfig(JSON.parse(fs.readFileSync(file, 'utf8'))), file };
            } catch (e: any) {
              return { config: null, file, errors: [`تعذّر قراءة ${file}: ${String(e?.message ?? e).slice(0, 120)}`] };
            }
          })()
        : await loadSweepConfig(process.cwd());
      if (loaded.errors.length) {
        if (args.config || !args.models.length) {
          process.stderr.write(`\nخطأ في إعداد الجرد (${file}):\n- ${loaded.errors.join('\n- ')}\n\nأنشئ إعداداً أولياً: freecode-eval --init-sweep\n`);
          process.exit(2);
        }
      } else cfg = loaded.config;
    }
    if (!targets.length && cfg) {
      for (const entry of cfg.models) {
        const at = entry.lastIndexOf('@');
        const model = at > 0 ? entry.slice(0, at) : entry;
        const base = at > 0 ? entry.slice(at + 1) : cfg.baseUrl ?? args.baseUrl;
        targets.push({ label: model, cfg: { baseUrl: normalizeBaseUrl(base), apiKey: args.apiKey, model } });
      }
      process.stdout.write(`من الإعداد المحفوظ: ${cfg.models.length} موديل${cfg.axes ? ` × محاور ${cfg.axes.join(',')}` : ''}\n`);
    }
    if (!args.repeat || args.repeat === 1) if (cfg?.repeat) args.repeat = cfg.repeat;
    if (!args.axes && cfg?.axes) args.axes = cfg.axes.join(',');
    if (!args.full && cfg?.tasks === 'full') args.full = true;
    if (!projectTasks && cfg?.fromProject) {
      const root = path.resolve(cfg.fromProject);
      const events = await Telemetry.load(path.join(userDataDir(), 'telemetry.jsonl')).catch(() => []);
      const set = await projectTasksFromEvents(root, events, { limit: 5 });
      if (set.tasks.length) projectTasks = set.tasks;
    }
    const sweepTasks = projectTasks ?? (args.tasks.length
      ? (args.tasks.map((id) => taskById(id)).filter(Boolean) as typeof EVAL_TASKS)
      : args.full ? EVAL_TASKS : quickTasks());
    let wantedAxes = args.axes
      ? (args.axes.split(',').map((x) => x.trim()).filter((x) => CONTEXT_AXES.some((a) => a.axis === x)) as ContextAxis[])
      : undefined;
    if (args.axes && (!wantedAxes || !wantedAxes.length)) {
      process.stderr.write(`محاور غير معروفة: ${args.axes} — المتاح: ${CONTEXT_AXES.map((a) => a.axis).join(', ')}\n`);
      process.exit(2);
    }
    // ---- محور autoVerify: لا يُقاس إلا بفحص حقيقي (أمر مشروعك أو فحص مكتشف داخل المهمة) ----
    let axesToRun = wantedAxes ?? CONTEXT_AXES.map((a) => a.axis);
    let verifyCmd: string | undefined;
    if (axesToRun.includes('autoVerify')) {
      const detected = projectTasks?.length ? await detectVerify(process.cwd()).then((c) => c.map((x) => x.command)).catch(() => []) : [];
      const picked = pickVerifyCommand(args.verifyCmd, cfg?.verifyCommand, detected);
      if (picked.command && projectTasks?.length) {
        verifyCmd = picked.command;
        process.stdout.write(`محور autoVerify يقيس فحص مشروعك: ${verifyCmd} (${verifySourceLabel(picked.source)})\n`);
      } else if (picked.command && !projectTasks?.length) {
        axesToRun = axesToRun.filter((a) => a !== 'autoVerify');
        process.stdout.write(`استُبعد محور autoVerify: أمر الفحص «${picked.command}» يخص مشروعك، والمهام الحالية مهام بنك في مجلدات مؤقتة.\n  شغّل الجرد على مهام مشروعك: --ctx-sweep --from-project أو من داخل المشروع بإعداد fromProject.\n`);
      } else {
        const cov = sweepVerifyCoverage(sweepTasks);
        if (!cov.usable) {
          axesToRun = axesToRun.filter((a) => a !== 'autoVerify');
          process.stdout.write(`استُبعد محور autoVerify: لا فحص فعلي في ${cov.total} مهمة (لا test.js ولا tsconfig ولا package.json فيه فحص).\n  أضف «verifyCommand» في الإعداد أو مرّر --verify-cmd.\n`);
        } else {
          process.stdout.write(`محور autoVerify يقيس الفحص المكتشف داخل كل مهمة (${cov.usable} من ${cov.total} مهمة فيها فحص فعلي).\n`);
        }
      }
      if (!axesToRun.length) {
        process.stderr.write('لا محاور قابلة للقياس — أوقف التنفيذ.\n');
        process.exit(2);
      }
      wantedAxes = axesToRun;
    }
    // محور الذاكرة يقيس `.freecode/memory.md` — وبلا هذا الملف يكون الصف «بلا فرق» بنيوياً لا قياساً
    if (axesToRun.includes('memory') && !fs.existsSync(path.join(process.cwd(), '.freecode', 'memory.md'))) {
      process.stdout.write('تنبيه: محور الذاكرة يقيس .freecode/memory.md، ولا يوجد هذا الملف هنا — الصف سيظهر «بلا فرق» بحكم غياب الملف لا بحكم الموديل.\n  أنشئ ذاكرة المشروع (`/memory` في التطبيق) ثم أعد الجرد لقياس حقيقي.\n');
    }
    const axesLabel = wantedAxes ? wantedAxes.join(',') : 'كل المحاور';
    // بصمة الإعداد الفعلي (كما نُفِّذ لا كما كُتب) — أساس نسبة التغيّر: إعداد أم موديل؟
    const effSig = sweepSignature({ models: targets.map((t) => t.label), axes: axesToRun, tasks: sweepTasks.length, repeats: args.repeat });
    const effHash = sweepConfigHash({ models: targets.map((t) => t.label), axes: axesToRun, tasks: sweepTasks.length, repeats: args.repeat });
    process.stdout.write(`\nجرد محاور السياق: ${targets.length} موديل × ${axesLabel} × ${sweepTasks.length} مهمة × ${args.repeat} تكرار…\n\n`);
    const rows = await contextAxisSweep(targets, sweepTasks, {
      repeats: args.repeat,
      axes: wantedAxes,
      verifyCommand: verifyCmd,
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
    });
    const md = formatAxisSweep(rows, { tasks: sweepTasks.length, repeats: args.repeat });
    process.stdout.write('\n' + md + '\n');
    if (args.json) process.stdout.write(axisSweepJson(rows) + '\n');

    // أرشيف الجرد + المقارنة الزمنية (.freecode/ctx-sweep.jsonl)
    const archiveFile = sweepArchivePath(process.cwd());
    const archived = await readSweepArchive(process.cwd());
    const prev = args.compare ? (archived[archived.length - 1] ?? null) : null;
    if (args.compare) {
      const cmp = compareAxisSweep(prev, rows, { configHash: effHash });
      process.stdout.write('\n' + cmp + '\n');
      if (prev?.configHash && prev.configHash !== effHash) {
        process.stdout.write(`\n> 🧩 إعداد الجرد تغيّر منذ آخر جرد: ${prev.signature ?? prev.configHash} ← ${effSig}\n`);
      }
    }
    let seriesSource = archived;
    if (args.save) {
      fs.mkdirSync(path.dirname(archiveFile), { recursive: true });
      // ملفات `.freecode/` حالة محلية: نضمن تجاهلها في git قبل أن نكتب فيها
      if (ensureFreecodeIgnored(process.cwd()) === 'created') {
        process.stdout.write(`أنشأتُ ${FREECODE_DIR}/.gitignore حتى لا يُرفع أرشيف القياس إلى git (عدّله إن أردت).\n`);
      }
      const entry = axisSweepArchiveEntry(rows, { tasks: sweepTasks.length, repeats: args.repeat }, { configHash: effHash, signature: effSig });
      fs.appendFileSync(archiveFile, JSON.stringify(entry) + '\n', 'utf8');
      seriesSource = [...archived, entry];
      process.stdout.write(`\nأُرشف الجرد في: ${archiveFile} (${new Date().toISOString().slice(0, 10)})\n  الإعداد: ${effSig} · بصمة ${effHash}\n`);
    }
    if (args.timeline) {
      const tl = sweepTimeline(seriesSource);
      if (tl) process.stdout.write('\n' + formatSweepTimeline(tl) + '\n');
    }
    if (args.tableOut) {
      const tf = path.resolve(args.tableOut);
      fs.mkdirSync(path.dirname(tf), { recursive: true });
      fs.writeFileSync(tf, formatAxisSweepReadme(rows, { tasks: sweepTasks.length, repeats: args.repeat }, { models: targets.map((t) => t.label) }), 'utf8');
      process.stdout.write(`\nكُتبت كتلة README الجاهزة للصق: ${tf}\n`);
    }
    const project = path.basename(process.cwd());
    if (args.badge) {
      const badgePath = path.resolve(args.badge);
      fs.writeFileSync(badgePath, args.square
        ? shareBadgePng({ title: `${project} — جرد محاور السياق`, score: rows.length ? Math.round((rows.filter((r) => r.deltaPassed > 0 || (r.deltaPassed === 0 && r.tokenSavingPct >= 8)).length / rows.length) * 100) : 0, headline: `${rows.filter((r) => r.deltaPassed > 0 || (r.deltaPassed === 0 && r.tokenSavingPct >= 8)).length}/${rows.length}`, sub: rows.map((r) => `${r.axis}:${r.reading}`).join(' · ').slice(0, 130) }, { square: true })
        : ctxSweepBadgePng(rows, { tasks: sweepTasks.length, project }));
      process.stdout.write(`حُفظ ملصق الجرد: ${badgePath}\n`);
    }
    if (args.out) {
      const out = path.resolve(args.out);
      fs.writeFileSync(out, out.endsWith('.json') ? axisSweepJson(rows) + '\n' : `# جرد محاور السياق — FreeCode\n\n${md}\n`, 'utf8');
      process.stdout.write(`\nحُفظ الجرد في: ${out}\n`);
    }
    if (args.outDir) {
      const dir = path.resolve(args.outDir);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      fs.writeFileSync(path.join(dir, `ctx-sweep-${stamp}.md`), `# جرد محاور السياق — FreeCode\n\n${md}\n`, 'utf8');
      fs.writeFileSync(path.join(dir, `ctx-sweep-${stamp}.json`), axisSweepJson(rows) + '\n', 'utf8');
      process.stdout.write(`حُفظت حزمة الجرد في ${dir}\n`);
    }
    return;
  }

  process.stdout.write(`\nتقييم ${targets.length} موديل × ${tasks.length} مهمة — محلي بالكامل (يحتاج Node فقط)\n\n`);
  const reports = await evalModels(targets, {
    tasks,
    maxSteps: args.maxSteps,
    onProgress: (line) => process.stdout.write(`  ${line}\n`),
  });

  const md = formatEvalReport(reports, { tasksLabel: tasks.length === EVAL_TASKS.length ? 'البنك الكامل' : 'مجموعة مختارة' });
  if (args.json) process.stdout.write(evalReportJson(reports) + '\n');
  else process.stdout.write('\n' + md + '\n');

  if (args.out) {
    const out = path.resolve(args.out);
    const isJson = out.endsWith('.json');
    fs.writeFileSync(out, isJson ? evalReportJson(reports) + '\n' : `# تقييم الموديلات — FreeCode\n\n${md}\n`, 'utf8');
    process.stdout.write(`\nحُفظ التقرير في: ${out}\n`);
  }
  if (args.outDir) {
    const dir = path.resolve(args.outDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const mdFile = path.join(dir, `eval-${stamp}.md`);
    const jsFile = path.join(dir, `eval-${stamp}.json`);
    const pngFile = path.join(dir, `eval-badge-${stamp}.png`);
    fs.writeFileSync(mdFile, `# تقييم الموديلات — FreeCode\n\n${md}\n`, 'utf8');
    fs.writeFileSync(jsFile, evalReportJson(reports) + '\n', 'utf8');
    fs.writeFileSync(pngFile, evalBadgePng(reports, { tasksLabel: `${tasks.length} مهمة` }));
    process.stdout.write(`\nحُفظت الحزمة في ${dir}:\n  ${path.basename(mdFile)}\n  ${path.basename(jsFile)}\n  ${path.basename(pngFile)}\n`);
  }
  const best = reports.reduce((a, b) => (b.passed > a.passed ? b : a), reports[0]);
  process.exit(best && best.passed > 0 ? 0 : 1);
}

void main().catch((e) => {
  process.stderr.write(`فشل التقييم: ${String(e?.message ?? e)}\n`);
  process.exit(1);
});
