// اختبار واجهة المصيّر (ح10): يشغّل Electron فعلياً ويحمّل الواجهة الحقيقية
// (dist/renderer/index.html + renderer.js فوق preload.js الحقيقي) ثم «يلمس» الواجهة:
// يكتب في المحرر ويرسل، يدفع أحداث الوكيل من العملية الرئيسية، يفتح الإعدادات،
// يبدّل الجدولة، يضغط زر الجسر، ويلتقط صورة PNG — ويفشل عند أي خطأ JS في الصفحة.
//
// طبقة IPC بديلة (fixtures): كل قنوات preload مسجّلة بمخرجات ثابتة وتُسجَّل الاستدعاءات،
// فيتحقق الاختبار من عقد الواجهة↔العملية الرئيسية دون شبكة ولا موديلات ولا مفاتيح.
//
// التشغيل:  npm run uitest        (يلفّه scripts/uitest.mjs: بناء + xvfb-run على Linux بلا شاشة)
//            electron dist/main/uitest.js [--shots <ملف.png>] [--json] [--timeout <ثوانٍ>]
import { app, BrowserWindow, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------- تسجيل الاستدعاءات ----------
interface Call {
  ch: string;
  args: unknown[];
}
const calls: Call[] = [];
const callOf = (ch: string): Call[] => calls.filter((c) => c.ch === ch);
const lastArgs = (ch: string): unknown[] | null => {
  const l = callOf(ch);
  return l.length ? l[l.length - 1]!.args : null;
};

const passes: string[] = [];
const failures: string[] = [];
function check(cond: boolean, msg: string): void {
  (cond ? passes : failures).push(msg);
  console.log(`${cond ? 'ok  ' : 'FAIL'}: ${msg}`);
}

const WS = process.env.FREECODE_UITEST_WS || path.join(process.env.TMPDIR || '/tmp', 'freecode-uitest-project');
const NOW = Date.now();

// ---------- مخرجات ثابتة لكل قناة ----------
const settingsFixture = {
  baseUrl: 'http://127.0.0.1:31415',
  model: 'freellmapi/auto',
  hasKey: true,
  workspace: WS,
  recent: [WS],
  mode: 'act' as const,
  autoApproveEdits: false,
  autoApproveCommands: false,
  tokenBudget: 28_000,
  autoVerify: true,
  verifyCommand: 'npm run typecheck',
  repoMap: true,
  autoCommit: false,
  searchProvider: 'auto' as const,
  hasSearchKey: false,
  endpoint: 'http://127.0.0.1:31415',
  sweepAuto: true,
  sweepEveryHours: 24,
  sweepLastRun: NOW - 3_600_000,
  sweepLastOk: true,
  sweepLastNote: 'لا انحدارات · 3 موديلات',
};

interface ScheduleStateFixture {
  enabled: boolean;
  everyHours: number;
  lastRun: number | null;
  nextRun: number | null;
  running: boolean;
  lastResult: { at: number; ok: boolean; note: string } | null;
}

let scheduleState: ScheduleStateFixture = {
  enabled: true,
  everyHours: 24,
  lastRun: NOW - 3_600_000,
  nextRun: NOW + 23 * 3_600_000,
  running: false,
  lastResult: { at: NOW - 3_600_000, ok: true, note: 'لا انحدارات · 3 موديلات' },
};

const fixtures: Record<string, (args: unknown[]) => unknown> = {
  'settings:get': () => settingsFixture,
  'settings:set': (a) => ({ ...settingsFixture, ...((a[0] as object) ?? {}) }),
  'workspace:pick': () => settingsFixture,
  'workspace:set': () => settingsFixture,
  'tree:list': () => [
    { name: 'src', path: 'src', isDir: true },
    { name: 'a.ts', path: 'a.ts', isDir: false },
    { name: 'README.md', path: 'README.md', isDir: false },
  ],
  'file:read': () => ({ ok: true, text: 'export const a = 1;\n' }),
  'files:search': () => ['a.ts'],
  'models:list': () => ({ ok: true, models: ['freellmapi/auto', 'gpt-oss-120b'] }),
  'open:external': () => null,
  'sessions:list': () => ({ sessions: [{ id: 's1', title: 'جلسة تجريبية', workspace: WS, updatedAt: NOW, turns: 2 }], currentId: 's1' }),
  'sessions:new': () => true,
  'sessions:load': () => null,
  'sessions:delete': () => true,
  'chat:send': () => null,
  'chat:abort': () => null,
  'chat:undo': () => ({ restored: [] }),
  'chat:compact': () => ({ summarized: 0 }),
  'commands:list': () => [],
  'mcp:status': () => ({ servers: [], userConfigPath: path.join(WS, 'mcp.json'), projectConfigPath: null }),
  'mcp:reload': () => ({ servers: [], userConfigPath: path.join(WS, 'mcp.json'), projectConfigPath: null }),
  'approval:respond': () => null,
  'telemetry:summary': () => ({ turns: 0, okTurns: 0, failedTurns: 0, incompleteTurns: 0, steps: 0, tokens: 0, tokensPerTurn: 0, edits: 0, exactEdits: 0, fuzzyEdits: 0, verifyRuns: 0, verifyFailed: 0, approvalsAsked: 0, approvalsDenied: 0, approvalsBulk: 0, toolErrors: 0, topErrors: [], retries: 0, p50TurnMs: 0, p95TurnMs: 0, from: NOW, to: NOW, bridgeCalls: 0, bridgeOk: 0, bridgeDenied: 0, bridgeBlocked: 0, bridgeMs: 0, bridgeLastTool: '', text: 'لا قياسات بعد.' }),
  'telemetry:failures': () => ({ text: 'لا إخفاقات.', tasks: [] }),
  'telemetry:clear': () => ({ ok: true, text: 'أُفرغ السجل.' }),
  'metrics:dashboard': () => ({ ok: true, markdown: '# لوحة القياس\nلا دورات بعد.', line: 'لا دورات بعد', turns: 0, sweeps: 0 }),
  'metrics:export': () => ({ ok: true, md: '/tmp/x.md', js: '/tmp/x.json' }),
  'metrics:sweep-now': () => ({ ok: true, created: false, configPath: path.join(WS, '.freecode', 'sweep.json'), digestLine: 'لا انحدارات · 3 موديلات', regressions: 0, improvements: 0, notified: false, runs: 2, seriesRuns: 2, seriesRegressions: 0 }),
  'metrics:badge': () => ({ ok: true, project: 'freecode-uitest-project', best: 'gpt-oss-120b', bestRate: 87.5, models: 3, png: '/tmp/badge.png' }),
  'schedule:status': () => scheduleState,
  'schedule:set': (a) => {
    const p = (a[0] as { enabled?: boolean; everyHours?: number }) ?? {};
    scheduleState = {
      ...scheduleState,
      ...(typeof p.enabled === 'boolean' ? { enabled: p.enabled } : {}),
      ...(typeof p.everyHours === 'number' ? { everyHours: Math.max(1, Math.min(720, Math.round(p.everyHours))) } : {}),
    };
    scheduleState.nextRun = scheduleState.enabled ? NOW + scheduleState.everyHours * 3_600_000 : null;
    return scheduleState;
  },
  'bridge:status': () => ({ running: false, port: null, url: null, token: '' }),
  'bridge:start': () => ({ ok: true, text: 'جسر IDE يعمل.' }),
  'bridge:stop': () => ({ ok: true, text: 'أُوقف جسر IDE.' }),
  'bridge:rotate': () => ({ ok: true, text: 'رُمّز الجسر.', token: 'tok-test' }),
  'bridge:command': (a) => ({ ok: true, text: `تنفيذ ${String(a[0])} تمّ.`, running: true, port: 4321, url: 'http://127.0.0.1:4321' }),
  'bridge:settings': () => ({ ok: true, text: 'حُفظت إعدادات جسر العقل الخارجي.', url: 'https://arena.ai', mode: 'ask', hosts: [] }),
  'bridge:hostStatus': () => ({ open: false, url: null, root: '', mode: 'ask', calls: 0, ok: 0, failed: 0, denied: 0, approved: 0, rules: 0, stopped: false, hosts: [], configuredUrl: 'https://arena.ai', configuredHosts: [], text: 'اللوحة مغلقة.' }),
  'plugins:installed': () => [],
  'plugins:list': () => ({ plugins: [], dir: '/tmp/plugins' }),
  'rules:get': () => ({ userPath: '/tmp/rules.json', projectPath: path.join(WS, '.freecode', 'rules.json'), projectPresent: false, projectSensitive: false, projectTrusted: false, needsTrust: false, projectSummary: [], errors: [], text: JSON.stringify({ permissions: { allow: [], ask: [], deny: [] }, hooks: { PreToolUse: [], PostToolUse: [] } }, null, 2) }),
  'rules:save': () => ({ ok: true, text: 'حُفظت القواعد.', info: null }),
  'rules:trust': () => ({ userPath: '/tmp/rules.json', projectPath: path.join(WS, '.freecode', 'rules.json'), projectPresent: false, projectSensitive: false, projectTrusted: true, needsTrust: false, projectSummary: [], errors: [] }),
  'rules:allow': () => ({ ok: true }),
  'memory:add': () => ({ ok: true, text: 'أُضيفت الملاحظة.' }),
  'memory:read': () => ({ text: '' }),
  'sessions:stats': () => ({ sessions: 1, turns: 2, tokens: 100 }),
  'sessions:export': () => ({ ok: true, path: '/tmp/session.md' }),
  'sandbox:status': () => ({ settings: { mode: 'off', image: 'node:22-bookworm-slim', network: false, extraArgs: '' }, engines: {}, text: 'معطّل — الأوامر تعمل على جهازك مباشرة' }),
  'sandbox:set': () => ({ ok: true, text: 'حُفظ إعداد العزل.' }),
  'lsp:status': () => ({ ok: true, servers: [], running: 0, disabled: [], userFile: '/tmp/lsp.json' }),
  'lsp:toggle': () => ({ ok: true, text: 'تم.' }),
  'lsp:trust': () => ({ ok: true, text: 'تمت الثقة.' }),
  'security:scan': () => ({ ok: true, text: 'لا نتائج.', findings: [], counts: { high: 0, medium: 0, low: 0 } }),
  'agents:list': () => ({ agents: [], git: true, max: 3, running: 0 }),
  'agents:clear': () => ({ ok: true, message: 'نُظّف.' }),
  'processes:list': () => [],
  'skills:list': () => ({ skills: [], projectDir: null, userDir: '/tmp/skills' }),
  'eval:tasks': () => ({ tasks: [] }),
  'ab:run': () => ({ ok: true, text: 'لا فوارق.' }),
  'eval:shareCard': () => ({ ok: true, path: '/tmp/card.html' }),
};
/** قنوات قد تُنادى من مسارات ثانوية — نرجع لها قيمة محايدة بدل رفض الوعد */
const NEUTRAL = [
  'plugins:review', 'plugins:apply', 'plugins:cancel', 'plugins:update', 'plugins:remove', 'plugins:scaffold', 'plugins:trust', 'plugins:toggle',
  'eval:projectTasks', 'eval:models', 'agents:start', 'agents:stop', 'agents:merge', 'agents:discard', 'agents:diff', 'processes:stop', 'skills:scaffold', 'skills:body',
];

function register(): void {
  for (const [ch, fn] of Object.entries(fixtures)) {
    ipcMain.handle(ch, (_e, ...args: unknown[]) => {
      calls.push({ ch, args });
      return fn(args);
    });
  }
  for (const ch of NEUTRAL) {
    ipcMain.handle(ch, (_e, ...args: unknown[]) => {
      calls.push({ ch, args });
      return { ok: true, text: 'قيمة اختبار' };
    });
  }
}

// ---------- أدوات الصفحة ----------
let win: BrowserWindow | null = null;
const consoleErrors: string[] = [];

interface UitestArgs {
  shots: string;
  json: boolean;
  timeoutMs: number;
}
function parseArgv(): UitestArgs {
  const argv = process.argv.slice(2);
  const val = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    shots: val('--shots') ?? path.join(process.env.TMPDIR || '/tmp', 'freecode-uitest.png'),
    json: argv.includes('--json'),
    timeoutMs: Number(val('--timeout') ?? 90) * 1000,
  };
}

async function evalJs<T>(code: string): Promise<T> {
  return (await win!.webContents.executeJavaScript(code, true)) as T;
}

async function waitFor(code: string, ms: number, what: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await evalJs<boolean>(`(() => { try { return !!(${code}); } catch { return false; } })()`)) return true;
    } catch {
      /* الصفحة قد تُعاد تحميلها */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  console.log(`(انتهت مهلة الانتظار: ${what})`);
  return false;
}

/** يلتقط صورة PNG للواجهة ويكتبها، ويعيد الحجم بالبايت */
async function shot(file: string): Promise<number> {
  // إطار حديث: ننتظر دورتَي رسم ثم نُجبر التقاطاً تحضيرياً قبل صورة الدليل
  // (نافذة بلا شاشة قد تعيد إطاراً قديماً إن لم يُطلب رسم جديد)
  await win!.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(true), 150)))', true);
  await win!.webContents.capturePage();
  const img = await win!.webContents.capturePage();
  const png = img.toPNG();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return png.length;
}

async function waitCall(ch: string, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (callOf(ch).length) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

// ---------- السيناريو ----------
async function run(args: UitestArgs): Promise<void> {
  register();
  fs.mkdirSync(WS, { recursive: true });
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    show: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win.webContents.on('console-message', (...a: any[]) => {
    const d = a[0];
    const isDetails = d && typeof d === 'object' && 'level' in d;
    const level = isDetails ? String(d.level) : String(a[1]);
    const message = isDetails ? String(d.message) : String(a[2]);
    if (level === 'error' || level === '3') consoleErrors.push(message.slice(0, 300));
  });
  let failedLoad = '';
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    failedLoad = `${code} ${desc} ${url}`;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  check(!failedLoad, `الصفحة حُمّلت (بلا فشل تحميل)${failedLoad ? ` — ${failedLoad}` : ''}`);

  // مراقبة أخطاء JS داخل الصفحة (بعد التحميل مباشرةً)
  await evalJs(`(() => {
    window.__uiErrors = [];
    window.addEventListener('error', (e) => window.__uiErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', (e) => window.__uiErrors.push('unhandled: ' + String((e.reason && e.reason.message) || e.reason)));
    return true;
  })()`);

  // 1) الإقلاع: شاشة الترحيب واسم المشروع وقائمة الملفات وجلسة الشريط
  const booted = await waitFor(`document.querySelector('#chat .welcome h1')`, 15000, 'شاشة الترحيب');
  check(booted, 'الإقلاع: شاشة الترحيب رُسمت من بيانات settings:get');
  const welcomeText = await evalJs<string>(`document.querySelector('#chat .welcome h1')?.textContent ?? ''`);
  check(welcomeText.includes('ماذا نبني'), 'الإقلاع: نصّ الترحيب صحيح');
  const wsName = await evalJs<string>(`document.getElementById('ws-name').textContent`);
  check(wsName.includes('freecode-uitest-project'), `الإقلاع: اسم المشروع ظهر في الشريط («${wsName}»)`);
  const treeOk = await waitFor(`document.getElementById('tree').textContent.includes('a.ts')`, 8000, 'قائمة الملفات');
  check(treeOk, 'اللوحة: شجرة الملفات رُسمت من tree:list');
  const sessOk = await waitFor(`document.getElementById('sessions').textContent.includes('جلسة تجريبية')`, 8000, 'قائمة الجلسات');
  check(sessOk, 'اللوحة: قائمة المحادثات رُسمت من sessions:list');
  const connOk = await evalJs<string>(`document.getElementById('conn').className`);
  check(connOk.includes('ok'), 'الاتصال: اختبار الاتصال عمل (models:list) وعلّم الحالة');

  // 2) الكتابة والإرسال من الواجهة
  await evalJs(`(() => {
    const inp = document.getElementById('input');
    inp.value = 'أضف اختباراً لوحدة الجدولة';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('send').click();
    return true;
  })()`);
  const sent = await waitCall('chat:send');
  const sendArgs = (lastArgs('chat:send') ?? []) as string[];
  check(sent && sendArgs[0] === 'أضف اختباراً لوحدة الجدولة', 'المحرر: الإرسال وصل للعملية الرئيسية بالنص نفسه (chat:send)');
  const userMsg = await waitFor(`document.querySelector('#chat .msg.user')?.textContent.includes('أضف اختباراً')`, 5000, 'فقاعة المستخدم');
  check(userMsg, 'المحادثة: فقاعة المستخدم رُسمت بعد الإرسال');
  const titleNow = await evalJs<string>(`document.getElementById('title').textContent`);
  check(titleNow.includes('أضف اختباراً'), 'العنوان: تحدّث من أول رسالة');
  const busyNow = await evalJs<boolean>(`document.getElementById('stop').hidden === false`);
  check(busyNow, 'الحالة: زر الإيقاف ظهر (الواجهة تعرف أن الوكيل يعمل)');

  // 3) أحداث الوكيل مدفوعة من العملية الرئيسية
  const send = (e: unknown): void => win!.webContents.send('agent:event', e);
  send({ type: 'text', delta: 'سأفحص الجدولة ' });
  send({ type: 'text', delta: 'ثم أضيف اختباراً.' });
  send({ type: 'tool_call', id: 't1', name: 'read_file', args: { path: 'a.ts' } });
  send({ type: 'tool_result', id: 't1', name: 'read_file', result: 'export const a = 1;', isError: false });
  send({ type: 'usage', tokens: 1200, budget: 28_000, saved: 0 });
  send({ type: 'changes', changes: [{ path: 'a.ts', created: false }], undoDepth: 1 });
  send({ type: 'sweep', auto: true, ok: true, note: 'لا انحدارات · 3 موديلات', at: NOW });
  send({ type: 'done' });
  const assistantOk = await waitFor(`document.querySelector('#chat .msg.assistant')?.textContent.includes('ثم أضيف اختباراً')`, 6000, 'فقاعة المساعد');
  check(assistantOk, 'الأحداث: نصّ الوكيل تدفّق ورُسم في فقاعة المساعد');
  const toolOk = await waitFor(`!!document.querySelector('#chat .tool')`, 5000, 'بطاقة الأدوات');
  check(toolOk, 'الأحداث: استدعاء الأداة ظهر كبطاقة');
  const noticeOk = await waitFor(`document.querySelector('#chat').textContent.includes('جرد دوري تلقائي')`, 5000, 'إشعار الجرد');
  check(noticeOk, 'الأحداث: حدث «sweep» التلقائي وصل كإشعار في المحادثة');
  const idleOk = await waitFor(`document.getElementById('send').hidden === false && document.getElementById('stop').hidden === true`, 5000, 'عودة الحالة');
  check(idleOk, 'الحالة: بعد done عاد زر الإرسال واختفت حالة الانشغال');
  const meterOk = await evalJs<string>(`document.getElementById('meter').textContent`);
  check(meterOk.includes('1.2k'), `القياس: عدّاد السياق تحدّث من حدث usage («${meterOk.trim()}»)`);

  // 3ب) لقطة المحادثة (دليل بصري على الرسم الحقيقي)
  const chatShot = args.shots.replace(/\.png$/i, '') + '_chat.png';
  const chatBytes = await shot(chatShot);
  check(chatBytes > 5000, `الصورة: لقطة المحادثة من مصيّر حقيقي (${Math.round(chatBytes / 1024)}KB) → ${chatShot}`);

  // 4) الإعدادات: القيم والجدولة
  await evalJs(`document.getElementById('open-settings').click()`);
  const modalOk = await waitFor(`document.getElementById('modal').hidden === false`, 4000, 'نافذة الإعدادات');
  check(modalOk, 'الإعدادات: النافذة فُتحت من زر الشريط');
  const urlVal = await evalJs<string>(`document.getElementById('s-url').value`);
  check(urlVal === settingsFixture.baseUrl, 'الإعدادات: قيم الاتصال جاءت من settings:get');
  const schedChecked = await evalJs<boolean>(`document.getElementById('s-sched').checked`);
  check(schedChecked === true, 'الجدولة: مفتاح «الجرد الدوري» يعكس الإعداد المحفوظ (مفعّل)');
  const schedStatus0 = await evalJs<string>(`document.getElementById('sched-status').textContent`);
  check(schedStatus0.includes('يعمل') && schedStatus0.includes('24'), `الجدولة: سطر الحالة يشرح الإيقاع والقادم («${schedStatus0.slice(0, 60)}…»)`);
  await evalJs(`document.getElementById('s-sched').click()`);
  const setOk = await waitCall('schedule:set');
  const setArg = (lastArgs('schedule:set') ?? [])[0] as { enabled?: boolean } | undefined;
  check(setOk && setArg?.enabled === false, 'الجدولة: إيقاف المفتاح أرسل schedule:set{enabled:false} للعملية الرئيسية');
  const schedStatus1 = await waitFor(`document.getElementById('sched-status').textContent.includes('موقوفة')`, 4000, 'حالة الجدولة الموقوفة');
  check(schedStatus1, 'الجدولة: سطر الحالة تحدّث إلى «موقوفة»');

  // 5) زر جرد الآن
  await evalJs(`document.getElementById('sched-run').click()`);
  const sweepOk = await waitCall('metrics:sweep-now');
  check(sweepOk, 'الجرد: زر «جرد الآن» نادى metrics:sweep-now');

  // 6) زر عقل خارجي
  await evalJs(`document.getElementById('tgl-bridge').click()`);
  const hostOk = await waitCall('bridge:hostStatus');
  const cmdOk = await waitCall('bridge:command');
  const cmdArg = (lastArgs('bridge:command') ?? [])[0];
  check(hostOk && cmdOk && cmdArg === 'open', 'الجسر: زر «عقل خارجي» قرأ الحالة ثم طلب الفتح (bridge:command open)');

  // 7) لقطة نافذة الإعدادات (الجدولة والجسر)
  const setShot = args.shots.replace(/\.png$/i, '') + '_settings.png';
  const setBytes = await shot(setShot);
  check(setBytes > 5000, `الصورة: لقطة الإعدادات (${Math.round(setBytes / 1024)}KB) → ${setShot}`);

  // 8) أخطاء JS داخل الصفحة + أخطاء الكونسول
  const uiErrors = await evalJs<string[]>(`window.__uiErrors || []`);
  check(uiErrors.length === 0, `الصفحة: لا أخطاء JS${uiErrors.length ? ` — ${uiErrors.slice(0, 2).join(' | ')}` : ''}`);
  check(consoleErrors.length === 0, `الكونسول: لا أخطاء${consoleErrors.length ? ` — ${consoleErrors.slice(0, 2).join(' | ')}` : ''}`);

  // 9) تغطية القنوات: كم قناة من preload اختُبرت فعلاً
  const used = [...new Set(calls.map((c) => c.ch))];
  const registered = Object.keys(fixtures).length + NEUTRAL.length;
  check(used.length >= 12, `التغطية: ${used.length} قناة IPC استُدعيت فعلاً من الواجهة (من ${registered} مسجّلة)`);
  console.log(`\nالقنوات المستدعاة: ${used.join(' · ')}`);
}

// ---------- التشغيل ----------
const args = parseArgv();
const hardStop = setTimeout(() => {
  console.error('انتهت المهلة الكلية للاختبار — يخرج بالرمز 2');
  app.exit(2);
}, args.timeoutMs);
hardStop.unref?.();

app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  let code = 0;
  try {
    await run(args);
  } catch (e: unknown) {
    failures.push(`استثناء غير متوقع: ${String((e as Error)?.message ?? e)}`);
    console.error('استثناء:', e);
  }
  clearTimeout(hardStop);
  console.log(`\nالنتيجة: ${passes.length} سليم · ${failures.length} فشل`);
  if (args.json) {
    console.log(
      JSON.stringify({ ok: failures.length === 0, pass: passes.length, fail: failures.length, failures, passes, screenshots: [args.shots.replace(/\.png$/i, '') + '_chat.png', args.shots.replace(/\.png$/i, '') + '_settings.png'], channels: [...new Set(calls.map((c) => c.ch))] }, null, 2),
    );
  }
  if (failures.length) {
    console.log('الإخفاقات:\n' + failures.map((f) => `  ✘ ${f}`).join('\n'));
    code = 1;
  }
  win?.destroy();
  app.exit(code);
});
