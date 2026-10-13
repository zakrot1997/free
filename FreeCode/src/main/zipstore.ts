// مولّد ZIP بلا أي اعتماديات خارجية: deflateRaw من zlib المدمج في Node + CRC32 خاص.
// الهدف: «إصدار ببصمة» — حزمة قابلة لإعادة الإنتاج مع sha256 وقائمة ملفات، من داخل
// المشروع نفسه بلا أدوات نظام. يستخدمه scripts/release.mjs وتختبره §78.
import { deflateRawSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32 قياسي (نفس المستخدم في PNG/ZIP) */
export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** مسار داخل الأرشيف بفواصل «/» */
  name: string;
  data: Buffer;
}

function dosTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** يبني أرشيف ZIP (deflate) من قائمة مدخلات — بترتيب أبجدي لنتيجة قابلة للمقارنة */
export function makeZip(entries: ZipEntry[], at = new Date()): Buffer {
  const { time, date } = dosTime(at);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const deflated = deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs (regular file) — >>>0 لأن الإزاحة تخرج عن int32
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** يقرأ أسماء الملفات من أرشيف ZIP (لفحص الحزمة بعد بنائها) */
export function listZipEntries(zip: Buffer): string[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65535; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    names.push(zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** المجلدات التي لا تدخل الحزمة أبداً (بيانات بناء أو محلية أو ضخمة) */
export const RELEASE_EXCLUDES = [
  'node_modules',
  'dist',
  '.git',
  '.freecode',
  '.cache',
  '.npm',
  'coverage',
  '.venv',
  '__pycache__',
];

/** يعدّ ملفات الإصدار: كل ما تحت /home/... المشروع عدا المستبعدات وملفات .log/.zip */
export async function collectFiles(root: string): Promise<{ rel: string; size: number }[]> {
  const out: { rel: string; size: number }[] = [];
  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const it of items) {
      const abs = path.join(dir, it.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (RELEASE_EXCLUDES.includes(it.name)) continue;
      if (it.name.startsWith('coredump')) continue;
      if (it.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (/\.(log|zip)$/i.test(it.name)) continue;
      const st = await fs.stat(abs);
      out.push({ rel, size: st.size });
    }
  };
  await walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** يجمع ملفات المشروع في أرشيف جاهز للكتابة (أو حزمة مخصّصة للاختبار) */
export async function zipFiles(root: string, files?: { rel: string; size: number }[]): Promise<{ zip: Buffer; files: string[] }> {
  const list = files ?? (await collectFiles(root));
  const entries: ZipEntry[] = [];
  for (const f of list) entries.push({ name: f.rel, data: await fs.readFile(path.join(root, f.rel)) });
  return { zip: makeZip(entries), files: list.map((f) => f.rel) };
}
