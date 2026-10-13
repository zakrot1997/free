// حفظ المحادثات على القرص لاستعادتها لاحقاً (ملف JSON لكل جلسة).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { estimateTokens, type ChatMessage } from './llm';
import type { TodoItem } from './tools';

export interface SessionData {
  id: string;
  title: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[]; // بدون رسالة النظام
  todos: TodoItem[];
}

export interface SessionSummary {
  id: string;
  title: string;
  workspace: string;
  updatedAt: number;
  turns: number;
}

export type RenderItem =
  | { type: 'user'; text: string; attachments: string[]; images?: string[] }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; id: string; name: string; args: unknown; result?: string; isError?: boolean };

const ATTACH_RE = /\n\n<attached_file path="([^"]+)">[\s\S]*?<\/attached_file>/g;

/**
 * الصور تُحفظ في ملفات مستقلة (لا داخل JSON الجلسة) فلا تتضخم ملفات المحادثات،
 * ويُشار إليها بمسار نسبي. عند الفتح تُقرأ الصور المتبقية إلى data URL مرة أخرى.
 */
export type SaveImage = (msgIndex: number, dataUrls: string[]) => Promise<string[]>;
export type LoadImage = (ref: string) => Promise<string | null>;

export async function dehydrateImages(messages: ChatMessage[], save: SaveImage): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m.images?.length) {
      out.push(m);
      continue;
    }
    try {
      const refs = await save(i, m.images);
      out.push({ ...m, images: refs });
    } catch {
      // فشل حفظ الصورة لا يفقد الرسالة: نتجاهل الصور ونوضّح ذلك
      out.push({ ...m, images: undefined, content: `${m.content ?? ''}\n\n[تعذّر حفظ الصور المرفقة]`.trim() });
    }
  }
  return out;
}

export async function rehydrateImages(messages: ChatMessage[], load: LoadImage): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (!m.images?.length) {
      out.push(m);
      continue;
    }
    const urls: string[] = [];
    for (const ref of m.images) {
      const url = await load(ref);
      if (url) urls.push(url);
    }
    if (urls.length) out.push({ ...m, images: urls });
    else out.push({ ...m, images: undefined, content: `${m.content ?? ''}\n\n[صورة مرفقة سابقاً — لم تعد متاحة]`.trim() });
  }
  return out;
}


export function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFrom(text: string): string {
  const clean = text.replace(ATTACH_RE, '').replace(/\s+/g, ' ').trim();
  return clean.length > 56 ? clean.slice(0, 56) + '…' : clean || 'محادثة جديدة';
}

export class SessionStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('معرّف جلسة غير صالح');
    return path.join(this.dir, `${id}.json`);
  }

  async save(s: SessionData): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    s.updatedAt = Date.now();
    const tmp = this.file(s.id) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, this.file(s.id));
  }

  async load(id: string): Promise<SessionData | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(id), 'utf8'));
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.file(id), { force: true });
  }

  async list(workspace?: string): Promise<SessionSummary[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const n of names) {
      try {
        const s: SessionData = JSON.parse(await fs.readFile(path.join(this.dir, n), 'utf8'));
        if (workspace && s.workspace !== workspace) continue;
        out.push({ id: s.id, title: s.title, workspace: s.workspace, updatedAt: s.updatedAt, turns: s.messages.filter((m) => m.role === 'user').length });
      } catch {
        /* ملف تالف: نتجاهله */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

/** يحوّل رسائل LLM المحفوظة إلى عناصر عرض للواجهة (لاستعادة المحادثة بصرياً) */
export function messagesToItems(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  const toolItems = new Map<string, Extract<RenderItem, { type: 'tool' }>>();
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.content ?? '';
      if (text.startsWith('[ملاحظة آلية]') || text.startsWith('[ملخص المحادثة')) continue;
      const attachments = [...text.matchAll(ATTACH_RE)].map((x) => x[1]);
      items.push({ type: 'user', text: text.replace(ATTACH_RE, ''), attachments, images: m.images });
    } else if (m.role === 'assistant') {
      if (m.content) items.push({ type: 'assistant', text: m.content });
      for (const c of m.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {
          args = {};
        }
        const it = { type: 'tool' as const, id: c.id, name: c.function.name, args };
        toolItems.set(c.id, it);
        items.push(it);
      }
    } else if (m.role === 'tool' && m.tool_call_id) {
      const it = toolItems.get(m.tool_call_id);
      if (it) {
        it.result = m.content ?? '';
        it.isError = /^(خطأ|رفض|أداة غير|تعذّر)/.test(it.result);
      }
    }
  }
  return items;
}

/** يحوّل الجلسة إلى Markdown قابل للمشاركة (مع الأدوات المختصرة) */
export function sessionToMarkdown(session: SessionData, meta: { model?: string } = {}): string {
  const when = new Date(session.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const lines: string[] = [`# ${session.title}`, '', `- المشروع: \`${session.workspace}\``, `- البداية: ${when}${meta.model ? ` · الموديل: ${meta.model}` : ''}`, ''];
  for (const m of session.messages) {
    if (m.role === 'user') {
      const text = (m.content ?? '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text && !m.images?.length) continue;
      lines.push('## 👤 المستخدم', '', text || '(رسالة بلا نص)', m.images?.length ? `\n> 🖼 ${m.images.length} صورة مرفقة` : '', '');
    } else if (m.role === 'assistant') {
      const text = (m.content ?? '').trim();
      if (text) lines.push('## 🤖 FreeCode', '', text, '');
      for (const c of m.tool_calls ?? []) {
        let args = '';
        try {
          args = JSON.stringify(JSON.parse(c.function.arguments || '{}')).slice(0, 200);
        } catch {
          args = String(c.function.arguments ?? '').slice(0, 200);
        }
        lines.push(`\`🔧 ${c.function.name}\` ${args}`);
      }
      if (m.tool_calls?.length) lines.push('');
    } else if (m.role === 'tool') {
      const out = (m.content ?? '').trim();
      if (out && out.length < 1200 && !out.includes('\n')) lines.push(`> ${out}`, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** إحصاءات الجلسة: رسائل، أدوات، توكنات تقديرية، أول/آخر نشاط */
export function sessionStats(session: SessionData): {
  messages: number;
  user: number;
  assistant: number;
  toolCalls: number;
  images: number;
  tokens: number;
  durationMs: number;
  tools: { name: string; count: number }[];
} {
  let user = 0;
  let assistant = 0;
  let toolCalls = 0;
  let images = 0;
  const tools = new Map<string, number>();
  for (const m of session.messages) {
    if (m.role === 'user') {
      user++;
      images += m.images?.length ?? 0;
    } else if (m.role === 'assistant') assistant++;
    for (const c of m.tool_calls ?? []) {
      toolCalls++;
      tools.set(c.function.name, (tools.get(c.function.name) ?? 0) + 1);
    }
  }
  return {
    messages: session.messages.length,
    user,
    assistant,
    toolCalls,
    images,
    tokens: estimateTokens(session.messages),
    durationMs: Math.max(0, session.updatedAt - session.createdAt),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
  };
}
