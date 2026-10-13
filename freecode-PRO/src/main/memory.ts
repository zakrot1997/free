// ذاكرة المشروع: ملف نصي صغير يحتفظ بتفضيلات المستخدم وقرارات المشروع بين الجلسات،
// يُقرأ تلقائياً في كل محادثة (مثل CLAUDE.md لكن للتراكم التلقائي بدل الكتابة اليدوية).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const MEMORY_REL = '.freecode/memory.md';
const MAX_CHARS = 4000;

export function memoryPath(root: string): string {
  return path.join(root, MEMORY_REL);
}

export async function loadMemory(root: string): Promise<string> {
  try {
    const text = await fs.readFile(memoryPath(root), 'utf8');
    return text.trim().slice(0, MAX_CHARS);
  } catch {
    return '';
  }
}

/** يضيف ملاحظة (سطر نقطي) ويمنع التكرار الحرفي */
export async function appendMemory(root: string, note: string): Promise<boolean> {
  const clean = note.replace(/\r/g, '').trim();
  if (!clean) return false;
  const current = await loadMemory(root);
  const bullet = `- ${clean.replace(/\n+/g, ' ')}`;
  if (current.includes(bullet)) return false;
  const header = current ? '' : '# ذاكرة المشروع (FreeCode)\n';
  const next = `${current}${current.endsWith('\n') || !current ? '' : '\n'}${header}${bullet}\n`;
  await fs.mkdir(path.dirname(memoryPath(root)), { recursive: true });
  await fs.writeFile(memoryPath(root), next.slice(-MAX_CHARS * 2), 'utf8');
  return true;
}
