// جسر العقل الخارجي — ربط Electron: لوحة WebContentsView تعرض موقع الذكاء
// الاصطناعي داخل FreeCode، وقناة IPC تنفّذ أوامر الموقع عبر BridgeRunner
// بعد موافقة صريحة من المستخدم (نافذة نظام) وسجل تدقيق في .freecode/bridge-log.jsonl.
//
// ملاحظة أمنية مقصودة: الصفحة الخارجية غير موثوقة — لذلك:
//   • contextIsolation + sandbox، ولا يُعرض لها إلا واجهة صغيرة (fcBridge.call/enter).
//   • منع التنقل خارج النطاقات المسموحة ومنع فتح نوافذ جديدة ومنع كل الصلاحيات (كاميرا/موقع…).
//   • لا تُنفَّذ أي كتابة أو أمر إلا بموافقة، والأوامر المدمّرة محجوبة دائماً.
//   • حصر المسارات في مجلد المشروع عبر resolveInside (كتابةً وقراءةً).
import { BrowserWindow, WebContentsView, dialog, ipcMain } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BRIDGE_DEFAULT_HOSTS,
  BridgeRunner,
  bridgeAuditJsonl,
  bridgeHostAllowed,
  bridgeInstructions,
  bridgePageScript,
  bridgeStatusLine,
  formatBridgeAck,
  formatBridgeLog,
  parseBridgeCalls,
  type BridgeAuditEntry,
  type BridgeOutcome,
} from './extbridge';
import type { Permissions } from './rules';
import { ensureFreecodeIgnored, FREECODE_DIR } from './fcignore';
import { runShell } from './shell';
import type { TelemetrySink } from './telemetry';

export interface BridgeHostDeps {
  /** مجلد المشروع الحالي */
  root: () => string;
  mode: () => 'ask' | 'readonly';
  hosts: () => string[];
  url: () => string;
  /**
   * قواعد allow/ask/deny الحالية للمستخدم — تُقرأ حيّة عند كل استدعاء (لا نسخة مجمّدة)،
   * فتعديل القواعد من الإعدادات يسري على الجسر فوراً بلا إعادة فتح اللوحة.
   */
  permissions: () => Permissions | undefined;
  /** قياس الموثوقية: كل استدعاء جسري يُسجَّل هنا فيظهر في /reliability مثل أي أداة */
  telemetry?: () => TelemetrySink | null;
  /** إشعار في المحادثة */
  notice: (message: string, kind?: '' | 'err') => void;
  /** نص تقرير يُعرض في المحادثة */
  report: (title: string, markdown: string) => void;
  win: () => BrowserWindow | null;
}

const SETTLE = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ExtBridgeHost {
  private view: WebContentsView | null = null;
  private runner: BridgeRunner;
  private lastOutcome: BridgeOutcome | null = null;

  constructor(private readonly deps: BridgeHostDeps) {
    this.runner = new BridgeRunner({
      root: deps.root(),
      mode: deps.mode(),
      approve: (req) => this.askApprove(req),
      shell: (cmd, o) => runShell(cmd, { cwd: o.cwd, timeoutMs: o.timeoutMs, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } }),
      // قواعد المستخدم تُمرَّر دالةً: تُقرأ عند كل استدعاء فيسري أي تعديل فوراً
      permissions: () => this.deps.permissions(),
      audit: (entry) => this.audit(entry),
      onEvent: (line) => this.deps.notice(line),
    });
  }

  /** يعيد قراءة الوضع من الإعدادات (يُستدعى بعد تغييرها من الواجهة) */
  setModeFromSettings(): void {
    this.runner.setMode(this.deps.mode());
  }

  // ---------- الحالة ----------
  get isOpen(): boolean {
    return !!this.view && !this.view.webContents.isDestroyed();
  }

  statusLine(): string {
    return bridgeStatusLine({
      open: this.isOpen,
      url: this.url ?? undefined,
      root: this.deps.root(),
      mode: this.runner.mode,
      calls: this.runner.stats.calls,
      ok: this.runner.stats.ok,
      failed: this.runner.stats.failed,
      blocked: this.runner.stats.denied,
      stopping: this.runner.stoppedReason,
      rules: this.runner.rulesCount(),
    });
  }

  /** حالة منظّمة للواجهة (لوحة الإعدادات وزر الشريط) بلا حاجة لقراءة نص */
  hostStatus(): {
    open: boolean;
    url: string;
    root: string;
    mode: 'ask' | 'readonly';
    calls: number;
    ok: number;
    failed: number;
    denied: number;
    approved: number;
    rules: number;
    stopped: string | null;
    hosts: string[];
  } {
    return {
      open: this.isOpen,
      url: this.url,
      root: this.deps.root(),
      mode: this.runner.mode,
      calls: this.runner.stats.calls,
      ok: this.runner.stats.ok,
      failed: this.runner.stats.failed,
      denied: this.runner.stats.denied,
      approved: this.runner.stats.approved,
      rules: this.runner.rulesCount(),
      stopped: this.runner.stoppedReason,
      hosts: this.deps.hosts(),
    };
  }

  private url = 'https://arena.ai';

  // ---------- الفتح والإغلاق ----------
  async open(url?: string): Promise<{ ok: boolean; error?: string; url?: string }> {
    const win = this.deps.win();
    if (!win) return { ok: false, error: 'لا نافذة تطبيق مفتوحة.' };
    const target = (url ?? this.deps.url() ?? 'https://arena.ai').trim();
    const hosts = [...BRIDGE_DEFAULT_HOSTS, ...this.deps.hosts()];
    if (!bridgeHostAllowed(target, hosts)) {
      return { ok: false, error: `النطاق غير مسموح: ${target}\nالمسموح: ${hosts.join(' · ')}\n(أضف نطاقك في الإعدادات: bridgeHosts)` };
    }
    if (this.isOpen) {
      await this.view!.webContents.loadURL(target);
      this.url = target;
      await this.installScript();
      return { ok: true, url: target };
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'extbridge-preload.js'),
        partition: 'persist:freecode-bridge', // يحفظ تسجيل الدخول بين الجلسات
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.contentView.addChildView(view);
    this.view = view;
    this.url = target;
    this.layout();

    // منطقة الجسر معزولة: بلا صلاحيات وبلا تحميل من نطاقات أخرى
    const ses = view.webContents.session;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (e, targetUrl) => {
      if (!bridgeHostAllowed(targetUrl, hosts)) {
        e.preventDefault();
        this.deps.notice(`منع تنقّل الجسر خارج النطاقات المسموحة: ${targetUrl}`, 'err');
      }
    });
    view.webContents.on('will-attach-webview', (e) => e.preventDefault());

    ipcMain.removeHandler('extbridge:call');
    ipcMain.handle('extbridge:call', async (_e, raw: string) => this.handleFromPage(raw));
    ipcMain.removeHandler('extbridge:enter');
    ipcMain.handle('extbridge:enter', () => {
      // ضغط Enter حقيقي من العملية الرئيسية — أوثق من أحداث JS في الصفحات المعقّدة
      const wc = this.view?.webContents;
      if (!wc || wc.isDestroyed()) return { ok: false };
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      return { ok: true };
    });
    ipcMain.removeHandler('extbridge:hello');
    ipcMain.handle('extbridge:hello', () => ({ ok: true, version: 1 }));

    view.webContents.on('did-finish-load', () => {
      void this.installScript();
    });
    try {
      await view.webContents.loadURL(target);
    } catch (e: any) {
      this.deps.notice(`تعذّر فتح ${target}: ${String(e?.message ?? e)}`, 'err');
    }
    return { ok: true, url: target };
  }

  /** يحقن سكربت الجسر في الصفحة (idempotent) ويطبع تشخيص الاكتشاف */
  private async installScript(): Promise<void> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      const res = await wc.executeJavaScript(bridgePageScript(), true);
      this.deps.notice(`🌉 الجسر جاهز في الصفحة (${String(res).slice(0, 120)}) — الصق التعليمات من /bridge instructions ثم اطلب من الموقع مهمتك.`);
    } catch (e: any) {
      this.deps.notice(`تعذّر تفعيل سكربت الجسر: ${String(e?.message ?? e).slice(0, 200)}`, 'err');
    }
  }

  /** تشخيص: ما الذي اكتشفه السكربت فعلاً في الصفحة الحالية؟ */
  async diagnose(): Promise<{ ok: boolean; text: string }> {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return { ok: false, text: 'لوحة الجسر غير مفتوحة — /bridge open أولاً.' };
    const probe = `(() => {
      const SEL = ${JSON.stringify({ input: 'textarea, [contenteditable="true"], input[type="text"]', send: 'button[type="submit"], button[aria-label*="send" i], button[data-testid*="send" i]', message: 'article, [data-message-author-role], .prose, [class*="message" i], [class*="markdown" i], p' })};
      const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 12; };
      const ins = [...document.querySelectorAll(SEL.input)].filter(vis);
      const send = [...document.querySelectorAll(SEL.send)].filter(vis);
      const last = [...document.querySelectorAll(SEL.message)].filter(vis).pop();
      return {
        bridge: !!window.fcBridge, installed: !!window.__fcBridgeInstalled,
        host: location.hostname, title: document.title.slice(0, 80),
        inputs: ins.length, inputsTop: ins.map((e) => Math.round(e.getBoundingClientRect().top)).slice(0, 6),
        send: send.length, messages: document.querySelectorAll(SEL.message).length,
        lastTail: last ? String(last.innerText || '').slice(-160) : '',
      };
    })()`;
    try {
      const r = await wc.executeJavaScript(probe, true);
      const md = [
        '### تشخيص الجسر',
        '',
        '| المؤشر | القيمة |',
        '|---|---|',
        `| كائن الجسر (fcBridge) | ${r.bridge ? '✅ موجود' : '❌ مفقود'} |`,
        `| السكربت محقون | ${r.installed ? '✅ نعم' : '❌ لا'} |`,
        `| الصفحة | ${r.host} — ${r.title} |`,
        `| خانات الإدخال المرئية | ${r.inputs} (أعلى إحداثيات: ${r.inputsTop.join(', ') || '—'}) |`,
        `| أزرار الإرسال | ${r.send} |`,
        `| فقرات الرسائل | ${r.messages} |`,
        `| آخر نص في الصفحة | ${String(r.lastTail).replace(/\n/g, ' › ').slice(0, 120) || '—'} |`,
        '',
        '> إن كانت خانات الإدخال أو الرسائل صفراً فتصميم الموقع تغيّر: أرسل لي هذه القيم أو استخدم /bridge selectors لتجاوز المحددات.',
      ].join('\n');
      return { ok: true, text: md };
    } catch (e: any) {
      return { ok: false, text: `تعذّر التشخيص: ${String(e?.message ?? e).slice(0, 200)}` };
    }
  }

  close(): void {
    if (this.view && !this.view.webContents.isDestroyed()) {
      try {
        const win = this.deps.win();
        win?.contentView.removeChildView(this.view);
      } catch {
        /* أُزيل مسبقاً */
      }
      this.view.webContents.close();
    }
    this.view = null;
  }

  /** يُستدعى عند تغيير حجم النافذة: الجسر يحتلّ النصف الأيمن */
  layout(): void {
    const win = this.deps.win();
    if (!win || !this.view) return;
    const [w, h] = win.getContentSize();
    const width = Math.max(420, Math.floor(w * 0.55));
    this.view.setBounds({ x: Math.max(0, w - width), y: 0, width, height: h });
  }

  // ---------- استقبال أمر من الصفحة ----------
  private async handleFromPage(raw: string): Promise<string> {
    const parsed = parseBridgeCalls(String(raw ?? ''));
    if (!parsed.calls.length) {
      const why = parsed.errors.length ? parsed.errors.join(' · ') : 'لم أجد كتلة أمر صالحة';
      return `❌ لم يُنفَّذ شيء: ${why}\nاستخدم الصيغة: ${'@@FC_START@@'} {"tool":"read_file","args":{"path":"README.md"}} ${'@@FC_END@@'}`;
    }
    // التعليمات: استدعاء واحد لكل رد — لو تعدّدت ننفّذ الأول ونخبر بالباقي
    const [call, ...rest] = parsed.calls;
    const outcome = await this.runner.run(call);
    this.lastOutcome = outcome;
    const ack = formatBridgeAck(this.runner.callCount, call, { ok: outcome.ok, text: outcome.text, truncated: outcome.truncated });
    const extra = rest.length ? `\n(أُهمل ${rest.length} استدعاء إضافي — استدعاء واحد في كل رد.)` : '';
    if (outcome.done) this.deps.notice(`🏁 الموقع أعلن انتهاء المهمة: ${outcome.text.slice(0, 160)}`);
    return ack + extra;
  }

  // ---------- الموافقة والسجل ----------
  private async askApprove(req: { tool: string; title: string; summary: string }): Promise<boolean> {
    const win = this.deps.win();
    this.deps.notice(`⏳ الموقع يطلب: ${req.title} — ${req.summary}\nبانتظار موافقتك في نافذة النظام…`);
    if (!win) return false;
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['نفّذ', 'ارفض'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'طلب من العقل الخارجي',
      message: req.title,
      detail: `${req.summary}\n\nالمصدر: موقع مفتوح في لوحة الجسر (${this.url})\nالمشروع: ${this.deps.root()}\n\nالموافقة تعني التنفيذ الآن على جهازك.`,
    });
    return r.response === 0;
  }

  private audit(entry: BridgeAuditEntry): void {
    // 1) القياس: كل استدعاء جسري يصبح حدثاً في سجل الموثوقية نفسه (فيظهر في /reliability)
    try {
      this.deps.telemetry?.()?.record({
        kind: 'bridge',
        tool: entry.tool,
        decision: entry.decision,
        ok: entry.ok,
        ms: entry.ms,
        seq: entry.seq,
        // نص الفشل مفيد للإصلاح لاحقاً (يظهر في /reliability failures وفي اللوحة)
        ...(entry.ok ? {} : { note: this.runner.stats.lastError || entry.note || entry.decision }),
      });
    } catch {
      /* القياس لا يُسقط التنفيذ */
    }
    // 2) سجل التدقيق على القرص — والحارس يضمن ألا يُرفع المجلد إلى git
    try {
      const dir = path.join(this.deps.root(), FREECODE_DIR);
      fs.mkdirSync(dir, { recursive: true });
      ensureFreecodeIgnored(this.deps.root());
      fs.appendFileSync(path.join(dir, 'bridge-log.jsonl'), bridgeAuditJsonl(entry), 'utf8');
    } catch {
      /* السجل أفضل جهد */
    }
  }

  logReport(): string {
    const file = path.join(this.deps.root(), '.freecode', 'bridge-log.jsonl');
    let entries: BridgeAuditEntry[] = [];
    try {
      entries = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as BridgeAuditEntry)
        .filter((e) => e && typeof e.at === 'number');
    } catch {
      entries = [];
    }
    return formatBridgeLog(entries) + (this.lastOutcome ? `\n\n**آخر نتيجة:** ${this.lastOutcome.ok ? '✅' : '❌'} ${this.lastOutcome.text.split('\n')[0].slice(0, 160)}` : '');
  }

  // ---------- أوامر الواجهة ----------
  async command(action: string, arg: string): Promise<{ ok: boolean; text: string }> {
    const a = action.trim().toLowerCase();
    switch (a) {
      case 'open': {
        const r = await this.open(arg || undefined);
        return { ok: r.ok, text: r.ok ? `فُتحت لوحة الجسر على ${r.url}` : String(r.error) };
      }
      case 'close':
        this.close();
        return { ok: true, text: 'أُغلقت لوحة الجسر.' };
      case 'status':
        return { ok: true, text: this.statusLine() };
      case 'instructions': {
        const text = bridgeInstructions({ root: this.deps.root(), siteUrl: this.url });
        return { ok: true, text: `الصق هذا في أول رسالة داخل لوحة الموقع:\n\n\`\`\`\n${text}\n\`\`\`` };
      }
      case 'log':
        return { ok: true, text: this.logReport() };
      case 'test':
      case 'diagnose': {
        const d = await this.diagnose();
        return { ok: d.ok, text: d.text };
      }
      case 'mode': {
        const m = arg.trim().toLowerCase();
        if (m === 'readonly' || m === 'read-only' || m === 'قراءة') {
          this.runner.setMode('readonly');
          return { ok: true, text: 'وضع الجسر: قراءة فقط — الكتابة والأوامر مرفوضة (آمن للتجربة).' };
        }
        if (m === 'ask' || m === 'موافقة') {
          this.runner.setMode('ask');
          return { ok: true, text: 'وضع الجسر: موافقة — كل كتابة أو أمر يعرض نافذة تأكيد قبله.' };
        }
        return { ok: false, text: `الاستخدام: /bridge mode ask|readonly (الحالي: ${this.runner.mode})` };
      }
      case 'stop':
        this.runner.stop();
        return { ok: true, text: 'أُوقف الجسر — لن يُنفَّذ أي استدعاء جديد حتى /bridge resume.' };
      case 'resume':
        this.runner.resume();
        return { ok: true, text: 'عاد الجسر للعمل.' };
      case 'send': {
        // إرسال تعليمات الجسر إلى الصفحة تلقائياً (تعبئة خانة الإدخال + إرسال)
        const wc = this.view?.webContents;
        if (!wc || wc.isDestroyed()) return { ok: false, text: 'افتح اللوحة أولاً: /bridge open' };
        const text = bridgeInstructions({ root: this.deps.root(), siteUrl: this.url });
        const escaped = JSON.stringify(text);
        const filled = await wc
          .executeJavaScript(
            `(() => { const el = [...document.querySelectorAll('textarea,[contenteditable="true"],input[type="text"]')].filter((e)=>{const r=e.getBoundingClientRect();return r.width>30&&r.height>12;}).pop(); if(!el) return false; el.focus(); if (el.tagName==='TEXTAREA'||el.tagName==='INPUT'){ const p = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p,'value').set.call(el, ${escaped}); el.dispatchEvent(new Event('input',{bubbles:true})); } else { document.execCommand('insertText', false, ${escaped}); } return true; })()`,
            true,
          )
          .catch(() => false);
        if (!filled) return { ok: false, text: 'لم أجد خانة إدخال في الصفحة — جرّب /bridge test وأرسل لي التشخيص.' };
        await SETTLE(250);
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'char', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
        return { ok: true, text: 'أُرسلت تعليمات الجسر إلى الموقع — بانتظار أول أمر.' };
      }
      default:
        return {
          ok: false,
          text: [
            'استخدام الجسر:',
            '  /bridge open [الرابط]    فتح لوحة الموقع (افتراضياً arena.ai)',
            '  /bridge send            إرسال تعليمات الجسر إلى الموقع تلقائياً',
            '  /bridge test            تشخيص: هل اكتُشفت الخانة والأزرار والرسائل؟',
            '  /bridge status          حالة الجسر وعدد الاستدعاءات',
            '  /bridge log             سجل كل ما نُفِّذ (وقرارات الموافقة)',
            '  /bridge mode ask|readonly   موافقة على الكتابة أم قراءة فقط',
            '  /bridge stop / resume   مفتاح إيقاف فوري',
            '  /bridge instructions    نص التعليمات للصقه يدوياً',
            '  /bridge close           إغلاق اللوحة',
          ].join('\n'),
        };
    }
  }
}
