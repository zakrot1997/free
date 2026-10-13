// المهارات (Skills): مجلدات فيها SKILL.md بترويسة بسيطة (name/description).
// متوافقة مع معيار agentskills.io المفتوح الذي تستخدمه أدوات أخرى، فأي مهارة مكتوبة
// لأداة تدعم المعيار تعمل هنا بلا تغيير.
//
// طريقة العمل (كشف تدريجي): نُدرج اسم كل مهارة ووصفها ومسارها في رسالة النظام فقط
// (أحرف قليلة)، ويقرأ الوكيل ملف SKILL.md نفسه بأداة read_file عند تطابق المهمة.
// هكذا لا نستهلك السياق بمهارات غير مستخدمة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface Skill {
  name: string;
  description: string;
  /** مسار ملف SKILL.md (نسبي للمشروع إن كان داخله) */
  file: string;
  source: 'project' | 'user';
  /** نص المهارة كاملاً (يُقرأ عند الاستدعاء الصريح أو الإدراج الكامل) */
  body: string;
}

export interface SkillDirs {
  project: string;
  user: string;
}

export function skillDirs(root: string, userDataDir: string): SkillDirs {
  return { project: path.join(root, '.freecode', 'skills'), user: path.join(userDataDir, 'skills') };
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

/** يقرأ ترويسة YAML بسيطة (key: value) بين --- و---  */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const clean = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(clean);
  if (!m) return { meta: {}, body: clean.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    meta[kv[1].toLowerCase()] = value;
  }
  return { meta, body: clean.slice(m[0].length).trim() };
}

async function readSkill(file: string, fallbackName: string, source: 'project' | 'user', label: string): Promise<Skill | null> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(text);
  const name = (meta.name || fallbackName).trim().toLowerCase();
  if (!NAME_RE.test(name)) return null;
  const firstLine = body.split('\n').find((l) => l.trim()) ?? '';
  const description = (meta.description || firstLine.replace(/^#+\s*/, '')).trim().slice(0, 300);
  if (!description) return null;
  return { name, description, file: label, source, body: body.slice(0, 8000) };
}

/**
 * يكتشف المهارات: كل مجلد داخل `.freecode/skills` (المشروع) أو `<userData>/skills` (المستخدم)
 * فيه SKILL.md. مهارة المشروع تتقدم عند تشابه الاسم.
 */
export async function discoverSkills(
  root: string,
  userDataDir: string,
  /** مجلدات مهارات إضافية من الإضافات (Plugins) */
  extra: { dir: string; source: 'project' | 'user' }[] = [],
): Promise<Skill[]> {
  const dirs = skillDirs(root, userDataDir);
  const found = new Map<string, Skill>();

  const scan = async (dir: string, source: 'project' | 'user'): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 100)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const file = path.join(dir, e.name, 'SKILL.md');
      const label = source === 'project' ? path.relative(root, file).split(path.sep).join('/') : file;
      const skill = await readSkill(file, e.name, source, label);
      if (!skill) continue;
      const prev = found.get(skill.name);
      if (!prev || (prev.source === 'user' && skill.source === 'project')) found.set(skill.name, skill);
    }
  };

  await scan(dirs.project, 'project');
  await scan(dirs.user, 'user');
  // مهارات الإضافات: مسارها مطلق (خارج المشروع عادة) ويُفتح عبر جذور القراءة الإضافية
  for (const ex of extra) await scan(ex.dir, ex.source);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** قائمة موجزة تُضاف إلى رسالة النظام (أسماء وأوصاف ومسارات فقط) */
export function skillsPromptSection(skills: Skill[]): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description} (file: ${s.file})`);
  return `

Available skills — reusable, project-specific procedures. When the user's request matches a skill's description, read its file with read_file first, then follow its instructions exactly. Do not mention skills that do not apply.
${lines.join('\n')}`;
}

/** يجهّز استدعاءً صريحاً لمهارة: نص المهارة + وسائط المستخدم */
export function skillInvocation(skill: Skill, args: string): string {
  const head = `نفّذ المهارة «${skill.name}» الموصوفة أدناه بدقة.`;
  const tail = args.trim() ? `\n\nوسائط/تفاصيل من المستخدم: ${args.trim()}` : '';
  return `${head}\n\n--- SKILL: ${skill.name} ---\n${skill.body}${tail}`;
}

export const SKILL_TEMPLATE = `---
name: my-skill
description: وصف قصير يساعد الوكيل على معرفة متى يستخدم هذه المهارة
---

# الهدف
ما الذي تنجزه هذه المهارة؟

# الخطوات
1. خطوة أولى واضحة
2. خطوة ثانية

# قواعد
- ما يجب فعله وما يجب تجنّبه
`;
