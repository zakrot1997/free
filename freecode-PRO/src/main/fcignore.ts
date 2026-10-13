// حارس `.freecode/.gitignore`: مجلد `.freecode/` يُنشأ تلقائياً مع الاستخدام (سجل الجسر،
// أرشيف القياس، الملصقات، إعدادات المشروع…) — ولو لم يكن متجاهَلاً في git رفعه
// `git add .` مرة واحدة إلى المستودع: سجلات قياسك ونقاط استعادتك تصبح علنية.
// فهذا الحارس يكتب `.freecode/.gitignore` عند أول كتابة، ولا يلمس ملفاً موجوداً (قد يكون
// عند المستخدم قواعد مقصودة يريد الحفاظ عليها).
import * as fs from 'node:fs';
import * as path from 'node:path';

export const FREECODE_DIR = '.freecode';

/** جسم الحارس المكتوب عند أول استخدام: يتجاهل كل ما في المجلد إلا الحارس نفسه */
export const FREECODE_IGNORE_BODY = [
  '# أنشأه FreeCode تلقائياً: ملفات حالة محلية لا تُرفع إلى git',
  '# (سجل الجسر · أرشيف القياس · الجلسات · الإعدادات المحلية · الملصقات)',
  '*',
  '!.gitignore',
  '',
].join('\n');

export type IgnoreGuard = 'created' | 'exists' | 'error';

/** يضمن وجود `.freecode/.gitignore`. لا يلمس ملفاً موجوداً؛ يعيد ما جرى */
export function ensureFreecodeIgnored(root: string): IgnoreGuard {
  if (!root) return 'error';
  try {
    const dir = path.join(root, FREECODE_DIR);
    const file = path.join(dir, '.gitignore');
    if (fs.existsSync(file)) return 'exists';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, FREECODE_IGNORE_BODY, 'utf8');
    return 'created';
  } catch {
    return 'error'; // أفضل جهد: فشل الحارس لا يُسقط العملية التي كتبت من أجله
  }
}

export type IgnoreStatus = 'ok' | 'custom' | 'missing' | 'no-dir';

/** حالة الحارس في مشروع — يستعملها `npm run doctor` قبل أن يشتكي git */
export function freecodeIgnoreStatus(root: string): IgnoreStatus {
  const dir = path.join(root, FREECODE_DIR);
  if (!fs.existsSync(dir)) return 'no-dir'; // لا مجلد حالة بعد ⇒ لا خطر تسرّب
  const file = path.join(dir, '.gitignore');
  if (!fs.existsSync(file)) return 'missing';
  try {
    const body = fs.readFileSync(file, 'utf8');
    return /\*/.test(body) && body.includes('!.gitignore') ? 'ok' : 'custom';
  } catch {
    return 'missing';
  }
}
