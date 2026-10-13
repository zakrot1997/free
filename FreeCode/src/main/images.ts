// إدارة الصور المرفقة بالمحادثة: التحقق، والتخزين على القرص، والقراءة.
// تُحفظ الصور في ملفات منفصلة (لا داخل JSON الجلسة) فلا تتضخم ملفات المحادثات،
// وتبقى في الذاكرة كـ data URL في أثناء الجلسة ليسهل إرسالها للمزوّد.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export const MAX_IMAGES_PER_MESSAGE = 4;
/** حدّ حجم الصورة الواحدة (بعد ترميز base64) */
export const MAX_IMAGE_CHARS = 6_000_000;

const DATA_URL_RE = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

/** هل هذه data URL لصورة مقبولة الحجم والنوع؟ (نتحقق قبل استخدام أي شيء من الواجهة) */
export function isImageDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_IMAGE_CHARS && DATA_URL_RE.test(value);
}

export function filterImageDataUrls(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isImageDataUrl).slice(0, MAX_IMAGES_PER_MESSAGE);
}

const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp' };

export function extOfDataUrl(dataUrl: string): string {
  const m = /^data:image\/(\w+);/i.exec(dataUrl);
  return (m && EXT[m[1].toLowerCase()]) || 'png';
}

export function decodeDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const m = /^data:(image\/[\w+.-]+);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!m) throw new Error('صورة بصيغة غير مدعومة');
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

/** يحفظ صور رسالة ويعيد معرّفاتها (مسارات نسبية داخل مجلد الصور) */
export async function saveImages(dir: string, sessionId: string, msgIndex: number, dataUrls: string[]): Promise<string[]> {
  if (!dataUrls.length) return [];
  const safeSession = sessionId.replace(/[^\w-]/g, '');
  const target = path.join(dir, safeSession);
  await fs.mkdir(target, { recursive: true });
  const refs: string[] = [];
  for (let i = 0; i < dataUrls.length; i++) {
    const ext = extOfDataUrl(dataUrls[i]);
    const name = `${msgIndex}-${i}.${ext}`;
    await fs.writeFile(path.join(target, name), decodeDataUrl(dataUrls[i]).buffer);
    refs.push(`${safeSession}/${name}`);
  }
  return refs;
}

const cache = new Map<string, string>();
const CACHE_MAX = 24;

/** يقرأ صورة من القرص ويعيدها data URL (مع تخزين مؤقت محدود) */
export async function readImageDataUrl(dir: string, ref: string): Promise<string | null> {
  const abs = path.join(dir, ref);
  const hit = cache.get(abs);
  if (hit) return hit;
  try {
    const buf = await fs.readFile(abs);
    const ext = (path.extname(abs).slice(1) || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
    const url = `data:${mime};base64,${buf.toString('base64')}`;
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(abs, url);
    return url;
  } catch {
    return null;
  }
}

export function clearImageCache(): void {
  cache.clear();
}

/** ملخّص نصي لصورة (يُستخدم عند التلخيص أو ضغط السياق أو غياب الملف) */
export const IMAGE_NOTE = '[صورة مرفقة]';

/** يقرأ ملف صورة من القرص ويعيده data URL (للوضع Headless وواجهة السطر) */
export async function dataUrlFromFile(file: string): Promise<string> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const mime =
    ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : '';
  if (!mime) throw new Error(`صيغة صورة غير مدعومة: ${file} (المدعوم: png/jpg/webp/gif)`);
  const buf = await fs.readFile(file);
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  if (!isImageDataUrl(dataUrl)) throw new Error(`الصورة كبيرة جداً أو غير صالحة: ${file}`);
  return dataUrl;
}

/** يجمع مسارات الصور إلى data URLs مع حدّ أقصى للعدد */
export async function dataUrlsFromFiles(files: string[]): Promise<string[]> {
  const urls: string[] = [];
  for (const f of files.slice(0, MAX_IMAGES_PER_MESSAGE)) urls.push(await dataUrlFromFile(f));
  return urls;
}
