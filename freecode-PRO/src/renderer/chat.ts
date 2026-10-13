import { $, clear, h } from './util';
import { icon, toolMeta, toolSummary } from './icons';
import { renderMarkdown } from './markdown';
import { renderDiff } from './diffview';
import { S, hooks } from './state';
import { appendAgentLog, renderAgents } from './panels';

const chat = $<HTMLDivElement>('chat');
const scroller = $<HTMLDivElement>('chat-scroll');

interface ToolView {
  box: HTMLElement;
  st: HTMLElement;
  out: HTMLPreElement | null;
  /** جسم الصف: تُضاف إليه نتيجة الأدوات غير المباشرة عند توسيع الصف فقط */
  body?: HTMLElement;
  /** نتيجة وصلت ولم تُعرض بعد (نعرضها عند التوسيع فلا نُثقل DOM بكل المخرجات) */
  late?: string;
  approval?: { card: HTMLElement; out?: HTMLPreElement; rejected: boolean };
}

let cur: { el: HTMLElement; buf: string; raf: number } | null = null;
const tools = new Map<string, ToolView>();
/** بطاقات موافقة تنتظر قرار المستخدم: نُغلقها إن انتهت الدورة قبل الرد */
const openApprovals = new Map<string, { card: HTMLElement; ttl: HTMLElement; actions: HTMLElement }>();

export function initChat(): void {
  scroller.addEventListener('scroll', () => {
    S.stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  });
  chat.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest('a[data-ext]') as HTMLAnchorElement | null;
    if (a) {
      ev.preventDefault();
      void window.api.openExternal(a.getAttribute('href') ?? '');
    }
  });
}

function scrollDown(force = false): void {
  if (force || S.stick) scroller.scrollTop = scroller.scrollHeight;
}

export function clearChat(): void {
  clear(chat);
  tools.clear();
  openApprovals.clear();
  cur = null;
  S.hasMessages = false;
  S.stick = true;
}

/**
 * عند انتهاء الدورة (إيقاف أو خطأ) لا تعود هناك موافقات متوقعة، فبطاقاتها المعلّقة
 * تصبح أزراراً بلا أثر. نُغلقها ونوضّح السبب بدل تركها تبدو قابلة للنقر.
 */
function closeStaleApprovals(): void {
  for (const a of openApprovals.values()) {
    a.actions.remove();
    a.card.classList.add('rejected');
    a.ttl.textContent = 'لم يُتخذ قرار (انتهت الدورة)';
  }
  openApprovals.clear();
}

function ensureStarted(): void {
  if (!S.hasMessages) {
    clear(chat);
    S.hasMessages = true;
  }
}

// ---------- الشاشة الافتتاحية ----------

const SUGGESTIONS: { h: string; d: string; text: string }[] = [
  { h: 'اشرح لي المشروع', d: 'بنية المجلدات والملفات المهمة وكيف يعمل', text: 'اشرح لي بنية هذا المشروع وكيف يعمل، وما أهم الملفات فيه؟' },
  { h: 'ابحث عن الأخطاء', d: 'مراجعة الكود بحثاً عن أخطاء محتملة', text: 'راجع الكود في هذا المشروع وابحث عن أخطاء أو مشاكل محتملة، ورتّبها حسب الأهمية.' },
  { h: 'أضف اختبارات', d: 'اقتراح خطة ثم كتابة الاختبارات', text: 'اقترح خطة لإضافة اختبارات لهذا المشروع، ثم نفّذ أول خطوة منها.' },
  { h: 'أنشئ FREECODE.md', d: 'تعليمات تُقرأ تلقائياً في كل محادثة', text: INIT_PROMPT(),},
];

export function INIT_PROMPT(): string {
  return 'حلّل هذا المشروع وأنشئ ملف FREECODE.md في الجذر يحتوي باختصار: وصف المشروع، أوامر البناء والاختبار والتشغيل، بنية المجلدات، وقواعد الكتابة المتبعة في الكود. سيُقرأ هذا الملف تلقائياً في كل محادثة.';
}

export function renderWelcome(): void {
  clear(chat);
  S.hasMessages = false;
  const s = S.settings;
  const root = h('div', { class: 'welcome' });
  root.append(h('h1', { text: 'ماذا نبني اليوم؟' }));

  const needWs = !s?.workspace;
  const needKey = !s?.hasKey;
  if (needWs || needKey) {
    root.append(h('div', { class: 'sub', text: 'خطوتان سريعتان قبل أن نبدأ' }));
    const setup = h('div', { class: 'setup' });
    setup.append(
      h(
        'div',
        { class: `step ${needWs ? '' : 'done'}` },
        h('span', { class: 'dot' }, needWs ? null : icon('check', 11)),
        h('span', { class: 'tx', text: 'اختر مجلد المشروع الذي سيعمل عليه الوكيل' }),
        needWs ? h('button', { class: 'btn', text: 'اختيار مجلد', on: { click: () => void hooks.pickWorkspace() } }) : null,
      ),
      h(
        'div',
        { class: `step ${needKey ? '' : 'done'}` },
        h('span', { class: 'dot' }, needKey ? null : icon('check', 11)),
        h('span', { class: 'tx', text: 'أدخل عنوان FreeLLMAPI والمفتاح الموحد' }),
        needKey ? h('button', { class: 'btn', text: 'الإعدادات', on: { click: () => hooks.openSettings('key') } }) : null,
      ),
    );
    root.append(setup);
  } else {
    const name = s!.workspace!.split(/[\\/]/).filter(Boolean).pop() ?? s!.workspace!;
    root.append(h('div', { class: 'sub' }, 'الوكيل يعمل داخل ', h('b', { text: name }), ' ويطلب موافقتك قبل أي تعديل.'));
  }

  const grid = h('div', { class: 'suggest' });
  for (const sg of SUGGESTIONS) {
    grid.append(
      h(
        'button',
        { attrs: { type: 'button' }, on: { click: () => hooks.fillInput(sg.text) } },
        h('span', { class: 'h', text: sg.h }),
        h('span', { class: 'd', text: sg.d }),
      ),
    );
  }
  root.append(grid);
  root.append(
    h(
      'div',
      { class: 'tips' },
      h('span', {}, h('kbd', { text: '@' }), ' أرفق ملفاً'),
      h('span', {}, h('kbd', { text: '/' }), ' الأوامر'),
      h('span', {}, h('kbd', { text: 'Esc' }), ' إيقاف الوكيل'),
    ),
  );
  chat.append(root);
}

// ---------- الرسائل ----------

export function addUser(text: string, attachments: string[] = [], images: string[] = []): void {
  ensureStarted();
  cur = null;
  const el = h('div', { class: 'msg user', dir: 'auto' });
  // إشارات @ملف تُعزل اتجاهياً حتى لا يختل ترتيبها داخل النص العربي
  for (const part of text.split(/(@[^\s@]+)/g)) {
    if (!part) continue;
    el.append(part.length > 1 && part.startsWith('@') ? h('span', { class: 'mention', text: part }) : document.createTextNode(part));
  }
  if (attachments.length) {
    el.append(h('div', { class: 'chips' }, ...attachments.map((a) => h('span', { class: 'fchip' }, icon('paperclip', 11), a))));
  }
  if (images.length) {
    const shots = h('div', { class: 'shots' });
    for (const src of images) {
      const img = h('img', { attrs: { src, alt: 'صورة مرفقة', title: 'انقر للتكبير/التصغير' } });
      img.addEventListener('click', () => img.classList.toggle('zoom'));
      shots.append(img);
    }
    el.append(shots);
  }
  chat.append(el);
  S.stick = true;
  scrollDown(true);
}

function renderAssistant(): void {
  if (!cur) return;
  cur.raf = 0;
  clear(cur.el);
  cur.el.append(renderMarkdown(cur.buf));
  scrollDown();
}

function onText(delta: string): void {
  ensureStarted();
  if (!cur) {
    const el = h('div', { class: 'msg assistant' });
    chat.append(el);
    cur = { el, buf: '', raf: 0 };
  }
  cur.buf += delta;
  if (!cur.raf) cur.raf = requestAnimationFrame(renderAssistant);
}

/** يعرض فرق فرع وكيل متوازٍ داخل المحادثة (يُستدعى من لوحة الوكلاء) */
export function showAgentDiff(label: string, text: string): void {
  ensureStarted();
  finishAssistant();
  const pre = document.createElement('pre');
  pre.className = 'diff-text';
  pre.dir = 'auto';
  pre.textContent = text || '(لا فروق)';
  chat.append(h('div', { class: 'msg diff-full' }, h('div', { class: 'who', text: `فرق الوكيل: ${label}` }), pre));
  scrollDown(true);
}

/** تقرير (فحص أمني أو إحصاءات) يُعرض كرسالة كاملة بتنسيق Markdown */
export function addReport(title: string, markdown: string, actions: { label: string; run: () => void | Promise<void> }[] = []): void {
  ensureStarted();
  finishAssistant();
  const box = h('div', { class: 'msg report' });
  box.append(h('div', { class: 'who', text: title }));
  const body = h('div', { class: 'report-body' });
  body.append(renderMarkdown(markdown));
  box.append(body);
  if (actions.length) {
    const bar = h('div', { class: 'report-actions' });
    for (const a of actions) {
      bar.append(h('button', {
        class: 'btn',
        text: a.label,
        attrs: { type: 'button' },
        on: { click: (ev: Event) => { (ev.currentTarget as HTMLButtonElement).disabled = true; void a.run(); } },
      }));
    }
    box.append(bar);
  }
  chat.append(box);
  scrollDown(true);
}

export function addNotice(text: string, kind: '' | 'err' = ''): void {
  ensureStarted();
  chat.append(h('div', { class: `notice ${kind}` }, kind === 'err' ? icon('alert', 15) : null, h('span', { text, dir: 'auto' })));
  scrollDown();
}

function finishAssistant(): void {
  if (cur) {
    if (cur.raf) cancelAnimationFrame(cur.raf);
    renderAssistant();
  }
  cur = null;
}

// ---------- الأدوات ----------

function stateIcon(kind: 'run' | 'ok' | 'err'): Node {
  if (kind === 'run') return h('span', { class: 'spin' });
  return icon(kind === 'ok' ? 'check' : 'x', 14);
}

function setToolState(tv: ToolView, kind: 'run' | 'ok' | 'err'): void {
  tv.box.classList.remove('ok', 'err');
  if (kind !== 'run') tv.box.classList.add(kind);
  clear(tv.st);
  tv.st.append(stateIcon(kind));
}

function addTool(id: string, name: string, args: unknown, result?: string, isError?: boolean): void {
  ensureStarted();
  finishAssistant();
  const meta = toolMeta(name);
  const st = h('span', { class: 'st' });
  const head = h(
    'div',
    { class: 'head' },
    icon(meta.icon, 14),
    h('span', { class: 'lab', text: meta.label }),
    h('span', { class: 'sum', text: toolSummary(name, args) }),
    st,
    h('span', { class: 'chev' }, icon('chevron', 12)),
  );
  const body = h('div', { class: 'body' });
  const isCmd = name === 'run_command';
  const isTask = name === 'task';
  if (!isCmd && args && typeof args === 'object' && name !== 'write_file' && !isTask) {
    body.append(h('pre', { class: 'args', text: JSON.stringify(args, null, 2).slice(0, 4000) }));
  }
  if (isTask && args && typeof args === 'object') body.append(h('pre', { class: 'args', text: String((args as any).prompt ?? '').slice(0, 1500), attrs: { dir: 'auto' } }));
  const out = isCmd || isTask || result !== undefined ? h('pre', { text: result ?? '' }) : null;
  if (out) body.append(out);
  const box = h('div', { class: 'tool' }, head, body);
  const tv: ToolView = { box, st, out, body };
  // نتائج القراءة/البحث تُعرض عند توسيع الصف فقط (قد تكون عشرات الكيلوبايتات لكل استدعاء)
  if (!isCmd && !isTask && result !== undefined) tv.late = result;
  head.addEventListener('click', () => {
    box.classList.toggle('open');
    if (box.classList.contains('open') && tv.late !== undefined) {
      body.append(h('pre', { text: tv.late, dir: 'auto' }));
      tv.late = undefined;
    }
  });
  setToolState(tv, result === undefined ? 'run' : isError ? 'err' : 'ok');
  if ((isCmd || isTask) && result === undefined) box.classList.add('open');
  chat.append(box);
  tools.set(id, tv);
  scrollDown();
}

function addApproval(id: string, name: string, args: any, preview: Preview | null, rule?: string | null): void {
  const tv = tools.get(id);
  if (tv) tv.box.style.display = 'none'; // البطاقة تحل محل صف الأداة

  const isCmd = preview?.kind === 'command';
  const isGeneric = preview?.kind === 'generic';
  const dangerous = preview?.kind === 'command' && preview.dangerous;
  const isNew = preview?.kind === 'diff' && preview.isNew;

  const card = h('div', { class: 'approval' });
  const ttl = h('span', { class: 'ttl', text: dangerous ? 'أمر خطر يحتاج موافقتك' : isCmd ? 'تشغيل أمر' : isGeneric ? 'استخدام أداة' : isNew ? 'إنشاء ملف جديد' : 'تعديل ملف' });
  const head = h('div', { class: 'ap-head' }, h('span', { class: 'ic' }, icon(isCmd ? (dangerous ? 'alert' : 'terminal') : isGeneric ? 'terminal' : 'edit', 17)), ttl);
  if (preview?.kind === 'diff') {
    head.append(h('span', { class: 'path', text: preview.path }));
    head.append(h('span', { class: 'stat' }, h('span', { class: 'a', text: `+${preview.diff.added}` }), h('span', { class: 'd', text: `−${preview.diff.removed}` })));
  } else if (dangerous) head.append(h('span', { class: 'badge bad', text: 'قد يكون مدمّراً' }));
  card.append(head);

  if (preview?.kind === 'diff') card.append(renderDiff(preview.diff));
  else if (preview?.kind === 'command') card.append(h('pre', { class: 'cmd', text: preview.command }));
  else if (preview?.kind === 'generic') card.append(h('pre', { class: 'cmd', text: preview.text }));
  else card.append(h('pre', { class: 'cmd', text: JSON.stringify(args, null, 2) }));

  const actions = h('div', { class: 'ap-actions' });
  const finish = (ok: boolean, scope: 'once' | 'turn' | 'file' = 'once') => {
    openApprovals.delete(id);
    card.classList.add(ok ? 'approved' : 'rejected');
    ttl.textContent = ok
      ? scope === 'turn'
        ? 'تمت الموافقة (وعلى باقي الدورة)'
        : scope === 'file'
          ? 'تمت الموافقة (وعلى باقي تعديلات هذا الملف)'
          : 'تمت الموافقة'
      : 'تم الرفض';
    actions.remove();
    if (tv?.approval) tv.approval.rejected = !ok;
    void window.api.respondApproval(id, ok, scope);
  };
  actions.append(
    h('button', { class: 'btn approve', text: 'موافقة', attrs: { type: 'button' }, on: { click: () => finish(true) } }),
    h('button', { class: 'btn reject', text: 'رفض', attrs: { type: 'button' }, on: { click: () => finish(false) } }),
  );
  // موافقة على كل تعديلات هذا الملف في هذه الدورة (أقل نقرات في الملفات الطويلة)
  const filePath = preview?.kind === 'diff' && !preview.isNew ? preview.path : args && typeof args === 'object' && typeof args.path === 'string' && /^(edit_file|write_file)$/.test(name) ? args.path : null;
  if (filePath && !dangerous) {
    actions.append(
      h('button', {
        class: 'btn file',
        attrs: { type: 'button' },
        title: `يوافق على كل تعديلات «${filePath}» في هذه الدورة بلا سؤال متكرر`,
        text: 'كل تعديلات هذا الملف',
        on: { click: () => finish(true, 'file') },
      }),
    );
  }
  // الموافقة على باقي هذه الدورة: لا تشمل الأوامر الخطرة ولا أدوات MCP
  if (!dangerous && !name.startsWith('mcp__') && !isGeneric) {
    actions.append(
      h('button', {
        class: 'btn turn',
        attrs: { type: 'button' },
        title: 'يوافق تلقائياً على باقي التعديلات والأوامر في هذه الدورة فقط (عدا الأوامر الخطرة وأدوات MCP)',
        text: 'وافق على الباقي في هذه الدورة',
        on: { click: () => finish(true, 'turn') },
      }),
    );
  }
  const links = h('div', { class: 'ap-links' });
  if (rule && !dangerous) {
    links.append(
      h('button', {
        class: 'always',
        attrs: { type: 'button' },
        title: 'تُحفظ في ملف القواعد، ويمكنك تعديلها من الإعدادات',
        on: {
          click: async () => {
            const ok = await window.api.allowRule(rule);
            if (!ok) return addNotice('تعذّر حفظ القاعدة (تأكد أن ملف القواعد في الإعدادات صالح).', 'err');
            addNotice(`أُضيفت قاعدة سماح: ${rule}`);
            finish(true);
          },
        },
      }, 'اسمح دائماً: ', h('code', { text: rule, dir: 'ltr' })),
    );
  }
  if (!dangerous && !isCmd && !isGeneric && S.settings) {
    links.append(
      h('button', {
        class: 'always',
        attrs: { type: 'button' },
        text: 'وافق دائماً على كل التعديلات',
        on: {
          click: async () => {
            const s = await window.api.setSettings({ autoApproveEdits: true });
            hooks.applySettings(s);
            finish(true);
          },
        },
      }),
    );
  }
  if (links.childElementCount) actions.append(links);
  card.append(actions);
  chat.append(card);
  if (tv) tv.approval = { card, rejected: false };
  openApprovals.set(id, { card, ttl, actions });
  scrollDown(true);
}

function onToolOutput(id: string, chunk: string): void {
  const tv = tools.get(id);
  if (!tv) return;
  let pre: HTMLPreElement | null = tv.out;
  if (tv.approval) {
    if (!tv.approval.out) {
      const out = h('pre');
      tv.approval.card.append(h('div', { class: 'ap-out' }, out));
      tv.approval.out = out;
    }
    pre = tv.approval.out;
  }
  if (!pre) return;
  pre.textContent = ((pre.textContent ?? '') + chunk).slice(-30_000);
  pre.scrollTop = pre.scrollHeight;
  scrollDown();
}

function onToolResult(id: string, name: string, result: string, isError: boolean): void {
  const tv = tools.get(id);
  if (!tv) return;
  setToolState(tv, isError ? 'err' : 'ok');
  if (!tv.out) tv.late = result; // أداة قراءة: تُعرض عند التوسيع
  else if (!tv.out.textContent || name !== 'run_command') tv.out.textContent = result;
  if (tv.out && (name === 'run_command' || name === 'task')) tv.box.classList.remove('open');
  if (tv.approval && isError && !tv.approval.rejected && !tv.approval.out) {
    const out = h('pre', { text: result });
    tv.approval.card.append(h('div', { class: 'ap-out' }, out));
  }
  if (tv.approval && name === 'run_command' && !tv.approval.out && !isError) {
    tv.approval.card.append(h('div', { class: 'ap-out' }, h('pre', { text: result })));
  }
  scrollDown();
}

// ---------- أحداث الوكيل ----------

export function handleChatEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'text':
      onText(e.delta);
      break;
    case 'tool_call':
      addTool(e.id, e.name, e.args);
      break;
    case 'approval':
      addApproval(e.id, e.name, e.args, e.preview, e.rule);
      break;
    case 'tool_output':
      onToolOutput(e.id, e.chunk);
      break;
    case 'tool_result':
      onToolResult(e.id, e.name, e.result, e.isError);
      break;
    case 'notice':
      addNotice(e.message);
      break;
    case 'agents':
      renderAgents(e.list ?? [], {});
      break;
    case 'agent_log':
      appendAgentLog(e.id, e.chunk);
      break;
    case 'error':
      finishAssistant();
      closeStaleApprovals();
      addNotice(e.message, 'err');
      break;
    case 'done':
      finishAssistant();
      closeStaleApprovals();
      if (e.aborted) addNotice('تم إيقاف الوكيل.');
      break;
    default:
      break;
  }
}

/** استعادة محادثة محفوظة */
export function loadItems(items: RenderItem[]): void {
  clearChat();
  if (!items.length) {
    renderWelcome();
    return;
  }
  ensureStarted();
  for (const it of items) {
    if (it.type === 'user') addUser(it.text, it.attachments, it.images ?? []);
    else if (it.type === 'assistant') {
      onText(it.text);
      finishAssistant();
    } else addTool(it.id, it.name, it.args, it.result ?? '(لم تكتمل)', it.isError);
  }
  S.stick = true;
  scrollDown(true);
}
