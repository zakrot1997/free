import { $, baseName, clear, fmtTokens, h } from './util';
import { icon } from './icons';
import { S, hooks } from './state';
import { addNotice, addReport, INIT_PROMPT } from './chat';
import { clearPendingImages, initAttach, pendingImages } from './attach';
import { refreshAgents } from './panels';

function formatEngines(engines: Record<string, { available: boolean; version?: string; reason?: string }>): string {
  return Object.entries(engines)
    .map(([k, v]) => `${k}: ${v.available ? `متاح ${v.version ?? ''}` : `غير متاح — ${v.reason ?? ''}`}`)
    .join('\n');
}

const input = $<HTMLTextAreaElement>('input');
const sendBtn = $<HTMLButtonElement>('send');
const stopBtn = $<HTMLButtonElement>('stop');
const popup = $<HTMLDivElement>('popup');

interface Opt {
  key: string; // ما يظهر
  desc?: string;
  icon: string;
  apply: () => void;
}
let opts: Opt[] = [];
let sel = 0;
let mentionToken = 0;

// ---------- أوامر الشرطة المائلة ----------

interface Slash {
  name: string;
  desc: string;
  /** يقبل نصاً بعد اسم الأمر (مثل: /review src/api) */
  args?: boolean;
  run: (arg: string) => void | Promise<void>;
}

async function setMode(mode: 'plan' | 'act'): Promise<void> {
  hooks.applySettings(await window.api.setSettings({ mode }));
}

/** أمر يرسل طلباً جاهزاً للوكيل */
const promptCmd = (name: string, desc: string, text: string, args = false): Slash => ({
  name,
  desc,
  args,
  run: (arg) => hooks.sendMessage(arg ? `${text}\n\nتفاصيل إضافية: ${arg}` : text),
});

const BUILTIN: Slash[] = [
  { name: '/new', desc: 'محادثة جديدة', run: () => hooks.newChat() },
  { name: '/plan', desc: 'وضع الخطة: قراءة فقط', run: () => setMode('plan') },
  { name: '/act', desc: 'وضع التنفيذ', run: () => setMode('act') },
  {
    name: '/undo',
    desc: 'تراجع عن آخر تعديلات الوكيل',
    run: async () => {
      const r = await window.api.undo();
      addNotice(r.restored.length ? `تم التراجع عن: ${r.restored.map((f) => f.path).join(', ')}` : 'لا توجد تعديلات للتراجع عنها.');
    },
  },
  {
    name: '/compact',
    desc: 'لخّص المحادثة لتوفير السياق',
    run: async () => {
      addNotice('جارٍ تلخيص المحادثة…');
      await window.api.compact();
    },
  },
  { name: '/init', desc: 'أنشئ FREECODE.md لهذا المشروع', run: () => hooks.sendMessage(INIT_PROMPT()) },
  {
    name: '/memory',
    desc: 'اعرض ذاكرة المشروع (.freecode/memory.md)',
    run: async () => {
      const m = await window.api.readMemory();
      addNotice(m.text ? `ذاكرة المشروع (${m.path}):\n${m.text}` : 'لا ذاكرة محفوظة بعد. اكتب ‎#ملاحظة‎ في المحرر لحفظ تفضيل، أو اطلب من الوكيل أداة remember.');
    },
  },
  {
    name: '/processes',
    desc: 'اعرض العمليات الخلفية وأوقفها',
    run: async () => {
      const list = await window.api.listProcesses();
      if (!list.length) return addNotice('لا عمليات خلفية. الوكيل يشغّلها بأداة start_process (خادم تطوير مثلاً).');
      addNotice(`العمليات:\n${list.map((p) => `• [${p.id}] ${p.running ? 'تعمل' : 'انتهت'} — ${p.command.slice(0, 80)}`).join('\n')}`);
    },
  },
  promptCmd('/review', 'راجع تعديلات git الحالية دون تغيير شيء', 'راجع التعديلات الحالية في هذا المشروع (استخدم git status و git diff) وأعطني ملاحظات مرتبة حسب الأهمية: أخطاء محتملة، مخاطر، ثم تحسينات. لا تعدّل أي ملف.', true),
  promptCmd('/commit', 'أنشئ commit برسالة واضحة', 'اطّلع على git status و git diff، ثم أنشئ commit واحداً برسالة واضحة بصيغة conventional commits. لا تنفّذ push.'),
  promptCmd('/test', 'شغّل الاختبارات وأصلح الفشل', 'شغّل اختبارات هذا المشروع (اكتشف الأمر المناسب من package.json أو ملفات الإعداد). إن فشل شيء فحلّل السبب وأصلحه ثم أعد التشغيل حتى تنجح.', true),
  {
    name: '/export',
    desc: 'صدّر المحادثة (Markdown أو JSON بـ/export json)',
    args: true,
    run: async (arg: string) => {
      const r = await window.api.exportSession(arg.trim() === 'json' ? 'json' : 'md');
      if (r.canceled) return;
      addNotice(r.ok ? `صُدّرت المحادثة إلى: ${r.path}` : `تعذّر التصدير: ${r.error}`, r.ok ? '' : 'err');
    },
  },
  {
    name: '/stats',
    desc: 'إحصاءات الجلسة: الرسائل والأدوات والتوكنات ومدة العمل',
    run: async () => {
      const r = await window.api.sessionStats();
      if (!r.ok) return addNotice(String(r.error ?? 'لا إحصاءات'), 'err');
      const mins = Math.round(((r.durationMs ?? 0) / 60000) * 10) / 10;
      addReport(
        `إحصاءات الجلسة: ${r.title ?? ''}`,
        [
          `| البند | القيمة |`,
          `|---|---|`,
          `| الرسائل | ${r.messages} (${r.user} منك · ${r.assistant} من الوكيل) |`,
          `| استدعاءات الأدوات | ${r.toolCalls} |`,
          `| الصور المرفقة | ${r.images} |`,
          `| توكنات السياق الآن | ${r.tokensNow} من ${r.budget} |`,
          `| توكنات المحادثة (تقديري) | ${r.tokens} |`,
          `| مدة الجلسة | ${mins} دقيقة |`,
          r.model ? `| الموديل | ${r.model} |` : '',
          '',
          r.tools?.length ? `**الأدوات الأكثر استخداماً:**\n\n${r.tools.slice(0, 10).map((t) => `- \`${t.name}\` × ${t.count}`).join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  },
  {
    name: '/models-eval',
    desc: 'قيّم الموديلات: /models-eval [أسماء…] · quick · list · from-project [--limit N] (مهام من أعطال مشروعك) · share (بطاقة مشاركة)',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a === 'list') {
        const t = await window.api.evalTasks();
        return addReport(
          'بنك مهام تقييم الموديلات',
          t.tasks.map((x) => `- \`${x.id}\` · ${x.title} _(${x.category})_\n${(x.acceptance ?? []).map((a) => `    ◦ ${a}`).join('\n')}`).join('\n') +
            `\n\n**المجموعة السريعة:** ${t.quick.map((q) => `\`${q}\``).join(' · ')}`,
        );
      }
      if (/^from-project\b/.test(a)) {
        const limit = Number((/--limit\s+(\d+)/.exec(a) ?? [])[1] ?? 3);
        const dry = /--list|--dry\b/.test(a);
        addNotice(dry ? 'أستخرج المهام القابلة للتحقق من أعطال مشروعك…' : `أستخرج مهاماً من أعطال مشروعك ثم أقيّم عليها (${limit})…`);
        const r = await window.api.evalProjectTasks({ limit, dryRun: dry });
        if (!r.ok) return addNotice(String(r.error ?? 'تعذّر'), 'err');
        if (r.dryRun) return addReport('مهام من عطل المشروع', r.text);
        addReport('تقييم على أعطال مشروعك', r.markdown ?? r.text);
        return;
      }
      if (a === 'share') {
        const r = await window.api.evalShareCard();
        return addNotice(r.ok ? `جاهزة للمشاركة (أرقام فقط، بلا أي كود من مشروعك):\n${r.html}\n${r.svg}\n${r.png ?? ''}` : String(r.error ?? 'تعذّر'), r.ok ? '' : 'err');
      }
      const quick = /\bquick\b/.test(a);
      const models = a.split(/\s+/).filter((x) => x && x !== 'quick');
      const list = models.length ? models : (S.settings?.model ? [S.settings.model] : []);
      if (!list.length) return addNotice('حدّد موديلاً أو أكثر: /models-eval freellmapi/auto', 'err');
      addNotice(`بدأ التقييم على ${list.length} موديل… تصلك نتيجة كل مهمة هنا، والتقرير في النهاية.`);
      const r = await window.api.evalModels({ models: list, quick });
      if (!r.ok) return addNotice(r.error ?? 'تعذّر التقييم', 'err');
      addReport('تقييم الموديلات', r.markdown ?? '');
      if (r.path) addNotice(`حُفظ التقرير في: ${r.path}`);
    },
  },
  {
    name: '/ab-test',
    desc: 'قارن نسختين: /ab-test <ملف-النسخة-ب> [--all|--prompt "<مهمة>"] [--repeat N] · أو محور سياق الوكيل: /ab-test ctx repoMap|autoVerify',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (!a) {
        addNotice('الاستخدام: /ab-test <ملف-النسخة-ب> [--eval|--all|--prompt "مهمة"] [--repeat 2]\nالمقارنة تكون بين ملف تعليمات المشروع الحالي (FREECODE.md) والملف الذي تسمّيه — على نفس المهام ونفس الموديل.');
        return;
      }
      // محور سياق الوكيل: repoMap أو autoVerify مفعّل/معطّل — نفس المهام ونفس التعليمات
      if (/^ctx\b/.test(a)) {
        const axis = (/\bctx\s+(repoMap|autoVerify|budget|memory)\b/.exec(a) ?? [])[1] as 'repoMap' | 'autoVerify' | 'budget' | 'memory' | undefined;
        if (!axis) return addNotice('حدّد المحور: /ab-test ctx repoMap · autoVerify · budget · memory', 'err');
        const rep = Number((/--repeat\s+(\d+)/.exec(a) ?? [])[1] ?? 1);
        addNotice(`أقارن محور «${axis}» (مفعّل مقابل معطّل) على المجموعة السريعة × ${Math.max(1, Math.min(3, rep))} تكرار…`);
        const r = await window.api.abRun({ axis, mode: 'quick', repeat: rep });
        if (!r.ok) return addNotice(String(r.error ?? 'تعذّر'), 'err');
        return addReport('مقارنة A/B لسياق الوكيل', r.markdown ?? '');
      }
      const mode: 'quick' | 'all' | 'prompt' = /--all\b/.test(a) ? 'all' : /--prompt\b/.test(a) ? 'prompt' : 'quick';
      const prompt = (/--prompt\s+"([^"]+)"/.exec(a) ?? /--prompt\s+(.+?)(?:\s+--|$)/.exec(a) ?? [])[1] ?? '';
      const repeat = Number((/--repeat\s+(\d+)/.exec(a) ?? [])[1] ?? 1);
      const variantB = a.replace(/--(all|eval|prompt|repeat)\b(\s+"[^"]*"|\s+\S+)?/g, '').trim();
      if (!variantB) return addNotice('اكتب مسار ملف النسخة الثانية.', 'err');
      if (mode === 'prompt' && !prompt) return addNotice('مع --prompt اكتب المهمة: /ab-test b.md --prompt "أضف دالة جمع"', 'err');
      addNotice(`أقارن النسختين (${mode === 'all' ? 'البنك الكامل' : mode === 'prompt' ? 'مهمة واحدة' : 'المجموعة السريعة'}) × ${Math.max(1, Math.min(3, repeat))} تكرار…`);
      const r = await window.api.abRun({ variantB, mode, prompt, repeat });
      if (!r.ok) return addNotice(String(r.error ?? 'تعذّر'), 'err');
      addReport('مقارنة A/B للتعليمات', r.markdown ?? '');
    },
  },
  {
    name: '/dashboard',
    desc: 'لوحة القياس: الموثوقية وتقييم الموديلات معاً + اتجاه زمني + قراءة الأرقام (/dashboard sweep لجرد محاور السياق الآن · /dashboard export للتصدير · /dashboard badge لملصق آخر جولة PNG)',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a === 'export') {
        const r = await window.api.metricsExport();
        return addNotice(r.ok ? `صُدّرت اللوحة إلى:\n${r.md}\n${r.js}` : `تعذّر التصدير: ${r.error}`, r.ok ? '' : 'err');
      }
      const badge = async (): Promise<void> => {
        const b = await window.api.metricsBadge();
        if (!b.ok) return addNotice(`تعذّر إنشاء الملصق: ${b.error}`, 'err');
        addNotice(
          `🎴 ملصق آخر جولة (${b.project}): ${b.best ? `الأفضل «${b.best}» ${b.bestRate}%` : 'لا فائز'} — ${b.models} موديل\nحُفظ في: ${b.png}`,
        );
      };
      if (a === 'badge') return badge();
      const sweepNow = async (): Promise<void> => {
        addNotice('🔁 جرد الآن: يقيس محاور السياق على مساحة المشروع عبر موديلات إعداد الجرد…');
        const s = await window.api.metricsSweepNow();
        if (!s.ok) return addNotice(`تعذّر الجرد: ${s.error}`, 'err');
        const head = s.regressions ? '⚠️' : s.improvements ? '✅' : 'ℹ️';
        addNotice(
          [
            `${head} ${s.digestLine}`,
            s.created ? 'أُنشئ إعداد جرد جديد (.freecode/sweep.json) بموديلك الحالي — عدّله متى شئت.' : '',
            s.notified ? 'أُرسل إشعار نظام بالانحدار.' : '',
            `الجردات المحفوظة: ${s.runs}${s.seriesRuns ? ` · السلسلة: ${s.seriesRuns} جردات · انحدارات مرصودة: ${s.seriesRegressions}` : ''} · أعد فتح /dashboard لرؤية القسم المحدَّث.`,
          ]
            .filter(Boolean)
            .join('\n'),
          s.regressions ? 'err' : '',
        );
      };
      if (a === 'sweep' || a === 'جرد') return sweepNow();
      const r = await window.api.metricsDashboard();
      if (!r.ok) return addNotice('تعذّر بناء اللوحة.', 'err');
      addReport('لوحة القياس', r.markdown, [
        { label: '🔁 جرد الآن (جرد محاور السياق)', run: sweepNow },
        { label: '🎴 صدّر ملصق آخر جولة PNG', run: badge },
        { label: '🗂 تصدير اللوحة md+json', run: async () => {
            const e = await window.api.metricsExport();
            addNotice(e.ok ? `صُدّرت اللوحة إلى:\n${e.md}\n${e.js}` : `تعذّر التصدير: ${e.error}`, e.ok ? '' : 'err');
          } },
      ]);
      if (r.turns) addNotice(`ملخص سريع: ${r.line}`);
    },
  },
  {
    name: '/reliability',
    desc: 'تقرير الموثوقية: دقة تطبيق التعديلات، فشل التحقق، أكثر الأدوات فشلاً، ونقرات الموافقة',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a === 'reset') {
        await window.api.telemetryClear();
        return addNotice('صُفّر سجل القياس المحلي.');
      }
      const r = await window.api.telemetrySummary();
      if (!r.summary.turns) return addNotice(r.text);
      addReport('الموثوقية (قياس محلي)', r.text + `\n\n**عدد الأحداث المسجّلة:** ${r.count} · **أعطال حديثة:** ${r.fails}` + '\n\nلتقليل النقرات: زر «كل تعديلات هذا الملف» في بطاقة الموافقة، أو «وافق على الباقي في هذه الدورة»، أو أضف قاعدة `allow` من الزر نفسه. `/reliability reset` يصفّر السجل.');
    },
  },
  {
    name: '/diagnostics',
    desc: 'أعطال مسجّلة في سجل الموثوقية · /diagnostics fix يرسلها للوكيل ليصلحها',
    args: true,
    run: async (arg: string) => {
      const fix = arg.trim() === 'fix';
      const r = await window.api.telemetryFailures({ asTask: fix });
      if (!r.count) return addNotice('لا أعطال مسجّلة — كل شيء يعمل بسلاسة.');
      addReport('تشخيص الأعطال', r.text);
      if (fix && r.task) {
        hooks.sendMessage(r.task);
        addNotice('أُرسلت الأعطال للوكيل ليحلّلها ويصلحها.');
      } else {
        addNotice('لإصلاحها: /diagnostics fix (يرسلها للوكيل مع طلب تحليل السبب الجذري).');
      }
    },
  },
  {
    name: '/sandbox',
    desc: 'وضع الحماية: /sandbox (الحالة) · /sandbox on|auto|docker|off · /sandbox image <صورة> · /sandbox net on|off',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      const st = await window.api.sandboxStatus();
      if (!a || a === 'status') return addReport('وضع الحماية (Sandbox)', st.text + '\n\n```\n' + formatEngines(st.engines) + '\n```');
      if (a === 'on') {
        const r = await window.api.sandboxSet({ mode: 'auto' });
        return addNotice(r.text);
      }
      if (a === 'off') {
        const r = await window.api.sandboxSet({ mode: 'off' });
        return addNotice(r.text);
      }
      if (a === 'docker' || a === 'podman') {
        const r = await window.api.sandboxSet({ mode: a });
        return addNotice(r.text, r.text.includes('غير متاح') ? 'err' : '');
      }
      if (a.startsWith('image ')) {
        const r = await window.api.sandboxSet({ image: a.slice(6).trim() });
        return addNotice(r.text);
      }
      if (a.startsWith('net ')) {
        const r = await window.api.sandboxSet({ network: a.slice(4).trim() !== 'off' });
        return addNotice(r.text);
      }
      addNotice('استخدام: /sandbox · /sandbox on|auto|docker|podman|off · /sandbox image <صورة> · /sandbox net on|off');
    },
  },
  {
    name: '/lsp',
    desc: 'خوادم اللغة: /lsp (الحالة) · /lsp trust · /lsp off|on <اسم>',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a === 'trust') {
        const r = await window.api.lspTrust();
        return addNotice(r.ok ? 'وثقت بإعداد خوادم اللغة في المشروع — فُعّل.' : String(r.error ?? 'تعذّر'), r.ok ? '' : 'err');
      }
      if (a.startsWith('off ') || a.startsWith('on ')) {
        const off = a.startsWith('off ');
        const r = await window.api.lspToggle(a.slice(off ? 4 : 3).trim());
        return addNotice(off ? `أُوقف: ${r.disabled.join(', ') || '(لا شيء)'}` : `المعطّلة الآن: ${r.disabled.join(', ') || '(لا شيء)'}`);
      }
      const st = await window.api.lspStatus();
      if (!st.ok) return addNotice(String(st.error ?? 'غير متاح'), 'err');
      addReport(
        'خوادم اللغة (LSP)',
        [
          `| الخادم | متاح | يعمل | الامتدادات |`,
          `|---|---|---|---|`,
          ...st.servers.map((x) => `| ${x.name} | ${x.available ? '✅' : `❌ ${x.reason ?? ''}`} | ${x.running ? '🟢' : '—'} | ${x.extensions.join(', ')} |`),
          '',
          st.servers.every((x) => !x.available)
            ? 'لا خادم لغة مثبّت على جهازك. ثبّت واحداً مثل `npm i -g typescript-language-server typescript` أو `pip install pyright`، أو أضف خادمك في `.freecode/lsp.json`. (الوكيل يعمل بأدوات البحث النصي حتى بدونها.)'
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    },
  },
  {
    name: '/bridge',
    desc: 'جسر IDE: /bridge (الحالة) · /bridge on|off · /bridge token (رمز جديد) · /bridge port <رقم>',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a === 'on') {
        const r = await window.api.bridgeStart();
        if (!r.ok) return addNotice(`تعذّر تشغيل الجسر: ${r.error}`, 'err');
        const st = await window.api.bridgeStatus();
        return addReport('جسر IDE', st.text);
      }
      if (a === 'off') {
        await window.api.bridgeStop();
        return addNotice('أُوقف جسر IDE.');
      }
      if (a === 'token') {
        const r = await window.api.bridgeRotate();
        return addNotice(`رمز جديد: ${r.token}${r.restarted ? ' (أُعيد تشغيل الجسر)' : ''}`);
      }
      if (a.startsWith('port ')) {
        const r = await window.api.bridgeStart({ port: Number(a.slice(5).trim()) });
        return addNotice(r.ok ? `الجسر يعمل على المنفذ الجديد.` : `تعذّر: ${r.error}`, r.ok ? '' : 'err');
      }
      const st = await window.api.bridgeStatus();
      addReport('جسر IDE', `${st.text}\n\n${st.token ? `الرمز الكامل:\n\n\`\`\`\n${st.token}\n\`\`\`` : ''}`);
    },
  },
  {
    name: '/security',
    desc: 'افحص المشروع أمنياً: أسرار مكشوفة · ملفات حساسة في git · أنماط خطرة · ثغرات الاعتماديات (/security deep لمراجعة بالوكيل)',
    args: true,
    run: async (arg: string) => {
      const deep = arg.trim() === 'deep';
      addNotice('أفحص المشروع… (قد يستغرق لحظات مع فحص الاعتماديات)');
      const r = await window.api.securityScan({ deps: !deep });
      if (r.error) return addNotice(String(r.error), 'err');
      addReport('تقرير الفحص الأمني', r.text);
      if (deep) {
        const summary = r.findings.map((f) => `- [${f.severity}] ${f.title}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`).join('\n');
        await hooks.sendMessage(
          `راجع أمنياً النتائج التي وجدها الفحص الآلي وأصلح الخطير منها:\n${summary || '(لا نتائج)'}\n\nافحص السياق حول كل نتيجة، وأصلح ما يمكن إصلاحه بأمان ثم أخبرني بما غيّرته.`,
        );
      }
    },
  },
  {
    name: '/plugins',
    desc: 'الإضافات: /plugins (قائمة) · install <رابط|مسار> [--yes|--cancel|--deep] · update <اسم> [--yes] · remove <اسم> · new <اسم> · trust <اسم> · on|off <اسم>',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();

      // ---- سوق الإضافات: تنزيل من مستودع git بمراجعة إلزامية ثم تثبيت صريح ----
      if (a === 'installed') {
        const r = await window.api.pluginsInstalled();
        return addReport('إضافاتك المثبّتة من مصدر خارجي', r.text);
      }
      if (a.startsWith('install ')) {
        const rest = a.slice(8).trim();
        const cancel = /(^|\s)--cancel$/.test(rest);
        const yes = /(^|\s)--yes$/.test(rest);
        const force = /(^|\s)--force$/.test(rest);
        const model2 = (/--model2[= ]([^\s]+)/.exec(rest) ?? [])[1] ?? '';
        const model3 = (/--model3[= ]([^\s]+)/.exec(rest) ?? [])[1] ?? '';
        const source = rest
          .replace(/\s*--model[23][= ][^\s]+/g, '')
          .replace(/\s*--(cancel|yes|force|deep)$/g, '')
          .trim();
        if (!source) return addNotice('اكتب مصدر الإضافة: /plugins install https://github.com/user/plugin-repo', 'err');
        if (cancel) {
          const r = await window.api.pluginsCancel();
          return addNotice(r.ok ? 'أُلغيت المراجعة وحُذفت الملفات المؤقتة.' : String(r.error ?? 'لا مراجعة معلّقة.'), r.ok ? '' : 'err');
        }
        addNotice(yes ? `أنزّل «${source}» وأثبّت…` : `أنزّل «${source}» للمراجعة (لن يُثبَّت قبل موافقتك)…`);
        const deep = /(^|\s)--deep$/.test(rest) || !!model2;
        if (model2 && model3) addNotice(`مراجعة بموديلين متقاطعَين (${model2}) + محكّم ثالث للخلاف (${model3})…`);
        else if (model2) addNotice(`مراجعة بموديلين متقاطعَين (${model2}) — حكمان مستقلان والأشد تحفظاً يفوز…`);
        else if (deep) addNotice('مراجعة ذكية بموديل ثانٍ قيد التنفيذ…');
        const rev = await window.api.pluginsReview(source, { deep, model2: model2 || undefined, model3: model3 || undefined });
        if (!rev.ok) return addNotice(String(rev.error || 'تعذّرت المراجعة'), 'err');
        addReport(`مراجعة إضافة: ${rev.slug}`, rev.text);
        if (!yes) return;
        const app = await window.api.pluginsApply(source, { force });
        if (app.ok) {
          addNotice(`ثُبّتت الإضافة. المهارات والقواعد فعالة الآن.`);
          addReport('نتيجة التثبيت', String(app.text ?? ''));
          return;
        }
        if (app.needForce) return addNotice(String(app.error), 'err');
        return addNotice(String(app.error ?? 'تعذّر التثبيت'), 'err');
      }
      if (a.startsWith('update ')) {
        const parts = a.slice(7).trim().split(/\s+/);
        const slug = parts[0];
        const yes = parts.includes('--yes');
        if (!slug) return addNotice('اكتب اسم الإضافة: /plugins update <الاسم> [--yes]', 'err');
        addNotice(`أتحقق من تحديث «${slug}»…`);
        const r = await window.api.pluginsUpdate(slug, { apply: yes });
        if (!r.ok) return addNotice(String(r.error ?? 'تعذّر التحديث'), 'err');
        if (yes) return addNotice(String(r.text ?? ''));
        addReport('مراجعة التحديث', String(r.text ?? ''));
        if (r.changed) addNotice(`يوجد تغيير — نفّذ: /plugins update ${slug} --yes`);
        return;
      }
      if (a.startsWith('remove ')) {
        const slug = a.slice(7).trim();
        if (!slug) return addNotice('اكتب اسم الإضافة: /plugins remove <الاسم>', 'err');
        const r = await window.api.pluginsRemove(slug);
        return addNotice(String(r.ok ? r.text : r.error), r.ok ? '' : 'err');
      }

      if (a.startsWith('new ')) {
        const r = await window.api.scaffoldPlugin(a.slice(4).trim());
        addNotice(r.ok ? `أُنشئت إضافة في: ${r.dir} — عدّل plugin.json والمهارات ثم /plugins.` : String(r.error ?? 'تعذّر الإنشاء'), r.ok ? '' : 'err');
        return;
      }
      if (a.startsWith('trust ')) {
        const r = await window.api.trustPlugin(a.slice(6).trim());
        addNotice(r.ok ? 'وثقت بالإضافة — فُعّلت hooks/صلاحياتها/خوادمها.' : String(r.error ?? 'تعذّر'), r.ok ? '' : 'err');
        return;
      }
      if (a.startsWith('on ') || a.startsWith('off ')) {
        const off = a.startsWith('off ');
        const r = await window.api.togglePlugin(a.slice(off ? 4 : 3).trim());
        if (!r.ok) return addNotice(String(r.error ?? 'تعذّر'), 'err');
        addNotice(r.disabled ? 'عُطّلت الإضافة.' : 'فُعّلت الإضافة.');
        return;
      }
      const { plugins, dir } = await window.api.listPlugins();
      if (!plugins.length) {
        addNotice(`لا إضافات. أنشئ واحدة بـ /plugins new اسم-الإضافة، أو ضع مجلداً فيه plugin.json في:\n${dir}\nأو في .freecode/plugins داخل مشروعك.`);
        return;
      }
      addNotice(
        `الإضافات (${plugins.length}):\n` +
          plugins
            .map((p) => `• ${p.slug}${p.version ? ` v${p.version}` : ''} [${p.status}] — ${p.description || 'بلا وصف'}\n   مهارات ${p.counts.skills} · hooks ${p.counts.hooks} · قواعد ${p.counts.rules} · MCP ${p.counts.mcp}${p.error ? `\n   ${p.error}` : ''}`)
            .join('\n'),
      );
    },
  },
  {
    name: '/agents',
    desc: 'وكلاء متوازون: /agents <مهمة> يشغّل وكيلاً في نسخة معزولة · merge <id|all> · discard <id> · clear',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      const info = await window.api.listAgents();
      if (!info.git) return addNotice(String(info.error ?? 'هذه الميزة تحتاج مستودع git.'), 'err');
      if (!a || a === 'list') {
        const list = info.agents ?? [];
        if (!list.length) return addNotice('لا وكلاء. اكتب: /agents أضف اختبارات للوحدة أ');
        addNotice(
          `الوكلاء (${list.length}/${info.max}):\n` +
            list
              .map((x) => `• ${x.label} [${x.statusText}] ${x.branch || '—'}${x.files.length ? ` · ${x.files.length} ملف` : ''}`)
              .join('\n'),
        );
        await refreshAgents();
        return;
      }
      if (a.startsWith('merge ')) {
        const who = a.slice(6).trim();
        const targets = who === 'all' ? (info.agents ?? []).filter((x) => x.status === 'done') : (info.agents ?? []).filter((x) => x.id === who || x.label === who);
        if (!targets.length) return addNotice('لا وكيل مطابق للدمج.', 'err');
        for (const t of targets) {
          const r = await window.api.mergeAgent(t.id, false);
          addNotice(r.ok ? `«${t.label}»: ${r.message}` : `«${t.label}»: تعذّر الدمج — ${r.message}${r.conflicts.length ? ` (${r.conflicts.slice(0, 5).join(', ')})` : ''}`, r.ok ? '' : 'err');
        }
        await refreshAgents();
        return;
      }
      if (a.startsWith('discard ')) {
        const who = a.slice(8).trim();
        const targets = who === 'all' ? (info.agents ?? []) : (info.agents ?? []).filter((x) => x.id === who || x.label === who);
        if (!targets.length) return addNotice('لا وكيل مطابق.', 'err');
        for (const t of targets) {
          const r = await window.api.discardAgent(t.id);
          addNotice(`«${t.label}»: ${r.message}`, r.ok ? '' : 'err');
        }
        await refreshAgents();
        return;
      }
      if (a === 'clear') {
        const r = await window.api.clearAgents();
        addNotice(r.message);
        await refreshAgents();
        return;
      }
      // وإلا: نص حرّ = مهمة وكيل جديد
      const label = a.split(/\s+/).slice(0, 4).join(' ');
      const r = await window.api.startAgents([{ label, task: a }]);
      addNotice(r.ok ? `بدأ وكيل «${label}» في نسخة معزولة — تابعه في لوحة «الوكلاء».` : `تعذّر البدء: ${r.error}`, r.ok ? '' : 'err');
      await refreshAgents();
    },
  },
  {
    name: '/skills',
    desc: 'اعرض المهارات المتاحة، أو /skills new <اسم> لإنشاء قالب مهارة',
    args: true,
    run: async (arg: string) => {
      const a = arg.trim();
      if (a.startsWith('new ')) {
        const name = a.slice(4).trim();
        const r = await window.api.scaffoldSkill(name);
        addNotice(r.ok ? `أُنشئ قالب المهارة في: ${r.file} — حرّره ثم أعد الرسالة.` : String(r.error ?? 'تعذّر الإنشاء'), r.ok ? '' : 'err');
        await loadSkills();
        return;
      }
      const { skills, projectDir } = await window.api.listSkills();
      if (!skills.length) {
        addNotice(`لا مهارات بعد. أنشئ واحدة بـ /skills new اسم-المهارة، أو أضف مجلداً فيه SKILL.md في: ${projectDir ?? '(اختر مشروعاً)'}`);
        return;
      }
      addNotice(`المهارات:\n${skills.map((k) => `• /${k.name} — ${k.description}${k.source === 'user' ? ' (مستخدم)' : ''}`).join('\n')}`);
    },
  },
  { name: '/settings', desc: 'الإعدادات وخوادم MCP', run: () => hooks.openSettings() },
  {
    name: '/help',
    desc: 'عرض الاختصارات',
    run: () =>
      addNotice('@ملف لإرفاق ملف · صورة باللصق أو زر «صورة» · /plan للتحليل بدون تعديل · /undo للتراجع · /compact لتلخيص المحادثة · /init لإنشاء FREECODE.md · /skills للمهارات · #لحفظ ملاحظة في الذاكرة · أوامرك المخصصة في .freecode/commands · Esc لإيقاف الوكيل'),
  },
];

let custom: Slash[] = [];
/** أوامر المهارات: تصبح /اسم-المهارة وتدعو الوكيل لتنفيذها نصاً */
let skillCmds: Slash[] = [];
const allSlash = (): Slash[] => [...BUILTIN, ...custom, ...skillCmds];

/** يحمّل مهارات المشروع ليصبح كل منها أمراً: /my-skill تفاصيل */
export async function loadSkills(): Promise<void> {
  try {
    const { skills } = await window.api.listSkills();
    const taken = new Set([...BUILTIN, ...custom].map((b) => b.name));
    skillCmds = skills
      .filter((k) => !taken.has(`/${k.name}`))
      .map((k) => ({
        name: `/${k.name}`,
        desc: `مهارة${k.source === 'user' ? ' (مستخدم)' : ''}: ${k.description}`,
        args: true,
        run: async (arg: string) => {
          const body = await window.api.skillBody(k.name);
          if (!body) return addNotice(`تعذّر قراءة المهارة ${k.name}.`, 'err');
          const text = arg.trim() ? `${body.text}\n\nوسائط/تفاصيل من المستخدم: ${arg.trim()}` : body.text;
          await hooks.sendMessage(text);
        },
      }));
  } catch {
    skillCmds = [];
  }
}

/** أوامر المشروع المخصصة: ملفات .freecode/commands/*.md ويُستبدل $ARGUMENTS بنص المستخدم */
export async function loadCustomCommands(): Promise<void> {
  const list = await window.api.listCommands();
  const taken = new Set(BUILTIN.map((b) => b.name));
  custom = list
    .filter((c) => !taken.has(`/${c.name}`))
    .map((c) => ({
      name: `/${c.name}`,
      desc: c.desc || 'أمر مخصص',
      args: true,
      run: (arg: string) => {
        const text = c.prompt.includes('$ARGUMENTS') ? c.prompt.replace(/\$ARGUMENTS/g, arg) : arg ? `${c.prompt}\n\n${arg}` : c.prompt;
        return hooks.sendMessage(text.trim());
      },
    }));
}

// ---------- النافذة المنبثقة ----------

function hidePopup(): void {
  popup.hidden = true;
  opts = [];
}

function renderPopup(): void {
  clear(popup);
  if (!opts.length) {
    popup.hidden = true;
    return;
  }
  opts.forEach((o, i) => {
    const row = h('div', { class: `opt ${i === sel ? 'sel' : ''}` }, icon(o.icon, 15), h('span', { class: 'k', text: o.key }), o.desc ? h('span', { class: 'd', text: o.desc, dir: 'auto' }) : null);
    row.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      o.apply();
    });
    popup.append(row);
  });
  popup.hidden = false;
  (popup.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
}

function showSlash(q: string): void {
  opts = allSlash()
    .filter((s) => s.name.startsWith(q.toLowerCase()))
    .map((s) => ({
      key: s.name,
      desc: s.desc,
      icon: 'chevron',
      apply: () => {
        hidePopup();
        if (s.args) {
          // الأمر يقبل تفاصيل: نكمل الاسم وننتظر المستخدم
          input.value = `${s.name} `;
          autosize();
          input.focus();
          return;
        }
        input.value = '';
        autosize();
        void s.run('');
      },
    }));
  sel = 0;
  renderPopup();
}

async function showMentions(query: string, start: number, end: number): Promise<void> {
  const token = ++mentionToken;
  const files = await window.api.searchFiles(query);
  if (token !== mentionToken) return; // وصل رد أحدث
  opts = files.map((f) => ({
    key: f,
    icon: 'file',
    apply: () => {
      const v = input.value;
      const ins = `@${f} `;
      input.value = v.slice(0, start) + ins + v.slice(end);
      const pos = start + ins.length;
      input.setSelectionRange(pos, pos);
      hidePopup();
      autosize();
      input.focus();
    },
  }));
  sel = 0;
  if (!opts.length) {
    clear(popup);
    popup.append(h('div', { class: 'empty', text: 'لا ملفات مطابقة' }));
    popup.hidden = false;
  } else renderPopup();
}

let mentionTimer = 0;

function updatePopup(): void {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  if (/^\/\w*$/.test(before) && input.value === before) {
    showSlash(before);
    return;
  }
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (m) {
    const start = pos - m[1].length - 1;
    window.clearTimeout(mentionTimer);
    mentionTimer = window.setTimeout(() => void showMentions(m[1], start, pos), 70);
    return;
  }
  hidePopup();
}

// ---------- الإدخال ----------

function autosize(): void {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

async function submit(): Promise<void> {
  const text = input.value.trim();
  if (!text || S.busy) return;
  // ‎#ملاحظة‎ تُحفظ في ذاكرة المشروع مباشرة (بلا استهلاك نموذج)، وتُقرأ تلقائياً لاحقاً
  if (text.startsWith('#') && text.length > 1) {
    const note = text.replace(/^#+\s*/, '');
    input.value = '';
    autosize();
    hidePopup();
    const r = await window.api.addMemory(note);
    addNotice(r.ok ? `حُفظت في ذاكرة المشروع: ${note}` : `تعذّر الحفظ: ${r.error ?? ''}`, r.ok ? '' : 'err');
    return;
  }
  const m = /^(\/[\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const slash = m ? allSlash().find((s) => s.name === m[1]) : undefined;
  input.value = '';
  autosize();
  hidePopup();
  if (slash) {
    // الأوامر النصية لا ترسل صوراً: نُبقيها معلّقة ونوضّح ذلك
    if (pendingImages().length) addNotice('الصور المرفقة لم تُرسل مع الأمر. أرسلها مع رسالة عادية.');
    await slash.run((m?.[2] ?? '').trim());
    return;
  }
  await hooks.sendMessage(text);
}

export function fillInput(text: string): void {
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

export function focusInput(): void {
  input.focus();
}

export function setBusy(b: boolean): void {
  S.busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  if (!b) input.focus();
}

export function setUsage(tokens: number, budget: number): void {
  const m = $('meter');
  const pct = Math.min(100, Math.round((tokens / Math.max(1, budget)) * 100));
  (m.querySelector('i') as HTMLElement).style.width = `${pct}%`;
  m.querySelector('.num')!.textContent = `${fmtTokens(tokens)}/${fmtTokens(budget)}`;
  m.classList.toggle('warn', pct >= 70 && pct < 92);
  m.classList.toggle('hot', pct >= 92);
  m.title = `السياق المستخدم تقريباً: ${tokens.toLocaleString('en')} من ${budget.toLocaleString('en')} توكن`;
}

/** يحدّث عناصر المحرر من الإعدادات */
export function syncComposer(s: Settings): void {
  document.body.dataset.mode = s.mode;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) b.classList.toggle('on', b.dataset.mode === s.mode);
  $('tgl-edits').classList.toggle('on', s.autoApproveEdits);
  $('tgl-cmds').classList.toggle('on', s.autoApproveCommands);
  $('model-chip').textContent = s.model;
  input.placeholder = s.mode === 'plan' ? 'وضع الخطة: اسأل أو اطلب تحليلاً، ولن يُعدَّل شيء…' : 'اكتب مهمتك…   @ لإرفاق ملف   / للأوامر   # لحفظ ملاحظة في ذاكرة المشروع';
}

export function initComposer(): void {
  input.addEventListener('input', () => {
    autosize();
    updatePopup();
  });
  input.addEventListener('click', updatePopup);
  input.addEventListener('blur', () => setTimeout(hidePopup, 120));

  input.addEventListener('keydown', (ev) => {
    if (!popup.hidden && opts.length) {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        sel = (sel + (ev.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
        renderPopup();
        return;
      }
      if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab') {
        ev.preventDefault();
        opts[sel].apply();
        return;
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        hidePopup();
        return;
      }
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      void submit();
    }
  });

  sendBtn.addEventListener('click', () => void submit());
  stopBtn.addEventListener('click', () => void window.api.abort());

  for (const b of document.querySelectorAll<HTMLButtonElement>('#mode-seg button')) {
    b.addEventListener('click', () => void setMode(b.dataset.mode as 'plan' | 'act'));
  }
  $('tgl-edits').addEventListener('click', async () => {
    hooks.applySettings(await window.api.setSettings({ autoApproveEdits: !S.settings?.autoApproveEdits }));
  });
  $('tgl-cmds').addEventListener('click', async () => {
    hooks.applySettings(await window.api.setSettings({ autoApproveCommands: !S.settings?.autoApproveCommands }));
  });
  $('model-chip').addEventListener('click', () => hooks.openSettings('model'));

  initAttach();

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && S.busy && popup.hidden) {
      void window.api.abort();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'n') {
      ev.preventDefault();
      void hooks.newChat();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key === ',') {
      ev.preventDefault();
      hooks.openSettings();
    }
  });
}

export { baseName };
