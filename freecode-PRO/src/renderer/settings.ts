import { $, clear, h } from './util';
import { S, hooks, normalizeEndpoint } from './state';

const modal = $<HTMLDivElement>('modal');
const url = $<HTMLInputElement>('s-url');
const key = $<HTMLInputElement>('s-key');
const model = $<HTMLInputElement>('s-model');
const status = $<HTMLSpanElement>('s-status');
const rulesBox = $<HTMLTextAreaElement>('s-rules');
let rulesLoaded = '';

function updateEndpoint(): void {
  const ep = normalizeEndpoint(url.value);
  const box = $('s-endpoint');
  clear(box);
  if (ep) box.append('سيتم الاتصال بـ ', h('span', { class: 'mention', text: ep }));
}

function setStatus(text: string, kind: '' | 'ok' | 'bad' = ''): void {
  status.textContent = text;
  status.className = `note ${kind}`;
}

export function setConnection(kind: 'ok' | 'bad' | '', title = ''): void {
  const dot = $('conn');
  dot.className = `conn ${kind}`;
  dot.title = title || (kind === 'ok' ? 'متصل بـ FreeLLMAPI' : kind === 'bad' ? 'تعذّر الاتصال' : 'غير مفحوص');
}

function renderMcp(info: McpInfo): void {
  const box = $('mcp-list');
  clear(box);
  if (!info.servers.length) box.append(h('div', { class: 'note', text: 'لا توجد خوادم MCP مضبوطة بعد.' }));
  for (const sv of info.servers) {
    box.append(
      h(
        'div',
        { class: `mcp-row ${sv.ok ? '' : 'bad'}` },
        h('span', { class: 'dot' }),
        h('span', { class: 'nm', text: sv.name }),
        h('span', { class: 'meta', dir: 'auto', text: sv.ok ? `${sv.toolCount} أدوات · ${sv.source}` : sv.error ?? 'فشل' }),
      ),
    );
  }
  $('mcp-path').textContent = info.userConfigPath;
}

function setRulesStatus(text: string, kind: '' | 'ok' | 'bad' = ''): void {
  const el = $('rules-status');
  el.textContent = text;
  el.className = `note ${kind}`;
}

function renderRulesInfo(info: RulesInfo | null): void {
  const proj = $('rules-proj');
  const trust = $<HTMLButtonElement>('rules-trust');
  trust.hidden = true;
  if (!info) {
    proj.textContent = '';
    return;
  }
  const lines: string[] = [];
  if (info.errors.length) lines.push(...info.errors.map((e) => `⚠ ${e}`));
  if (info.projectPresent) {
    if (info.needsTrust) {
      lines.push('قواعد هذا المشروع (غير مفعّلة حتى تثق بها):', ...info.projectSummary.map((l) => `• ${l}`));
      trust.hidden = false;
    } else if (info.projectSensitive) lines.push('قواعد هذا المشروع موثوقة ومفعّلة:', ...info.projectSummary.map((l) => `• ${l}`));
    else lines.push('يوجد ملف قواعد للمشروع (منع/سؤال فقط) وهو مفعّل.');
  }
  proj.textContent = lines.join('\n');
}

async function loadRulesUi(): Promise<void> {
  const r = await window.api.getRules();
  rulesBox.value = r.userText;
  rulesLoaded = r.userExists ? r.userText : '';
  $('rules-path').textContent = r.userPath;
  setRulesStatus(r.userExists ? '' : 'هذا قالب مقترح؛ لم يُحفظ بعد.');
  renderRulesInfo(r.info);
}

/** يحفظ القواعد إن تغيّرت. يعيد false إذا كانت غير صالحة (فلا نغلق النافذة). */
async function saveRulesIfChanged(force = false): Promise<boolean> {
  if (!force && rulesBox.value === rulesLoaded) return true;
  const r = await window.api.saveRules(rulesBox.value);
  if (!r.ok) {
    setRulesStatus(r.error ?? 'قواعد غير صالحة', 'bad');
    return false;
  }
  rulesLoaded = rulesBox.value;
  setRulesStatus('تم الحفظ وتُطبَّق من الرسالة التالية.', 'ok');
  renderRulesInfo((await window.api.getRules()).info);
  return true;
}


// ---------- العزل وخوادم اللغة والجسر ----------

async function loadSandboxUi(): Promise<void> {
  const r = await window.api.sandboxStatus();
  $<HTMLSelectElement>('s-sb-mode').value = r.settings.mode;
  $<HTMLInputElement>('s-sb-image').value = r.settings.image;
  $<HTMLInputElement>('s-sb-net').checked = !!r.settings.network;
  $<HTMLInputElement>('s-sb-extra').value = r.settings.extraArgs ?? '';
  renderSandboxStatus(r);
}

function renderSandboxStatus(r: { text: string; engines: Record<string, { available: boolean; version?: string; reason?: string }> }): void {
  const el = $('sb-status');
  const parts: string[] = [];
  for (const [name, info] of Object.entries(r.engines ?? {})) {
    parts.push(info.available ? `${name} ${info.version ?? ''} ✓` : `${name} ✗${info.reason ? ` (${info.reason})` : ''}`);
  }
  el.textContent = [r.text, parts.join(' · ')].filter(Boolean).join(' — ');
  el.className = `note ${r.text.includes('غير متاح') ? 'bad' : ''}`;
}

function renderLsp(info: Awaited<ReturnType<typeof window.api.lspStatus>>): void {
  const box = $('lsp-list');
  clear(box);
  const status = $('lsp-status');
  if (!info.ok) {
    box.append(h('div', { class: 'note', text: info.error ?? 'تعذّر فحص خوادم اللغة.' }));
    status.textContent = '';
    return;
  }
  if (!info.servers.length) box.append(h('div', { class: 'note', text: 'لا خوادم لغة معرّفة.' }));
  for (const sv of info.servers) {
    const off = (info.disabled ?? []).includes(sv.name);
    const btn = h('button', {
      class: 'btn',
      text: off ? 'تفعيل' : 'تعطيل',
      on: { click: () => void toggleLsp(sv.name) },
    }) as HTMLButtonElement;
    box.append(
      h(
        'div',
        { class: `mcp-row ${sv.available && !off ? '' : 'bad'}` },
        h('span', { class: 'dot' }),
        h('span', { class: 'nm', text: sv.name }),
        h('span', {
          class: 'meta',
          dir: 'auto',
          text: off ? 'معطّل يدوياً' : sv.available ? `${sv.running ? 'يعمل الآن' : 'متاح'} · ${sv.extensions.join(', ')}` : sv.reason ?? 'غير مثبّت',
        }),
        btn,
      ),
    );
  }
  status.textContent = `${info.servers.filter((s) => s.available).length} خادم مثبّت · ${info.running ?? 0} يعمل الآن — شغّلها بـ npm i -g typescript-language-server pyright`;
  $<HTMLButtonElement>('lsp-trust').hidden = !info.needsTrust;
  if (info.needsTrust) status.textContent += ' — إعدادات المشروع معطّلة حتى تضغط «الثقة بإعدادات المشروع».';
  $('lsp-path').textContent = `خوادمك: ${info.userFile ?? ''}\nإعدادات المشروع: ${info.projectFile ?? ''}`;
}

async function toggleLsp(name: string): Promise<void> {
  await window.api.lspToggle(name);
  renderLsp(await window.api.lspStatus());
}

async function loadBridgeUi(): Promise<void> {
  const st = await window.api.bridgeStatus();
  $<HTMLInputElement>('s-br-auto').checked = !!st.auto;
  $<HTMLInputElement>('s-br-port').value = String(st.port_setting ?? 4177);
  renderBridge(st);
}

function renderBridge(st: { running: boolean; url: string | null; note: string; requests: number; token: string; text: string }): void {
  $('br-status').textContent = `${st.text} — ${st.requests} طلب`;
  $('br-status').className = `note ${st.running ? 'ok' : ''}`;
  $('br-url').textContent = st.running && st.url ? `${st.url}  |  الرمز: ${st.token}` : 'الجسر متوقف.';
  $<HTMLButtonElement>('br-toggle').textContent = st.running ? 'إيقاف الجسر' : 'تشغيل الجسر';
}

export async function refreshBridgeUi(): Promise<void> {
  renderBridge(await window.api.bridgeStatus());
}

// ---------- جسر العقل الخارجي: موقع ذكاء اصطناعي داخل التطبيق يقود FreeCode ----------

type ExtBridgeStatus = Awaited<ReturnType<typeof window.api.bridgeHostStatus>>;

function renderExtBridge(st: ExtBridgeStatus): void {
  const el = $('xb-status');
  const state = st.stopped ? `متوقف (${st.stopped})` : st.open ? 'اللوحة مفتوحة' : 'اللوحة مغلقة';
  el.textContent = `${state} — ${st.url} · الوضع: ${st.mode === 'readonly' ? 'قراءة فقط' : 'موافقة'} · استدعاءات ${st.calls} (نجح ${st.ok} · فشل ${st.failed} · رفضها المستخدم أو القراءة فقط ${st.denied}) · موافقات ممنوحة ${st.approved} · قواعد مفعّلة ${st.rules}`;
  el.className = `note ${st.open ? 'ok' : ''}`;
  $('xb-info').textContent = `سجل التنفيذ: ${st.root}/.freecode/bridge-log.jsonl\nالنطاقات المسموحة: ${(st.hosts ?? []).join(' · ')}`;
}

async function loadExtBridgeUi(): Promise<void> {
  const st = await window.api.bridgeHostStatus();
  $<HTMLInputElement>('s-xb-url').value = st.configuredUrl;
  $<HTMLSelectElement>('s-xb-mode').value = st.mode;
  $<HTMLInputElement>('s-xb-hosts').value = (st.configuredHosts ?? []).join(', ');
  renderExtBridge(st);
}

// ---------- الجرد الدوري داخل التطبيق (ح9) ----------

function fmtScheduleTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function scheduleLine(st: SweepScheduleState): string {
  if (!st.enabled) return 'الجدولة موقوفة — فعّلها إذ أردت جرداً دورياً بلا cron.';
  const parts = [`يعمل (كل ${st.everyHours} ساعة)`, `القادم: ${fmtScheduleTime(st.nextRun)}`];
  if (st.running) parts.push('جرد جارٍ الآن…');
  if (st.lastRun) parts.push(`آخر جرد: ${fmtScheduleTime(st.lastRun)}`);
  if (st.lastResult) parts.push(`${st.lastResult.ok ? '✅' : '⚠️'} ${st.lastResult.note.slice(0, 110)}`);
  return parts.join(' · ');
}

export function renderSchedule(st: SweepScheduleState): void {
  $<HTMLInputElement>('s-sched').checked = st.enabled;
  $<HTMLInputElement>('s-sched-every').value = String(st.everyHours);
  $('sched-status').textContent = scheduleLine(st);
}

export async function loadScheduleUi(): Promise<void> {
  try {
    renderSchedule(await window.api.scheduleStatus());
  } catch {
    /* بلا حالة = نترك السطر كما هو */
  }
}

async function applySchedule(): Promise<void> {
  const enabled = $<HTMLInputElement>('s-sched').checked;
  const raw = Number($<HTMLInputElement>('s-sched-every').value);
  const everyHours = Number.isFinite(raw) && raw >= 1 ? Math.min(720, Math.round(raw)) : undefined;
  const btn = $<HTMLButtonElement>('sched-run');
  const st = await window.api.scheduleSet({ enabled, ...(everyHours ? { everyHours } : {}) });
  renderSchedule(st);
  btn.title = st.enabled ? `الجرد القادم: ${fmtScheduleTime(st.nextRun)}` : 'الجدولة موقوفة';
}

export function openSettings(focus?: 'model' | 'key'): void {
  const s = S.settings;
  if (!s) return;
  url.value = s.baseUrl;
  key.value = '';
  key.placeholder = s.hasKey ? '•••••••• (محفوظ — اتركه فارغاً للإبقاء عليه)' : 'freellmapi-…';
  $<HTMLButtonElement>('s-clear-key').hidden = !s.hasKey;
  model.value = s.model;
  $<HTMLInputElement>('s-edits').checked = s.autoApproveEdits;
  $<HTMLInputElement>('s-cmds').checked = s.autoApproveCommands;
  $<HTMLInputElement>('s-budget').value = String(s.tokenBudget);
  $<HTMLInputElement>('s-verify').checked = s.autoVerify;
  $<HTMLInputElement>('s-verify-cmd').value = s.verifyCommand ?? '';
  $<HTMLInputElement>('s-map').checked = s.repoMap;
  $<HTMLInputElement>('s-autocommit').checked = s.autoCommit;
  $<HTMLSelectElement>('s-search-provider').value = s.searchProvider;
  $<HTMLInputElement>('s-search-key').value = '';
  $<HTMLButtonElement>('s-clear-search-key').hidden = !s.hasSearchKey;
  setStatus('');
  updateEndpoint();
  modal.hidden = false;
  void window.api.mcpStatus().then(renderMcp);
  void loadRulesUi();
  void loadSandboxUi();
  void window.api.lspStatus().then(renderLsp);
  void loadBridgeUi();
  void loadExtBridgeUi();
  void loadScheduleUi();
  (focus === 'model' ? model : focus === 'key' ? key : url).focus();
}

function close(): void {
  modal.hidden = true;
}

async function persist(): Promise<Settings> {
  const budget = Number($<HTMLInputElement>('s-budget').value);
  const searchKey = $<HTMLInputElement>('s-search-key').value;
  return window.api.setSettings({
    baseUrl: url.value,
    model: model.value,
    apiKey: key.value,
    autoApproveEdits: $<HTMLInputElement>('s-edits').checked,
    autoApproveCommands: $<HTMLInputElement>('s-cmds').checked,
    autoVerify: $<HTMLInputElement>('s-verify').checked,
    verifyCommand: $<HTMLInputElement>('s-verify-cmd').value,
    repoMap: $<HTMLInputElement>('s-map').checked,
    autoCommit: $<HTMLInputElement>('s-autocommit').checked,
    searchProvider: $<HTMLSelectElement>('s-search-provider').value as Settings['searchProvider'],
    ...(searchKey.trim() ? { searchApiKey: searchKey } : {}),
    ...(Number.isFinite(budget) && budget >= 4000 ? { tokenBudget: budget } : {}),
  });
}

export async function testConnection(): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const r = await window.api.listModels();
  if (r.ok) {
    setConnection('ok');
    return { ok: true, models: r.models ?? [] };
  }
  setConnection('bad', r.error);
  return { ok: false, models: [], error: r.error };
}

export function initSettings(): void {
  $('open-settings').addEventListener('click', () => openSettings());
  $('close-settings').addEventListener('click', close);
  modal.addEventListener('mousedown', (ev) => {
    if (ev.target === modal) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !modal.hidden) close();
  });
  url.addEventListener('input', updateEndpoint);

  $('s-test').addEventListener('click', async () => {
    setStatus('جارٍ الاتصال…');
    hooks.applySettings(await persist());
    key.value = '';
    const r = await testConnection();
    if (!r.ok) {
      setStatus(`تعذّر الاتصال: ${r.error ?? ''}`, 'bad');
      return;
    }
    const dl = $('model-list');
    clear(dl);
    for (const m of r.models) dl.append(h('option', { attrs: { value: m } }));
    setStatus(`تم الاتصال بنجاح — ${r.models.length} موديل متاح`, 'ok');
  });

  $('mcp-reload').addEventListener('click', async () => {
    const btn = $<HTMLButtonElement>('mcp-reload');
    btn.disabled = true;
    btn.textContent = 'جارٍ التشغيل…';
    try {
      renderMcp(await window.api.mcpReload());
    } finally {
      btn.disabled = false;
      btn.textContent = 'إعادة التحميل';
    }
  });

  $('rules-save').addEventListener('click', () => void saveRulesIfChanged(true));
  $('rules-trust').addEventListener('click', async () => {
    const info = await window.api.trustRules();
    renderRulesInfo(info);
    setRulesStatus('تمت الثقة بقواعد المشروع.', 'ok');
  });


  // الجرد الدوري: تفعيل/إيقاف واختيار المدة + جرد فوري
  $('s-sched').addEventListener('change', () => void applySchedule());
  $('s-sched-every').addEventListener('change', () => void applySchedule());
  $('sched-run').addEventListener('click', async () => {
    const line = $('sched-status');
    line.textContent = '🔁 جرد الآن: يشغّل الجرد على مساحة المشروع… (قد يستغرق دقائق)';
    const r = await window.api.metricsSweepNow();
    if (!r.ok) {
      line.textContent = `تعذّر الجرد: ${r.error ?? ''}`;
      return;
    }
    await loadScheduleUi();
    line.textContent = `✅ ${r.digestLine ?? 'تم الجرد'} · الجردات المحفوظة: ${r.runs ?? 0}`;
  });

  $('sb-apply').addEventListener('click', async () => {
    const r = await window.api.sandboxSet({
      mode: $<HTMLSelectElement>('s-sb-mode').value,
      image: $<HTMLInputElement>('s-sb-image').value.trim(),
      network: $<HTMLInputElement>('s-sb-net').checked,
      extraArgs: $<HTMLInputElement>('s-sb-extra').value.trim(),
    });
    setStatus(r.ok ? r.text : r.text, r.ok ? 'ok' : 'bad');
    renderSandboxStatus({ text: r.text, engines: (await window.api.sandboxStatus()).engines });
  });
  $('sb-recheck').addEventListener('click', async () => {
    renderSandboxStatus(await window.api.sandboxStatus());
  });
  $('lsp-reload').addEventListener('click', async () => {
    renderLsp(await window.api.lspStatus());
  });
  $('lsp-trust').addEventListener('click', async () => {
    const r = await window.api.lspTrust();
    $('lsp-status').textContent = r.ok ? 'تمت الثقة بإعدادات خوادم لغة المشروع.' : r.error ?? 'فشل';
    renderLsp(await window.api.lspStatus());
  });
  $('br-toggle').addEventListener('click', async () => {
    const st = await window.api.bridgeStatus();
    const port = Number($<HTMLInputElement>('s-br-port').value);
    const r = st.running ? await window.api.bridgeStop() : await window.api.bridgeStart({ port });
    if (!r.ok) setStatus(r.error ?? 'تعذّر تشغيل الجسر', 'bad');
    renderBridge(await window.api.bridgeStatus());
  });
  // جسر العقل الخارجي: تطبيق الإعدادات ثم الفتح/الإغلاق/التشخيص/السجل
  $('xb-apply').addEventListener('click', async () => {
    const hosts = $<HTMLInputElement>('s-xb-hosts').value.split(/[,\n]/).map((h) => h.trim()).filter(Boolean);
    const r = await window.api.bridgeSettings({
      url: $<HTMLInputElement>('s-xb-url').value.trim(),
      mode: $<HTMLSelectElement>('s-xb-mode').value as 'ask' | 'readonly',
      hosts,
    });
    if (!r.ok) return setStatus('تعذّر تطبيق إعدادات جسر العقل الخارجي.', 'bad');
    setStatus(`حُفظت إعدادات الجسر (${r.mode === 'readonly' ? 'قراءة فقط' : 'موافقة'}).`, 'ok');
    await loadExtBridgeUi();
  });
  $('xb-open').addEventListener('click', async () => {
    const r = await window.api.bridgeCommand('open', $<HTMLInputElement>('s-xb-url').value.trim());
    setStatus(r.text.split('\n')[0], r.ok ? 'ok' : 'bad');
    await loadExtBridgeUi();
  });
  $('xb-close').addEventListener('click', async () => {
    const r = await window.api.bridgeCommand('close');
    setStatus(r.text, r.ok ? '' : 'bad');
    await loadExtBridgeUi();
  });
  $('xb-test').addEventListener('click', async () => {
    const r = await window.api.bridgeCommand('test');
    setStatus(r.text.split('\n').filter(Boolean)[0] ?? r.text, r.ok ? 'ok' : 'bad');
  });
  $('xb-log').addEventListener('click', async () => {
    const r = await window.api.bridgeCommand('log');
    setStatus(r.text.split('\n').filter(Boolean).slice(0, 2).join(' '), r.ok ? '' : 'bad');
  });

  $('br-rotate').addEventListener('click', async () => {
    const r = await window.api.bridgeRotate();
    $('lsp-status').textContent = '';
    setStatus(r.restarted ? 'أُعيد تشغيل الجسر برمز جديد.' : 'وُلّد رمز جديد، وسيُستخدم عند تشغيل الجسر.', 'ok');
    await loadBridgeUi();
  });

  $('s-clear-key').addEventListener('click', async () => {
    const s = await window.api.setSettings({ clearKey: true });
    hooks.applySettings(s);
    key.value = '';
    key.placeholder = 'freellmapi-…';
    $<HTMLButtonElement>('s-clear-key').hidden = true;
    setConnection('');
    setStatus('حُذف المفتاح المحفوظ من هذا الجهاز.', 'ok');
  });

  $('s-clear-search-key').addEventListener('click', async () => {
    hooks.applySettings(await window.api.setSettings({ clearSearchKey: true }));
    $<HTMLInputElement>('s-search-key').value = '';
    $<HTMLButtonElement>('s-clear-search-key').hidden = true;
    setStatus('حُذف مفتاح البحث المحفوظ.', 'ok');
  });

  $('s-save').addEventListener('click', async () => {
    if (!(await saveRulesIfChanged())) return;
    hooks.applySettings(await persist());
    key.value = '';
    close();
    void testConnection();
  });
}
