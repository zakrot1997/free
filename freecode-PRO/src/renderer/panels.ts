import { $, baseName, clear, h, langFromPath, timeAgo } from './util';
import { icon } from './icons';
import { highlight } from './highlight';
import { S, hooks } from './state';

// ---------- تبويبات ----------

function wireTabs(selector: string, attr: string, paneFor: (key: string) => HTMLElement): void {
  const btns = [...document.querySelectorAll<HTMLButtonElement>(selector)];
  const show = (key: string) => {
    for (const b of btns) b.classList.toggle('on', b.getAttribute(attr) === key);
    for (const b of btns) paneFor(b.getAttribute(attr)!).hidden = b.getAttribute(attr) !== key;
  };
  for (const b of btns) b.addEventListener('click', () => show(b.getAttribute(attr)!));
}

export function showRightTab(key: 'task' | 'file'): void {
  document.querySelector<HTMLButtonElement>(`[data-rtab="${key}"]`)?.click();
  $('app').classList.remove('no-right');
  $('app').classList.add('force-right');
}

export function initPanels(): void {
  wireTabs('[data-tab]', 'data-tab', (k) => $(`tab-${k}`));
  $('agents-clear').addEventListener('click', async () => {
    const r = await window.api.clearAgents();
    hooks.notice(r.message);
    await refreshAgents();
  });
  wireTabs('[data-rtab]', 'data-rtab', (k) => $(`rt-${k}`));

  $('toggle-right').addEventListener('click', () => {
    const app = $('app');
    const narrow = window.matchMedia('(max-width: 1180px)').matches;
    if (narrow) app.classList.toggle('force-right');
    else app.classList.toggle('no-right');
  });

  $('ws-btn').addEventListener('click', (ev) => {
    ev.stopPropagation();
    const menu = $('ws-menu');
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    clear(menu);
    for (const dir of S.settings?.recent ?? []) {
      menu.append(
        h(
          'button',
          {
            attrs: { type: 'button' },
            on: {
              click: async () => {
                menu.hidden = true;
                const s = await window.api.setWorkspace(dir);
                if (s) {
                  hooks.applySettings(s);
                  await hooks.newChat();
                  await refreshTree();
                }
              },
            },
          },
          h('span', { text: baseName(dir) }),
          h('span', { class: 'sub', text: dir }),
        ),
      );
    }
    if (S.settings?.recent.length) menu.append(h('div', { class: 'sep' }));
    menu.append(h('button', { attrs: { type: 'button' }, text: 'فتح مجلد آخر…', on: { click: () => { menu.hidden = true; void hooks.pickWorkspace(); } } }));
    menu.hidden = false;
  });
  document.addEventListener('click', () => ($('ws-menu').hidden = true));

  $('undo').addEventListener('click', async () => {
    const r = await window.api.undo();
    if (!r.restored.length) return;
    await refreshTree();
  });
}

// ---------- شجرة الملفات ----------

let selectedNode: HTMLElement | null = null;
/** المجلدات المفتوحة تبقى مفتوحة بعد تحديث الشجرة (مثلاً بعد أن ينشئ الوكيل ملفات) */
const openDirs = new Set<string>();

async function renderDir(container: HTMLElement, rel: string, depth: number): Promise<void> {
  const entries = await window.api.listTree(rel);
  if (!entries.length && depth === 0) {
    container.append(h('div', { class: 'empty-note', text: S.settings?.workspace ? 'المجلد فارغ.' : 'اختر مشروعاً لعرض ملفاته.' }));
    return;
  }
  for (const e of entries) {
    const row = h('div', { class: `node ${e.isDir ? 'dir' : ''}`, title: e.path });
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.append(e.isDir ? h('span', { class: 'chev' }, icon('chevron', 12)) : h('span', { class: 'sp' }), icon(e.isDir ? 'folder' : 'file', 15), h('span', { class: 'nm', text: e.name }));
    container.append(row);
    if (e.isDir) {
      const kids = h('div');
      kids.hidden = true;
      container.append(kids);
      let loaded = false;
      row.addEventListener('click', async () => {
        if (!loaded) {
          loaded = true;
          await renderDir(kids, e.path, depth + 1);
        }
        kids.hidden = !kids.hidden;
        row.classList.toggle('open', !kids.hidden);
        if (kids.hidden) openDirs.delete(e.path);
        else openDirs.add(e.path);
      });
      if (openDirs.has(e.path)) {
        loaded = true;
        await renderDir(kids, e.path, depth + 1);
        kids.hidden = false;
        row.classList.add('open');
      }
    } else {
      row.addEventListener('click', () => {
        selectedNode?.classList.remove('sel');
        row.classList.add('sel');
        selectedNode = row;
        void hooks.openFile(e.path);
      });
    }
  }
}

export async function refreshTree(): Promise<void> {
  const tree = $('tree');
  clear(tree);
  selectedNode = null;
  await renderDir(tree, '', 0);
}

let lastWorkspace: string | null = null;

export function setWorkspaceName(path: string | null): void {
  // عند تغيير المشروع ننسى المجلدات المفتوحة، وإلا فُتحت مسارات متشابهة في الشجرة الجديدة
  if (path !== lastWorkspace) {
    openDirs.clear();
    lastWorkspace = path;
  }
  $('ws-name').textContent = path ? baseName(path.replace(/[\\/]+$/, '')) : 'اختر مشروعاً';
  $('ws-btn').title = path ?? 'اختيار مشروع';
}

// ---------- المحادثات ----------

export async function refreshSessions(onOpen: (id: string) => void): Promise<void> {
  const { sessions, currentId } = await window.api.listSessions();
  const box = $('sessions');
  clear(box);
  if (!sessions.length) {
    box.append(h('div', { class: 'empty-note', text: 'لا توجد محادثات محفوظة لهذا المشروع بعد.' }));
    return;
  }
  for (const s of sessions) {
    const del = h('button', { class: 'icon-btn del', title: 'حذف', attrs: { type: 'button' } }, icon('trash', 14));
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm('حذف هذه المحادثة نهائياً؟')) return;
      await window.api.deleteSession(s.id);
      if (s.id === currentId) await hooks.newChat();
      else await refreshSessions(onOpen);
    });
    const row = h(
      'div',
      { class: `sess ${s.id === currentId ? 'cur' : ''}` },
      h('div', { class: 't', text: s.title, dir: 'auto' }),
      h('div', { class: 'm' }, h('span', { text: timeAgo(s.updatedAt), dir: 'auto' }), h('span', { text: `${s.turns} رسائل`, dir: 'auto' })),
      del,
    );
    row.addEventListener('click', () => onOpen(s.id));
    box.append(row);
  }
}

// ---------- الخطة والتعديلات ----------

export function setTodos(todos: TodoItem[]): void {
  const box = $('todos');
  clear(box);
  if (!todos.length) {
    box.className = 'empty-note';
    box.textContent = 'تظهر هنا خطوات المهام الطويلة أثناء التنفيذ.';
    return;
  }
  box.className = '';
  const done = todos.filter((t) => t.status === 'done').length;
  box.append(h('div', { class: 'todo-count', text: `${done} من ${todos.length} مكتملة`, dir: 'auto' }));
  for (const t of todos) box.append(h('div', { class: `todo ${t.status}` }, h('span', { class: 'g' }), h('span', { class: 't', text: t.content, dir: 'auto' })));
}

export function setChanges(changes: ChangedFile[], undoDepth: number): void {
  const box = $('changes');
  clear(box);
  const undo = $('undo');
  undo.hidden = undoDepth === 0;
  if (!changes.length) {
    box.className = 'empty-note';
    box.textContent = 'لم يعدّل الوكيل أي ملف بعد.';
    return;
  }
  box.className = '';
  for (const c of changes) {
    const row = h('div', { class: 'chg', title: c.path }, icon('file', 14), h('span', { class: 'p', text: c.path }), h('span', { class: `tag ${c.created ? '' : 'mod'}`, text: c.created ? 'جديد' : 'معدّل' }));
    row.addEventListener('click', () => void hooks.openFile(c.path));
    box.append(row);
  }
}

// ---------- الوكلاء المتوازيون ----------

/** سجلات الوكلاء الحيّة (id ← نص) تُغذّى من أحداث agent_log */
const agentLogs = new Map<string, string>();
let agentsOpen = new Set<string>();
let lastAgents: ParallelAgentView[] = [];

export function appendAgentLog(id: string, chunk: string): void {
  const prev = agentLogs.get(id) ?? '';
  agentLogs.set(id, (prev + chunk).slice(-20_000));
  const a = lastAgents.find((x) => x.id === id);
  if (a) renderAgentLog(a);
}

function renderAgentLog(a: ParallelAgentView): void {
  const box = document.getElementById(`alog-${a.id}`);
  if (!box) return;
  const text = agentLogs.get(a.id) ?? '';
  box.textContent = text.slice(-6000);
  box.scrollTop = box.scrollHeight;
}

export async function refreshAgents(): Promise<void> {
  const r = await window.api.listAgents();
  renderAgents(r.agents ?? [], { git: r.git, error: r.error });
}

function fmtStat(a: ParallelAgentView): string {
  const add = a.files.reduce((s, f) => s + f.add, 0);
  const del = a.files.reduce((s, f) => s + f.del, 0);
  const parts = [`${a.files.length} ملف`];
  if (add || del) parts.push(`+${add} −${del}`);
  if (a.toolCalls) parts.push(`${a.toolCalls} أداة`);
  return parts.join(' · ');
}

export function renderAgents(list: ParallelAgentView[], info: { git?: boolean; error?: string } = {}): void {
  const box = $('agents-list');
  lastAgents = list;
  const count = $('agents-count');
  const actions = $('agents-actions');
  if (!box) return;
  clear(box);
  count.hidden = !list.length;
  count.textContent = String(list.length);
  actions.hidden = !list.some((a) => a.status === 'merged' || a.status === 'discarded');
  if (!list.length) {
    box.className = 'empty-note';
    box.dir = 'auto';
    box.textContent = info.git === false && info.error ? info.error : 'لا وكلاء بعد. اطلب من الوكيل تفويض مهام مستقلة، أو اكتب /agents مهمة لتشغيل وكيل في نسخة معزولة.';
    return;
  }
  box.className = '';
  box.removeAttribute('dir');
  for (const a of list) {
    const card = h('div', { class: `agent agent-${a.status}` });
    const head = h('div', { class: 'agent-head' });
    head.append(
      h('span', { class: 'agent-dot' }),
      h('span', { class: 'agent-label', text: a.label, dir: 'auto' }),
      h('span', { class: `agent-status s-${a.status}`, text: a.statusText }),
    );
    card.append(head);
    if (a.branch) card.append(h('div', { class: 'agent-meta', text: `${fmtStat(a)} · ${a.branch}`, dir: 'ltr' }));
    if (a.summary) card.append(h('div', { class: 'agent-sum', text: a.summary.replace(/\s+/g, ' ').slice(0, 240), dir: 'auto' }));
    if (a.error) card.append(h('div', { class: 'agent-err', text: a.error, dir: 'auto' }));
    if (a.denied.length) card.append(h('div', { class: 'agent-err', text: `رُفضت أوامر خطرة: ${a.denied.slice(0, 2).join(' | ')}`, dir: 'auto' }));
    if (a.files.length) {
      const fl = h('div', { class: 'agent-files' });
      for (const f of a.files.slice(0, 8)) fl.append(h('div', { class: 'agent-file', title: f.path }, h('span', { class: 'p', text: f.path }), h('span', { class: 'n', text: f.add || f.del ? `+${f.add} −${f.del}` : '' })));
      if (a.files.length > 8) fl.append(h('div', { class: 'agent-file more', text: `و${a.files.length - 8} ملفاً آخر…` }));
      card.append(fl);
    }

    const log = h('pre', { class: 'agent-log', dir: 'auto' });
    log.id = `alog-${a.id}`;
    log.hidden = !agentsOpen.has(a.id);
    log.textContent = (agentLogs.get(a.id) ?? '').slice(-6000);
    card.append(log);

    const bar = h('div', { class: 'agent-actions' });
    const btn = (label: string, fn: () => void, cls = '') =>
      h('button', { class: `btn mini ${cls}`, text: label, attrs: { type: 'button' }, on: { click: fn } });

    btn(agentsOpen.has(a.id) ? 'إخفاء السجل' : 'السجل', () => {
      if (agentsOpen.has(a.id)) agentsOpen.delete(a.id);
      else agentsOpen.add(a.id);
      renderAgents(lastAgents, info);
    });
    if (a.status === 'running') bar.append(btn('إيقاف', async () => { const r = await window.api.stopAgent(a.id); hooks.notice(r.message); void refreshAgents(); }));
    if (a.status === 'done' || a.status === 'stopped' || a.status === 'failed') {
      bar.append(btn('الفرق', async () => {
        const r = await window.api.agentDiff(a.id);
        hooks.showAgentDiff(a.label, r.text);
      }));
      bar.append(
        btn('دمج', async () => {
          const r = await window.api.mergeAgent(a.id, false);
          hooks.notice(r.ok ? `${r.message} — راجع التعديلات.` : `تعذّر الدمج: ${r.message}`);
          await refreshAgents();
        }, 'primary'),
      );
    }
    if (a.status !== 'merged' && a.status !== 'discarded') {
      bar.append(
        btn('تجاهل', async () => {
          const r = await window.api.discardAgent(a.id);
          hooks.notice(r.message);
          await refreshAgents();
        }),
      );
    }
    card.append(bar);
    box.append(card);
  }
}

// ---------- معاينة الملف ----------

export async function openFile(rel: string): Promise<void> {
  showRightTab('file');
  const head = $('file-head');
  const body = $('file-body');
  clear(head);
  clear(body);
  head.append(
    icon('file', 15),
    h('span', { class: 'p', text: rel }),
    h('button', { class: 'btn', text: 'أرفق للمحادثة', attrs: { type: 'button' }, on: { click: () => hooks.fillInput(`@${rel} `) } }),
  );
  const r = await window.api.readFile(rel);
  if (!r.ok) {
    body.append(h('div', { class: 'empty-note', text: `تعذّر فتح الملف: ${r.error ?? ''}` }));
    return;
  }
  if (r.binary) {
    body.append(h('div', { class: 'empty-note', text: 'ملف ثنائي، لا يمكن عرضه كنص.' }));
    return;
  }
  const text = r.text ?? '';
  const lines = text.split('\n').length;
  const gutter = h('div', { class: 'gutter', text: Array.from({ length: lines }, (_, i) => i + 1).join('\n') });
  const code = h('code');
  code.append(highlight(text, langFromPath(rel)));
  body.append(h('div', { class: 'viewer' }, gutter, h('pre', {}, code)));
  if (r.truncated) body.append(h('div', { class: 'empty-note', text: 'عُرض أول 300 كيلوبايت فقط.' }));
}
