// بناء سياق المشروع: تعليمات FREECODE.md، معلومات البيئة، شجرة مختصرة، وضغط المحادثة الطويلة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { ChatMessage, LLMConfig } from './llm';
import { chatOnce, estimateTokens } from './llm';

const INSTRUCTION_FILES = ['FREECODE.md', 'AGENTS.md', 'CLAUDE.md'];
const SKIP = new Set(['node_modules', '.git', 'dist', 'release', '.next', '__pycache__', '.venv', 'build', 'target', '.idea', '.vscode']);

export async function loadProjectInstructions(root: string): Promise<{ file: string; text: string } | null> {
  for (const name of INSTRUCTION_FILES) {
    try {
      const text = await fs.readFile(path.join(root, name), 'utf8');
      if (text.trim()) return { file: name, text: text.slice(0, 8000) };
    } catch {
      /* غير موجود */
    }
  }
  return null;
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: root, timeout: 4000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });
}

export async function shallowTree(root: string, maxEntries = 60): Promise<string> {
  const lines: string[] = [];
  async function go(dir: string, depth: number): Promise<void> {
    if (lines.length >= maxEntries) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= maxEntries) {
        lines.push('  '.repeat(depth) + '…');
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        lines.push('  '.repeat(depth) + e.name + '/');
        if (depth < 2) await go(path.join(dir, e.name), depth + 1);
      } else {
        lines.push('  '.repeat(depth) + e.name);
      }
    }
  }
  await go(root, 0);
  return lines.join('\n');
}

export async function environmentBlock(root: string): Promise<string> {
  const [branch, status] = await Promise.all([git(root, ['rev-parse', '--abbrev-ref', 'HEAD']), git(root, ['status', '--short'])]);
  const tree = await shallowTree(root);
  const parts = [
    `Working directory: ${root}`,
    `Platform: ${process.platform}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    branch ? `Git branch: ${branch}` : 'Git: not a repository',
  ];
  if (status) parts.push(`Git status (short):\n${status.split('\n').slice(0, 20).join('\n')}`);
  if (tree) parts.push(`Project tree:\n${tree}`);
  return parts.join('\n');
}

/**
 * ضغط السياق: عندما تتجاوز المحادثة الميزانية نقتطع مخرجات الأدوات القديمة (الأثقل عادةً)
 * ونُبقي آخر `keepRecent` رسائل كما هي. لا نحذف أي رسالة حتى يبقى تسلسل tool_calls سليماً.
 */
export function compactMessages(messages: ChatMessage[], budgetTokens: number, keepRecent = 8): { messages: ChatMessage[]; saved: number } {
  if (estimateTokens(messages) <= budgetTokens) return { messages, saved: 0 };
  const before = estimateTokens(messages);
  const cut = Math.max(1, messages.length - keepRecent);
  const out = messages.map((m, i) => {
    if (i >= cut || i === 0) return m;
    // الصور القديمة تُسقَط أولاً: هي الأثقل في السياق، والحديثة تبقى كما هي
    if (m.images?.length && i < cut) {
      const kept = m.content ? `${m.content}\n[صورة مرفقة سابقاً]` : '[صورة مرفقة سابقاً]';
      return { ...m, images: undefined, content: kept };
    }
    if (m.role === 'tool' && m.content && m.content.length > 400) {
      return { ...m, content: m.content.slice(0, 300) + `\n…[تم اختصار ${m.content.length - 300} حرف لتوفير السياق]` };
    }
    if (m.role === 'assistant' && m.tool_calls) {
      // نقتطع محتوى الكتابة الكبير في وسائط الأدوات القديمة
      const calls = m.tool_calls.map((c) =>
        c.function.arguments.length > 600
          ? { ...c, function: { ...c.function, arguments: JSON.stringify({ _compacted: true, note: 'وسائط كبيرة اختُصرت' }) } }
          : c,
      );
      return { ...m, tool_calls: calls };
    }
    return m;
  });
  return { messages: out, saved: Math.max(0, before - estimateTokens(out)) };
}

// ---------- التلخيص الذكي ----------

export const SUMMARY_MARK = '[ملخص المحادثة السابقة]';

const SUMMARY_PROMPT = `You are summarizing an ongoing conversation between a user and an AI coding agent, so the agent can continue the work with a much shorter context.
Write a faithful, compact summary (max ~500 words, bullet points) covering:
- the user's goals, requirements and constraints (including preferences about style/language)
- decisions made and the reasoning that still matters
- files created or modified (exact paths) and what changed in each
- commands that were run and their important outcomes (failures and fixes included)
- the current status and what remains to be done
Write in the language the user used. Do not invent anything. Output only the summary.`;

/** يحوّل رسائل إلى نص مقروء للتلخيص (مع اقتطاع المخرجات الطويلة) */
export function transcriptOf(messages: ChatMessage[], maxChars = 60_000): string {
  const parts: string[] = [];
  for (const m of messages) {
    const imgNote = m.images?.length ? `\n[${m.images.length} صورة مرفقة]` : '';
    if (m.role === 'user') parts.push(`[user]\n${(m.content ?? '').slice(0, 4000)}${imgNote}`);
    else if (m.role === 'assistant') {
      let s = `[assistant]\n${(m.content ?? '').slice(0, 3000)}`;
      for (const c of m.tool_calls ?? []) s += `\n  -> ${c.function.name}(${c.function.arguments.slice(0, 300)})`;
      parts.push(s);
    } else if (m.role === 'tool') parts.push(`[tool result]\n${(m.content ?? '').slice(0, 600)}`);
  }
  const all = parts.join('\n\n');
  return all.length > maxChars ? all.slice(0, maxChars / 3) + '\n…[اختُصر الوسط]…\n' + all.slice(-maxChars * 2 / 3) : all;
}

/**
 * نقطة قطع آمنة: نُبقي ذيلاً بحجم ≈ tailTokens، ونقطع عند رسالة ليست "tool"
 * حتى لا نفصل استدعاء أداة عن نتيجته. يعيد -1 إن لم يوجد ما يستحق التلخيص.
 */
export function findSummaryCut(messages: ChatMessage[], tailTokens: number): number {
  let acc = 0;
  let i = messages.length;
  while (i > 1) {
    i--;
    acc += estimateTokens([messages[i]]);
    if (acc >= tailTokens) break;
  }
  while (i > 1 && messages[i].role === 'tool') i--;
  return i - 1 >= 4 ? i : -1; // الرأس يجب أن يحوي 4 رسائل على الأقل
}

export interface SummarizeResult {
  messages: ChatMessage[];
  count: number; // عدد الرسائل التي لُخّصت
}

export async function summarizeHistory(
  cfg: LLMConfig,
  messages: ChatMessage[],
  budgetTokens: number,
  signal?: AbortSignal,
): Promise<SummarizeResult | null> {
  const cut = findSummaryCut(messages, Math.floor(budgetTokens * 0.35));
  if (cut < 0) return null;
  const head = messages.slice(1, cut);
  const summary = await chatOnce(
    cfg,
    [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: transcriptOf(head) },
    ],
    signal,
  );
  const tail = messages.slice(cut);
  const next: ChatMessage[] = [messages[0], { role: 'user', content: `${SUMMARY_MARK}\n${summary.trim()}` }];
  if (tail[0]?.role === 'user') next.push({ role: 'assistant', content: 'فهمت. سأتابع العمل بناءً على هذا الملخص.' });
  next.push(...tail);
  return { messages: next, count: head.length };
}
