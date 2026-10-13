// خادم LSP وهمي (إطار Content-Length) يُستخدم في اختبارات selftest فقط.
// لا يُحزَّم مع التطبيق — يعمل عبر stdio ويجيب على الطلبات الأساسية.
'use strict';

const CRLF = '\r\n\r\n';
let buf = Buffer.alloc(0);
const docs = new Map();

function send(obj) {
  const s = JSON.stringify(obj);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + CRLF + s);
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf(CRLF);
    if (sep < 0) return;
    const head = buf.slice(0, sep).toString();
    const m = /content-length:\s*(\d+)/i.exec(head);
    if (!m) {
      buf = buf.slice(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    if (buf.length - sep - 4 < len) return;
    const body = JSON.parse(buf.slice(sep + 4, sep + 4 + len).toString());
    buf = buf.slice(sep + 4 + len);

    if (body.method === 'initialize') {
      send({ jsonrpc: '2.0', id: body.id, result: { capabilities: { executeCommandProvider: { commands: ['_typescript.goToSourceDefinition'] } } } });
      continue;
    }
    if (body.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: body.id, result: null });
      continue;
    }
    if (body.method === 'textDocument/didOpen') {
      const uri = body.params.textDocument.uri;
      docs.set(uri, body.params.textDocument.text);
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri,
          diagnostics: [
            {
              message: 'متغير غير مستخدم',
              severity: 2,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              source: 'fake-ls',
            },
          ],
        },
      });
      continue;
    }
    if (body.method === 'textDocument/definition') {
      const p = body.params.position;
      const uri = body.params.textDocument.uri;
      const lines = (docs.get(uri) || '').split(/\r?\n/);
      const lineText = lines[p.line] || '';
      const dir = uri.slice(0, uri.lastIndexOf('/'));
      if (/\/\/\s*alias/.test(lineText)) {
        // محاكاة خادم لم يحلّ الاسم المستعار: نتيجة فارغة، فيلجأ العميل إلى أمر «تعريف المصدر»
        send({ jsonrpc: '2.0', id: body.id, result: [] });
        continue;
      }
      if (/^\s*(import|export)\b/.test(lineText) || /\brequire\s*\(/.test(lineText)) {
        // الطلب وقع داخل سطر استيراد: نُعيد التعريف الحقيقي (كما يفعل خادم حقيقي بعد القفزة)
        send({ jsonrpc: '2.0', id: body.id, result: [{ uri: `${dir}/math.ts`, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }] });
        continue;
      }
      const importLine = lines.findIndex((l) => /^\s*(import|export)\b/.test(l));
      if (importLine >= 0) {
        // الرمز مستورد (مثل سلوك TypeScript): نُعيد موضع الاستيراد في الملف نفسه، فيُكمله العميل بقفزة
        send({ jsonrpc: '2.0', id: body.id, result: [{ uri, range: { start: { line: importLine, character: 8 }, end: { line: importLine, character: 11 } } }] });
        continue;
      }
      // بلا استيراد: نردّ بالموضع المطلوب نفسه (بإحداثيات LSP) فيكشف الاختبار أي خطأ في التحويل 1-based ↔ 0-based
      send({ jsonrpc: '2.0', id: body.id, result: [{ uri, range: { start: { line: p.line, character: p.character }, end: { line: p.line, character: p.character + 5 } } }] });
      continue;
    }

    if (body.method === 'textDocument/references') {
      const p = body.params.position;
      send({
        jsonrpc: '2.0',
        id: body.id,
        result: [
          { uri: body.params.textDocument.uri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 17 } } },
          { uri: body.params.textDocument.uri, range: { start: { line: p.line, character: p.character }, end: { line: p.line, character: p.character + 3 } } },
        ],
      });
      continue;
    }
    if (body.method === 'textDocument/hover') {
      const p = body.params.position;
      send({ jsonrpc: '2.0', id: body.id, result: { contents: { kind: 'markdown', value: '```typescript\nconst greeting: string\n```' } } });
      continue;
    }
    if (body.method === 'workspace/executeCommand') {
      // محاكاة أمر TypeScript الخاص: يحلّ الاسم المستعار إلى موضع التنفيذ الحقيقي
      const uri = String(body.params?.arguments?.[0] ?? '');
      const dir = uri.slice(0, uri.lastIndexOf('/'));
      send({ jsonrpc: '2.0', id: body.id, result: [{ uri: `${dir}/source.ts`, range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } } }] });
      continue;
    }
    if (body.method === 'never/answer') continue; // لمهلة الاختبار
    if (body.id !== undefined) send({ jsonrpc: '2.0', id: body.id, result: null });
  }
});
