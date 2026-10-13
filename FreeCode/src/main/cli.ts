#!/usr/bin/env node
// وضع Headless: يشغّل الوكيل بالكامل بلا واجهة ولا Electron — للاستخدام في CI والسكربتات.
// أمثلة:
//   freecode -p "أصلح فشل الاختبارات" --yes
//   freecode -p "راجع الكود" --mode plan
//   freecode -p "أضف اختبارات" --json > out.json
//
// لا يستورد هذا الملف أي شيء من electron، فالنواة (agent/llm/tools/rules) مستقلة أصلاً.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, DEFAULT_OPTIONS, type AgentEvents, type AgentOptions, type Mode } from './agent';
import { isDangerousCommand } from './tools';
import { estimateTokens, normalizeBaseUrl, type ChatMessage, type LLMConfig } from './llm';
import { loadRules } from './rules';
import { attachMentions } from './files';
import { discoverSkills } from './skills';
import { dataUrlsFromFiles, MAX_IMAGES_PER_MESSAGE } from './images';
import type { SearchProvider } from './search';
import { buildDashboard, dashboardJson, formatDashboard, readEvalHistory } from './metrics';
import { readSweepArchive } from './sweepconfig';
import { Telemetry } from './telemetry';

// الأنابيب: لا نُسقط العملية بخطأ EPIPE إذا أُغلق القارئ (مثل `freecode ... | head`)
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e?.code === 'EPIPE') process.exit(0);
});

export interface CliArgs {
  task: string;
  cwd: string;
  mode: Mode;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** موافقة تلقائية على التعديلات والأوامر غير الخطرة */
  yes: boolean;
  /** مسارات صور لإرفاقها بالمهمة (يُكرَّر --image) */
  images: string[];
  /** السماح أيضاً بالأوامر الخطرة (يتطلب --yes) */
  allowDangerous: boolean;
  json: boolean;
  quiet: boolean;
  maxSteps: number;
  tokenBudget: number;
  help: boolean;
  version: boolean;
  dashboard: boolean;
}

const HELP = `FreeCode — وكيل برمجة بالذكاء الاصطناعي (وضع بلا واجهة)

الاستخدام:
  freecode -p "<المهمة>" [خيارات]

الخيارات:
  -p, --print <نص>       المهمة المطلوبة (إلزامي، أو اقرأها من stdin)
  -C, --cwd <مجلد>       مجلد العمل (الافتراضي: المجلد الحالي)
  -m, --mode <plan|act>  وضع الخطة (قراءة فقط) أو التنفيذ (الافتراضي act)
      --model <اسم>      الموديل (الافتراضي من الإعدادات أو freellmapi/auto)
      --base-url <عنوان> عنوان الخادم المتوافق مع OpenAI
      --api-key <مفتاح>  المفتاح (أو FREECODE_API_KEY)
  -i, --image <ملف>      صورة ترفق بالمهمة (يُكرَّر حتى 4 مرات: png/jpg/webp/gif)
      --max-steps <عدد>  أقصى عدد خطوات (الافتراضي 30)
      --token-budget <n> ميزانية السياق بالتوكنات
  -y, --yes              وافق تلقائياً على التعديلات والأوامر غير الخطرة
      --allow-dangerous  اسمح بالأوامر الخطرة أيضاً (مع --yes)
      --json             أخرج النتيجة النهائية JSON (يشمل الأدوات والملفات المعدّلة)
      --dashboard        اطبع لوحة القياس (الموثوقية + تاريخ تقييم الموديلات) ثم اخرج
  -q, --quiet            لا تطبع تدفّق النص، فقط النتيجة النهائية
  -v, --version          رقم الإصدار
  -h, --help             هذه المساعدة

الإعدادات: تُقرأ من <مجلد بيانات المستخدم>/settings.json (نفس إعدادات التطبيق)،
وأي خيار يُمرَّر هنا يتقدم عليها. متغيرات: FREECODE_API_KEY وFREECODE_BASE_URL.

رمز الخروج: 0 نجاح، 1 فشل، 2 خطأ في الاستخدام.
`;

/** محلّل وسائط بسيط (بلا مكتبات) — مفصول ليكون قابلاً للاختبار */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    task: '',
    cwd: process.cwd(),
    mode: 'act',
    images: [],
    yes: false,
    allowDangerous: false,
    json: false,
    quiet: false,
    maxSteps: DEFAULT_OPTIONS.maxSteps,
    tokenBudget: DEFAULT_OPTIONS.tokenBudget,
    help: false,
    version: false,
    dashboard: false,
  };
  const next = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`الخيار ${name} يحتاج قيمة`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-p':
      case '--print':
        out.task = next(i, a);
        i++;
        break;
      case '-C':
      case '--cwd':
        out.cwd = path.resolve(next(i, a));
        i++;
        break;
      case '-m':
      case '--mode':
        out.mode = next(i, a) === 'plan' ? 'plan' : 'act';
        i++;
        break;
      case '-i':
      case '--image':
        out.images.push(path.resolve(next(i, a)));
        i++;
        break;
      case '--model':
        out.model = next(i, a);
        i++;
        break;
      case '--base-url':
        out.baseUrl = next(i, a);
        i++;
        break;
      case '--api-key':
        out.apiKey = next(i, a);
        i++;
        break;
      case '--max-steps':
        out.maxSteps = Math.max(1, Math.min(200, Number(next(i, a)) || DEFAULT_OPTIONS.maxSteps));
        i++;
        break;
      case '--token-budget':
        out.tokenBudget = Math.max(4000, Number(next(i, a)) || DEFAULT_OPTIONS.tokenBudget);
        i++;
        break;
      case '-y':
      case '--yes':
        out.yes = true;
        break;
      case '--allow-dangerous':
        out.allowDangerous = true;
        break;
      case '--json':
        out.json = true;
        break;
      case '--dashboard':
        out.dashboard = true;
        break;
      case '-q':
      case '--quiet':
        out.quiet = true;
        break;
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '-v':
      case '--version':
        out.version = true;
        break;
      default:
        if (a.startsWith('-')) throw new Error(`خيار غير معروف: ${a}`);
        // نص حرّ بلا خيار = المهمة (يدعم: freecode "أصلح كذا")
        out.task = out.task ? `${out.task} ${a}` : a;
    }
  }
  return out;
}

/** مجلد بيانات المستخدم نفسه الذي يستخدمه التطبيق (بلا Electron) */
export function userDataDir(): string {
  const env = process.env.FREECODE_USER_DATA;
  if (env) return env;
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? os.homedir(), 'freecode');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'freecode');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'freecode');
}

interface Stored {
  baseUrl?: string;
  model?: string;
  apiKeyEnc?: string;
  apiKeyPlain?: string;
  autoVerify?: boolean;
  verifyCommand?: string;
  repoMap?: boolean;
  searchProvider?: SearchProvider;
  searchApiKey?: string;
  tokenBudget?: number;
}

export function readStoredSettings(dir = userDataDir()): Stored {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** يبني إعدادات الاتصال: الخيارات تتقدم على المتغيرات ثم ملف الإعدادات */
export function resolveConfig(args: CliArgs, stored: Stored): LLMConfig | null {
  const baseUrl = args.baseUrl ?? process.env.FREECODE_BASE_URL ?? stored.baseUrl;
  const model = args.model ?? stored.model ?? 'freellmapi/auto';
  // المفتاح المشفّر بـsafeStorage لا يمكن فكّه خارج Electron؛ نستخدم النصي أو متغير البيئة
  const apiKey = args.apiKey ?? process.env.FREECODE_API_KEY ?? stored.apiKeyPlain ?? '';
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: normalizeBaseUrl(baseUrl), model, apiKey };
}

export interface CliOutcome {
  ok: boolean;
  text: string;
  toolCalls: number;
  tools: { name: string; ok: boolean }[];
  approvals: { tool: string; granted: boolean; dangerous: boolean }[];
  changed: string[];
  tokens: number;
  error?: string;
}

/** ينفّذ المهمة ويعيد النتيجة (يُستدعى من main ومن الاختبارات) */
export async function runHeadless(
  args: CliArgs,
  cfg: LLMConfig,
  io: { out: (s: string) => void; err: (s: string) => void; prompt?: string; stored?: Stored } = { out: () => {}, err: () => {} },
): Promise<CliOutcome> {
  const outcome: CliOutcome = { ok: false, text: '', toolCalls: 0, tools: [], approvals: [], changed: [], tokens: 0 };
  // الصور: تُقرأ من القرص مرة واحدة وتُمرَّر كجزء من رسالة المستخدم
  let images: string[] = [];
  if (args.images.length) {
    images = await dataUrlsFromFiles(args.images);
    if (!args.quiet && !args.json) io.err(`[أُرفقت ${images.length} صورة من ${args.images.length}${args.images.length > MAX_IMAGES_PER_MESSAGE ? ' (الحد 4)' : ''}]\n`);
  }
  const userData = userDataDir();
  const stored = io.stored ?? {};
  const options: AgentOptions = {
    ...DEFAULT_OPTIONS,
    mode: args.mode,
    maxSteps: args.maxSteps,
    tokenBudget: args.tokenBudget || stored.tokenBudget || DEFAULT_OPTIONS.tokenBudget,
    autoVerify: stored.autoVerify ?? true,
    verifyCommand: stored.verifyCommand ?? '',
    repoMap: stored.repoMap ?? true,
    searchProvider: stored.searchProvider ?? 'auto',
    searchApiKey: stored.searchApiKey ?? '',
    // في وضع Headless لا نفعّل الموافقة التلقائية العامة: القرار يأتي من --yes أو القواعد
    autoApproveEdits: false,
    autoApproveCommands: false,
  };

  const agent = new Agent(cfg, args.cwd, options);
  const lr = await loadRules(path.join(userData, 'rules.json'), args.cwd, () => true);
  agent.rules = lr.rules;
  agent.skills = await discoverSkills(args.cwd, userData).catch(() => []);

  // السلوك بلا --yes: نرفض كل ما يحتاج موافقة ونُخبر النموذج بالسبب (مثل plan لكن بلا منع تصنيفي)
  const events: AgentEvents = {
    onText: (d) => {
      outcome.text += d;
      if (!args.quiet && !args.json) io.out(d);
    },
    onToolCall: (id, name) => {
      outcome.toolCalls++;
      outcome.tools.push({ name, ok: true });
      if (!args.quiet && !args.json) io.out(`\n› ${name}\n`);
    },
    onToolOutput: (id, chunk) => {
      if (!args.quiet && !args.json) io.err(chunk);
    },
    onToolResult: (id, name, result, isError) => {
      const t = [...outcome.tools].reverse().find((x) => x.name === name && x.ok);
      if (t && isError) t.ok = false;
    },
    approve: async (_id, name, a: any) => {
      const dangerous = name === 'run_command' && isDangerousCommand(String(a?.command ?? ''));
      const granted = args.yes && (!dangerous || args.allowDangerous);
      outcome.approvals.push({ tool: name, granted, dangerous });
      if (!granted && !args.quiet) io.err(`\n[rفض: ${name}${dangerous ? ' (أمر خطر)' : ''} — مرّر --yes للموافقة]\n`);
      return granted;
    },
    onTodos: () => {},
    onUsage: (u) => {
      outcome.tokens = u.tokens;
    },
    onRetry: (info) => {
      if (!args.quiet) io.err(`\n[إعادة محاولة ${info.attempt}/${info.maxAttempts}] ${info.reason}\n`);
    },
    onChanges: (changes) => {
      outcome.changed = changes.map((c) => c.path);
    },
    onNotice: (m) => {
      if (!args.quiet && !args.json) io.err(`\n[${m}]\n`);
    },
  };

  const { text } = await attachMentions(args.cwd, io.prompt ?? args.task);
  await agent.run(text, events, undefined, images);
  outcome.ok = true;
  return outcome;
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e: any) {
    process.stderr.write(`${String(e?.message ?? e)}\n\n${HELP}`);
    process.exit(2);
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8').toString());
  if (args.version) {
    process.stdout.write(`freecode ${pkg.version}\n`);
    return;
  }
  if (args.dashboard) {
    const userData = userDataDir();
    const events = await Telemetry.load(path.join(userData, 'telemetry.jsonl')).catch(() => []);
    const history = await readEvalHistory(userData, 20);
    const sweeps = args.cwd ? await readSweepArchive(args.cwd) : [];
    const data = buildDashboard({ events, history, sweeps });
    if (args.json) process.stdout.write(dashboardJson(data) + '\n');
    else process.stdout.write('\n' + formatDashboard(data, { workspace: args.cwd }) + '\n');
    process.exit(0);
  }
  if (args.help || (!args.task && process.stdin.isTTY)) {
    process.stdout.write(HELP);
    return;
  }

  // المهمة من stdin إن لم تُمرَّر بـ-p (يفيد في الأنابيب: echo "..." | freecode --yes)
  let task = args.task;
  if (!task && !process.stdin.isTTY) {
    task = (await new Promise<string>((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => (buf += c));
      process.stdin.on('end', () => resolve(buf));
    })).trim();
  }
  if (!task) {
    process.stderr.write('لا توجد مهمة. مرّر -p "المهمة" أو اكتبها على stdin.\n');
    process.exit(2);
  }
  if (!fs.existsSync(args.cwd) || !fs.statSync(args.cwd).isDirectory()) {
    process.stderr.write(`مجلد غير موجود: ${args.cwd}\n`);
    process.exit(2);
  }

  const stored = readStoredSettings();
  const cfg = resolveConfig(args, stored);
  if (!cfg) {
    process.stderr.write(
      'لا إعدادات اتصال. مرّر --api-key و--base-url، أو اضبط FREECODE_API_KEY، أو احفظ المفتاح غير المشفّر من التطبيق.\n' +
        '(المفتاح المشفّر بـsafeStorage لا يمكن فكّه خارج التطبيق — استخدم --api-key في CI.)\n',
    );
    process.exit(2);
  }

  if (!args.yes && !args.json && !args.quiet) {
    process.stderr.write('تنبيه: بلا --yes سيُرفض أي تعديل أو أمر. للتنفيذ الكامل أضف --yes.\n\n');
  }

  const started = Date.now();
  try {
    const outcome = await runHeadless(args, cfg, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s), prompt: task, stored });
    if (args.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            task,
            mode: args.mode,
            model: cfg.model,
            text: outcome.text,
            tools: outcome.tools,
            approvals: outcome.approvals,
            changedFiles: [...new Set(outcome.changed)],
            tokens: outcome.tokens,
            durationMs: Date.now() - started,
          },
          null,
          2,
        ) + '\n',
      );
    } else if (!outcome.text.trim()) {
      process.stderr.write('\n(انتهى بلا نص من الوكيل)\n');
    }
    process.exit(0);
  } catch (e: any) {
    const message = String(e?.message ?? e);
    if (args.json) process.stdout.write(JSON.stringify({ ok: false, task, error: message }, null, 2) + '\n');
    else process.stderr.write(`\nخطأ: ${message}\n`);
    process.exit(1);
  }
}

// لا نُشغّل main عند الاستيراد للاختبار
if (require.main === module) void main();
export { main, HELP };
export const _internal = { estimateTokens, type: undefined as unknown as ChatMessage };
