// إضافة VS Code رقيقة: ترسل المهمة إلى جسر FreeCode (تطبيق سطح المكتب) وتعرض
// الأحداث لحظياً (نص الوكيل، الأدوات، الأخطاء) في لوحة إخراج.
//
// لا تعمل أي ذكاء محلي هنا؛ كل شيء يمرّ للتطبيق. ما تمنحه الإضافة هو السياق:
// الملف الحالي والتحديد ولغة الملف، فتصبح جملة مثل «اشرح هذا» كافية.
const vscode = require('vscode');

/** @type {vscode.OutputChannel | null} */
let out = null;
/** @type {number} */
let eventBase = 0;

function cfg() {
  const c = vscode.workspace.getConfiguration('freecode');
  return {
    url: String(c.get('bridgeUrl') || 'http://127.0.0.1:4177').replace(/\/$/, ''),
    token: String(c.get('bridgeToken') || ''),
    allowCommands: c.get('allowCommands') === true,
  };
}

async function api(path, init = {}) {
  const { url, token } = cfg();
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-FreeCode-Token': token, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function channel() {
  if (!out) out = vscode.window.createOutputChannel('FreeCode');
  return out;
}

/** يفتح تدفّق SSE ويطبع الأحداث في اللوحة */
function stream() {
  const { url, token } = cfg();
  const ch = channel();
  // fetch من Node 18+ يدعم التدفّق عبر ReadableStream
  fetch(`${url}/events?token=${encodeURIComponent(token)}`, { headers: { Accept: 'text/event-stream' } })
    .then(async (res) => {
      if (!res.ok || !res.body) throw new Error(`تعذّر الاتصال بالجسر (HTTP ${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          handleEvent(JSON.parse(line.slice(6)), ch);
        }
      }
    })
    .catch((e) => ch.appendLine(`⚠️ ${e.message} — تحقق أن FreeCode يعمل وأن /bridge on مفعّل.`));
}

function handleEvent(e, ch) {
  switch (e.type) {
    case 'text':
      ch.append(e.delta);
      break;
    case 'tool_call':
      ch.appendLine(`\n› ${e.name} ${JSON.stringify(e.args || {}).slice(0, 120)}`);
      break;
    case 'tool_result':
      if (e.isError) ch.appendLine(`\n[خطأ] ${String(e.result).slice(0, 300)}`);
      break;
    case 'notice':
      ch.appendLine(`\n[${e.message}]`);
      break;
    case 'error':
      ch.appendLine(`\n❌ ${e.message}`);
      break;
    case 'done':
      ch.appendLine('\n— انتهى —\n');
      break;
    default:
      break;
  }
}

/** يبني نص المهمة مع سياق المحرر */
function withContext(question) {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return question;
  const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
  const sel = ed.selection;
  const selected = sel && !sel.isEmpty ? ed.document.getText(sel) : '';
  const line = sel?.active?.line !== undefined ? sel.active.line + 1 : 1;
  const parts = [question, '', `الملف: ${rel} (السطر ${line})`];
  if (selected) parts.push('', 'التحديد:', '```', selected.slice(0, 6000), '```');
  return parts.join('\n');
}

async function ask(question, fromSelection) {
  if (!question) return;
  const ch = channel();
  ch.show(true);
  const text = fromSelection ? withContext(question) : withContext(question);
  const { allowCommands } = cfg();
  try {
    await api('/message', { method: 'POST', body: JSON.stringify({ text, mode: 'act', allowCommands }) });
    ch.appendLine(`\n▶ ${question}\n`);
    stream();
  } catch (e) {
    ch.appendLine(`⚠️ ${e.message}`);
    const open = await vscode.window.showErrorMessage(`FreeCode: ${e.message}`, 'فتح الإعدادات');
    if (open) void vscode.commands.executeCommand('workbench.action.openSettings', 'freecode');
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('freecode.ask', async () => {
      const q = await vscode.window.showInputBox({ prompt: 'ما المطلوب من FreeCode؟', placeHolder: 'مثال: أضف اختبارات لهذا الملف' });
      if (q) void ask(q, false);
    }),
    vscode.commands.registerCommand('freecode.askSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showWarningMessage('حدّد نصاً أولاً.');
        return;
      }
      const q = await vscode.window.showInputBox({ prompt: 'ما المطلوب بخصوص التحديد؟', value: 'اشرح هذا الكود واقترح تحسينات' });
      if (q) void ask(q, true);
    }),
    vscode.commands.registerCommand('freecode.status', async () => {
      const ch = channel();
      ch.show(true);
      try {
        const st = await api('/status');
        ch.appendLine(`جسر FreeCode: ${st.running ? 'مشغول' : 'جاهز'} · المشروع: ${st.workspace || '—'} · المنفذ: ${st.bridge?.port ?? '—'}`);
        if (st.lastResult) ch.appendLine(`آخر نتيجة: ${String(st.lastResult).slice(0, 500)}`);
      } catch (e) {
        ch.appendLine(`⚠️ ${e.message}`);
      }
    }),
  );
}

function deactivate() {
  out?.dispose();
  out = null;
}

module.exports = { activate, deactivate };
