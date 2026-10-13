/**
 * ملصق PNG محلي — بلا أي اعتماد خارجي وبلا خدمات شبكة:
 *  1) قارئ TrueType مصغّر (head/hhea/maxp/cmap/hmtx/loca/glyf) يفكّ أيضاً المركّبات
 *  2) تشكيل عربي: يختار شكل العرض (معزول/بدئي/وسطي/نهائي) عبر جدول FE70–FEFC ويصل «لا»
 *  3) ترتيب ثنائي الاتجاه مبسّط: سطر عربي RTL مع أرقام/لاتينية مدمجة LTR
 *  4) رسّام مسح ضوئي بحافة متدرّجة (supersampling 4×) لمنحنيات بيزيه التربيعية
 *  5) مُرمِّز PNG نقي (zlib + CRC32) بخروج RGBA8
 *
 * لماذا تنفيذ ذاتي؟ القنوات التي لا تقبل HTML تحتاج صورة فعلية، وأغلب
 * بيئات CI لا تضمن خطاً عربياً نظامياً ولا حزمة رسم — الخط المدمج + هذا
 * الراسم يجعلان الملصق حتمياً في أي مكان (والتقارير النصية تبقى الحقيقة).
 */
import zlib from 'node:zlib';
import { BADGE_FONT_B64 } from './font';

// ============================ قراءة عددية ============================
const u8 = (b: Buffer, i: number): number => b[i];
const u16 = (b: Buffer, i: number): number => (b[i] << 8) | b[i + 1];
const s16 = (b: Buffer, i: number): number => ((b[i] << 8) | b[i + 1]) << 16 >> 16;
const u32 = (b: Buffer, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// ============================ جدول أشكال العرض ============================
/** حرف أساسي ← [معزول، نهائي، بدئي، وسطي] (0 = لا يوجد) */
const PRESENT = new Map<number, [number, number, number, number]>([
  [0x0621, [0xfe80, 0, 0, 0]],
  [0x0622, [0xfe81, 0xfe82, 0, 0]],
  [0x0623, [0xfe83, 0xfe84, 0, 0]],
  [0x0624, [0xfe85, 0xfe86, 0, 0]],
  [0x0625, [0xfe87, 0xfe88, 0, 0]],
  [0x0626, [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c]],
  [0x0627, [0xfe8d, 0xfe8e, 0, 0]],
  [0x0628, [0xfe8f, 0xfe90, 0xfe91, 0xfe92]],
  [0x0629, [0xfe93, 0xfe94, 0, 0]],
  [0x062A, [0xfe95, 0xfe96, 0xfe97, 0xfe98]],
  [0x062B, [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c]],
  [0x062C, [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0]],
  [0x062D, [0xfea1, 0xfea2, 0xfea3, 0xfea4]],
  [0x062E, [0xfea5, 0xfea6, 0xfea7, 0xfea8]],
  [0x062F, [0xfea9, 0xfeaa, 0, 0]],
  [0x0630, [0xfeab, 0xfeac, 0, 0]],
  [0x0631, [0xfead, 0xfeae, 0, 0]],
  [0x0632, [0xfeaf, 0xfeb0, 0, 0]],
  [0x0633, [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4]],
  [0x0634, [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8]],
  [0x0635, [0xfeb9, 0xfeba, 0xfebb, 0xfebc]],
  [0x0636, [0xfebd, 0xfebe, 0xfebf, 0xfec0]],
  [0x0637, [0xfec1, 0xfec2, 0xfec3, 0xfec4]],
  [0x0638, [0xfec5, 0xfec6, 0xfec7, 0xfec8]],
  [0x0639, [0xfec9, 0xfeca, 0xfecb, 0xfecc]],
  [0x063A, [0xfecd, 0xfece, 0xfecf, 0xfed0]],
  [0x0641, [0xfed1, 0xfed2, 0xfed3, 0xfed4]],
  [0x0642, [0xfed5, 0xfed6, 0xfed7, 0xfed8]],
  [0x0643, [0xfed9, 0xfeda, 0xfedb, 0xfedc]],
  [0x0644, [0xfedd, 0xfede, 0xfedf, 0xfee0]],
  [0x0645, [0xfee1, 0xfee2, 0xfee3, 0xfee4]],
  [0x0646, [0xfee5, 0xfee6, 0xfee7, 0xfee8]],
  [0x0647, [0xfee9, 0xfeea, 0xfeeb, 0xfeec]],
  [0x0648, [0xfeed, 0xfeee, 0, 0]],
  [0x0649, [0xfeef, 0xfef0, 0xfbe8, 0xfbe9]],
  [0x064A, [0xfef1, 0xfef2, 0xfef3, 0xfef4]],
  [0x0671, [0xfb50, 0xfb51, 0, 0]],
  [0x0677, [0xfbdd, 0, 0, 0]],
  [0x0679, [0xfb66, 0xfb67, 0xfb68, 0xfb69]],
  [0x067A, [0xfb5e, 0xfb5f, 0xfb60, 0xfb61]],
  [0x067B, [0xfb52, 0xfb53, 0xfb54, 0xfb55]],
  [0x067E, [0xfb56, 0xfb57, 0xfb58, 0xfb59]],
  [0x067F, [0xfb62, 0xfb63, 0xfb64, 0xfb65]],
  [0x0680, [0xfb5a, 0xfb5b, 0xfb5c, 0xfb5d]],
  [0x0683, [0xfb76, 0xfb77, 0xfb78, 0xfb79]],
  [0x0684, [0xfb72, 0xfb73, 0xfb74, 0xfb75]],
  [0x0686, [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d]],
  [0x0687, [0xfb7e, 0xfb7f, 0xfb80, 0xfb81]],
  [0x0688, [0xfb88, 0xfb89, 0, 0]],
  [0x068C, [0xfb84, 0xfb85, 0, 0]],
  [0x068D, [0xfb82, 0xfb83, 0, 0]],
  [0x068E, [0xfb86, 0xfb87, 0, 0]],
  [0x0691, [0xfb8c, 0xfb8d, 0, 0]],
  [0x0698, [0xfb8a, 0xfb8b, 0, 0]],
  [0x06A4, [0xfb6a, 0xfb6b, 0xfb6c, 0xfb6d]],
  [0x06A6, [0xfb6e, 0xfb6f, 0xfb70, 0xfb71]],
  [0x06A9, [0xfb8e, 0xfb8f, 0xfb90, 0xfb91]],
  [0x06AD, [0xfbd3, 0xfbd4, 0xfbd5, 0xfbd6]],
  [0x06AF, [0xfb92, 0xfb93, 0xfb94, 0xfb95]],
  [0x06B1, [0xfb9a, 0xfb9b, 0xfb9c, 0xfb9d]],
  [0x06B3, [0xfb96, 0xfb97, 0xfb98, 0xfb99]],
  [0x06BA, [0xfb9e, 0xfb9f, 0, 0]],
  [0x06BB, [0xfba0, 0xfba1, 0xfba2, 0xfba3]],
  [0x06BE, [0xfbaa, 0xfbab, 0xfbac, 0xfbad]],
  [0x06C0, [0xfba4, 0xfba5, 0, 0]],
  [0x06C1, [0xfba6, 0xfba7, 0xfba8, 0xfba9]],
  [0x06C5, [0xfbe0, 0xfbe1, 0, 0]],
  [0x06C6, [0xfbd9, 0xfbda, 0, 0]],
  [0x06C7, [0xfbd7, 0xfbd8, 0, 0]],
  [0x06C8, [0xfbdb, 0xfbdc, 0, 0]],
  [0x06C9, [0xfbe2, 0xfbe3, 0, 0]],
  [0x06CB, [0xfbde, 0xfbdf, 0, 0]],
  [0x06CC, [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff]],
  [0x06D0, [0xfbe4, 0xfbe5, 0xfbe6, 0xfbe7]],
  [0x06D2, [0xfbae, 0xfbaf, 0, 0]],
  [0x06D3, [0xfbb0, 0xfbb1, 0, 0]],
]);

// ============================ نموذج الخط ============================
export interface Pt { x: number; y: number; on: boolean }

export interface Face {
  upem: number;
  ascent: number;
  descent: number;
  cmap: Map<number, number>;
  adv: number[];
  loca: number[];
  glyf: Buffer;
  /** إزاحة جدول glyf داخل الملف — إزاحات loca نسبية لبدايته لا لبداية الملف */
  glyfOff: number;
  glyfLen: number;
  nGlyphs: number;
  cache: Map<number, Pt[][]>;
}

/** يقرأ جداول الخط المطلوبة للرسم (بلا HarfBuzz ولا FreeType) */
export function parseFace(font: Buffer): Face {
  const numTables = u16(font, 4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(font.toString('ascii', rec, rec + 4), { off: u32(font, rec + 8), len: u32(font, rec + 12) });
  }
  const T = (tag: string): { off: number; len: number } => {
    const t = tables.get(tag);
    if (!t) throw new Error(`badge: جدول مفقود في الخط المدمج (${tag})`);
    return t;
  };
  const head = T('head').off;
  const hhea = T('hhea').off;
  const upem = u16(font, head + 18);
  const longLoca = s16(font, head + 50) === 1;
  const ascent = s16(font, hhea + 4);
  const descent = s16(font, hhea + 6);
  const nGlyphs = u16(font, T('maxp').off + 4);
  const nAdv = u16(font, hhea + 34);
  const hmtx = T('hmtx').off;
  const adv: number[] = [];
  let last = 0;
  for (let g = 0; g < nGlyphs; g++) {
    if (g < nAdv) last = u16(font, hmtx + g * 4);
    adv.push(last);
  }
  const locaOff = T('loca').off;
  const loca: number[] = [];
  for (let g = 0; g <= nGlyphs; g++) loca.push(longLoca ? u32(font, locaOff + g * 4) : u16(font, locaOff + g * 2) * 2);

  const cmap = new Map<number, number>();
  const cOff = T('cmap').off;
  const nSub = u16(font, cOff + 2);
  for (let i = 0; i < nSub; i++) {
    const rec = cOff + 4 + i * 8;
    const off = cOff + u32(font, rec + 4);
    const fmt = u16(font, off);
    if (fmt === 4) {
      const segX2 = u16(font, off + 6);
      const endOff = off + 14;
      const startOff = endOff + segX2 + 2;
      const deltaOff = startOff + segX2;
      const rangeOff = deltaOff + segX2;
      const segs = segX2 / 2;
      for (let s = 0; s < segs; s++) {
        const end = u16(font, endOff + s * 2);
        const start = u16(font, startOff + s * 2);
        const delta = u16(font, deltaOff + s * 2);
        const ro = u16(font, rangeOff + s * 2);
        if (start > end || end === 0xffff) continue;
        for (let cp = start; cp <= end; cp++) {
          let gid: number;
          if (ro === 0) gid = (cp + delta) & 0xffff;
          else {
            const at = rangeOff + s * 2 + ro + (cp - start) * 2;
            if (at + 1 >= font.length) continue;
            gid = u16(font, at);
            if (gid !== 0) gid = (gid + delta) & 0xffff;
          }
          if (gid !== 0) cmap.set(cp, gid);
        }
      }
    } else if (fmt === 12) {
      const nGroups = u32(font, off + 12);
      for (let g = 0; g < nGroups; g++) {
        const r = off + 16 + g * 12;
        const start = u32(font, r);
        const end = u32(font, r + 4);
        const gid0 = u32(font, r + 8);
        if (end - start > 0x10000) continue;
        for (let cp = start; cp <= end; cp++) {
          const gid = gid0 + (cp - start);
          if (!cmap.has(cp)) cmap.set(cp, gid);
        }
      }
    }
  }
  const g = T('glyf');
  return { upem, ascent, descent, cmap, adv, loca, glyf: font, glyfOff: g.off, glyfLen: g.len, nGlyphs, cache: new Map() };
}

/** يستخرج كنتورات المحرف (يتابع المركّبات حتى 5 مستويات) */
export function glyphContours(face: Face, gid: number, depth = 0): Pt[][] {
  if (gid < 0 || gid >= face.nGlyphs) return [];
  const hit = face.cache.get(gid);
  if (hit) return hit;
  const start = face.loca[gid];
  const end = face.loca[gid + 1];
  if (end <= start || start < 0 || end > face.glyfLen) {
    face.cache.set(gid, []);
    return [];
  }
  const o = face.glyfOff + start;
  const nCont = s16(face.glyf, o);
  if (nCont > 400) {
    face.cache.set(gid, []);
    return [];
  }
  const out: Pt[][] = [];
  if (nCont >= 0 && depth <= 5) {
    let p = o + 10;
    const ends: number[] = [];
    for (let i = 0; i < nCont; i++) { ends.push(u16(face.glyf, p)); p += 2; }
    const nPts = nCont ? ends[nCont - 1] + 1 : 0;
    if (nPts > 4000) {
      face.cache.set(gid, []);
      return [];
    }
    const instrLen = u16(face.glyf, p);
    p += 2 + instrLen;
    const flags: number[] = [];
    while (flags.length < nPts) {
      const f = u8(face.glyf, p++);
      flags.push(f);
      if (f & 8) { let r = u8(face.glyf, p++); while (r-- > 0 && flags.length < nPts) flags.push(f); }
    }
    const xs: number[] = [];
    let x = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 2) { const d = u8(face.glyf, p++); x += f & 16 ? d : -d; }
      else if (!(f & 16)) { x += s16(face.glyf, p); p += 2; }
      xs.push(x);
    }
    const ys: number[] = [];
    let y = 0;
    for (let i = 0; i < nPts; i++) {
      const f = flags[i];
      if (f & 4) { const d = u8(face.glyf, p++); y += f & 32 ? d : -d; }
      else if (!(f & 32)) { y += s16(face.glyf, p); p += 2; }
      ys.push(y);
    }
    let c0 = 0;
    for (const e of ends) {
      const contour: Pt[] = [];
      for (let i = c0; i <= e; i++) contour.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
      if (contour.length) out.push(contour);
      c0 = e + 1;
    }
  } else if (depth <= 5) {
    // مركّب: مكوّنات بإزاحة/تحويل
    let p = o + 10;
    for (;;) {
      const flags = u16(face.glyf, p);
      const sub = u16(face.glyf, p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (flags & 1) { dx = s16(face.glyf, p); dy = s16(face.glyf, p + 2); p += 4; }
      else { dx = (u8(face.glyf, p) << 24 >> 24); dy = (u8(face.glyf, p + 1) << 24 >> 24); p += 2; }
      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 8) { a = d = s16(face.glyf, p) / 16384; p += 2; }
      else if (flags & 64) { a = s16(face.glyf, p) / 16384; d = s16(face.glyf, p + 2) / 16384; p += 4; }
      else if (flags & 128) { a = s16(face.glyf, p) / 16384; b = s16(face.glyf, p + 2) / 16384; c = s16(face.glyf, p + 4) / 16384; d = s16(face.glyf, p + 6) / 16384; p += 8; }
      for (const cont of glyphContours(face, sub, depth + 1)) {
        out.push(cont.map((pt) => ({ x: pt.x * a + pt.y * c + dx, y: pt.x * b + pt.y * d + dy, on: pt.on })));
      }
      if (!(flags & 32)) break;
    }
  }
  face.cache.set(gid, out);
  return out;
}

// ============================ تشكيل عربي ============================
const ALEF_LAM = new Set([0x0622, 0x0623, 0x0625, 0x0627]);
/** حروف متصلة من اليمين فقط (لا توصل بما بعدها) */
const JOIN_R = new Set([0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0671]);
/** موصِلة بلا شكل خاص: التطويل و ZWJ */
const JOIN_C = new Set([0x0640, 0x200d]);
const MARKS = (cp: number): boolean => (cp >= 0x064b && cp <= 0x0655) || cp === 0x0670 || cp === 0x06d6;

const isArabic = (cp: number): boolean => PRESENT.has(cp) || JOIN_R.has(cp) || JOIN_C.has(cp);
const jClass = (cp: number): 'D' | 'R' | 'C' | 'U' =>
  JOIN_R.has(cp) ? 'R' : JOIN_C.has(cp) ? 'C' : PRESENT.has(cp) ? 'D' : 'U';

export interface ShapedGlyph { gid: number; adv: number; cp: number }

/** تشكيل سطر واحد: يحوّل الحروف إلى محارف أشكال العرض ويصل «لا» */
export function shapeRun(face: Face, text: string): ShapedGlyph[] {
  const cps = Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
  const out: ShapedGlyph[] = [];
  const push = (cp: number): void => {
    const gid = face.cmap.get(cp) ?? 0;
    out.push({ gid, adv: face.adv[gid] ?? 0, cp });
  };
  // الحرف التالي المؤثر في الانضمام (يتخطى العلامات، ويتوقف عند فاصل)
  const nextJoin = (from: number): { cp: number; index: number } | null => {
    for (let i = from; i < cps.length; i++) {
      const c = cps[i];
      if (MARKS(c)) continue;
      if (c === 0x200d) return { cp: c, index: i };
      if (isArabic(c)) return { cp: c, index: i };
      return null;
    }
    return null;
  };
  let prevJoinable = false;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];
    if (MARKS(cp)) continue; // العلامات (تشكيل) تُهمل في الملصق
    if (cp === 0x200c) { prevJoinable = false; continue; } // ZWNJ يكسر الوصل ولا يُرسم
    if (cp === 0x200d) { prevJoinable = true; continue; } // ZWJ يواصل الوصل ولا يُرسم
    if (!isArabic(cp)) { prevJoinable = false; push(cp); continue; }
    if (cp === 0x0644) {
      const nxt = nextJoin(i + 1);
      if (nxt && ALEF_LAM.has(nxt.cp)) {
        push(prevJoinable ? 0xfefc : 0xfefb); // «لا» النهائية أو المعزولة
        i = nxt.index;
        prevJoinable = false; // الألف لا توصل بما بعدها
        continue;
      }
    }
    const nxt = nextJoin(i + 1);
    const prevLink = prevJoinable && jClass(cp) !== 'U';
    const nextLink = nxt !== null
      && (jClass(cp) === 'D' || jClass(cp) === 'C')
      && (jClass(nxt.cp) === 'D' || jClass(nxt.cp) === 'R' || jClass(nxt.cp) === 'C');
    const form = prevLink ? (nextLink ? 'medial' : 'final') : nextLink ? 'initial' : 'isolated';
    const pr = PRESENT.get(cp);
    const byForm = pr ? (form === 'isolated' ? pr[0] : form === 'final' ? pr[1] : form === 'initial' ? pr[2] : pr[3]) : 0;
    push(byForm || cp);
    prevJoinable = jClass(cp) === 'D' || jClass(cp) === 'C';
  }
  return out;
}

/** محارف خط الملصق المفقودة من نص (فحص تغطية — يُستخدم في الفحوصات) */
export function missingGlyphs(text: string, face: Face = fontFace()): string[] {
  const miss: string[] = [];
  for (const g of shapeRun(face, text)) if (g.gid === 0 && g.cp !== 0x000a) miss.push(`U+${g.cp.toString(16).toUpperCase().padStart(4, '0')}`);
  return miss;
}

// ============================ ترتيب ثنائي الاتجاه مبسّط ============================
const RTL_RANGES: Array<[number, number]> = [[0x0590, 0x05ff], [0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb1d, 0xfdff], [0xfe70, 0xfeff]];
const isRtl = (cp: number): boolean => RTL_RANGES.some(([a, b]) => cp >= a && cp <= b);
const isLtr = (cp: number): boolean => (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x25 || cp === 0x2f || cp === 0x2e || cp === 0x2c;

export interface BiItem { dir: 'rtl' | 'ltr'; text: string }

/** يقسم السطر إلى مقاطع اتجاهية: المحايد يأخذ اتجاه المحيط عند اتفاق الجانبين (UBA مبسّطة) */
export function visualItems(text: string): { items: BiItem[]; base: 'rtl' | 'ltr' } {
  const cps = Array.from(text, (ch) => ch.codePointAt(0) ?? 0);
  const cls = cps.map((cp): 'rtl' | 'ltr' | 'neutral' => (isRtl(cp) ? 'rtl' : isLtr(cp) ? 'ltr' : 'neutral'));
  let base: 'rtl' | 'ltr' | null = null;
  for (const c of cls) if (c !== 'neutral') { base = c; break; }
  const resolved = cls.map((c, i) => {
    if (c !== 'neutral') return c;
    let prev: 'rtl' | 'ltr' | null = null;
    let next: 'rtl' | 'ltr' | null = null;
    for (let j = i - 1; j >= 0; j--) if (cls[j] !== 'neutral') { prev = cls[j] as 'rtl' | 'ltr'; break; }
    for (let j = i + 1; j < cls.length; j++) if (cls[j] !== 'neutral') { next = cls[j] as 'rtl' | 'ltr'; break; }
    if (prev && prev === next) return prev; // بين عربي وعربي أو لاتيني ولاتيني
    return base ?? 'rtl'; // حاشية السطر أو بين اتجاهين ⇒ اتجاه السطر
  });
  const items: BiItem[] = [];
  let cur: BiItem | null = null;
  for (let i = 0; i < cps.length; i++) {
    const dir = resolved[i] as 'rtl' | 'ltr';
    if (!cur || cur.dir !== dir) {
      cur = { dir, text: '' };
      items.push(cur);
    }
    cur.text += String.fromCodePoint(cps[i]);
  }
  return { items, base: base ?? 'rtl' };
}

// ============================ اللوحة والتدرّج الحَدّي ============================
interface Color { r: number; g: number; b: number }
const hex = (c: string): Color => {
  const s = c.replace('#', '');
  const v = s.length === 3 ? s.split('').map((x) => x + x).join('') : s;
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
};

export interface Canvas { w: number; h: number; px: Uint8ClampedArray }

function newCanvas(w: number, h: number, bg: string): Canvas {
  const c: Canvas = { w, h, px: new Uint8ClampedArray(w * h * 4) };
  const col = hex(bg);
  for (let i = 0; i < w * h; i++) {
    c.px[i * 4] = col.r;
    c.px[i * 4 + 1] = col.g;
    c.px[i * 4 + 2] = col.b;
    c.px[i * 4 + 3] = 255;
  }
  return c;
}

/** بلِند بقعة ألفا (0..1) بلون على اللوحة */
function blend(c: Canvas, x: number, y: number, col: Color, a: number): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 4;
  const k = a > 1 ? 1 : a;
  c.px[i] = c.px[i] + (col.r - c.px[i]) * k;
  c.px[i + 1] = c.px[i + 1] + (col.g - c.px[i + 1]) * k;
  c.px[i + 2] = c.px[i + 2] + (col.b - c.px[i + 2]) * k;
}

/** مستطيل بزوايا دائرية */
function roundRect(c: Canvas, x: number, y: number, w: number, h: number, rad: number, color: string): void {
  const col = hex(color);
  const r = Math.max(0, Math.min(rad, Math.min(w, h) / 2));
  for (let py = Math.floor(y); py < Math.ceil(y + h); py++) {
    for (let pxx = Math.floor(x); pxx < Math.ceil(x + w); pxx++) {
      const inside =
        (pxx >= x + r && pxx < x + w - r) || (py >= y + r && py < y + h - r) ||
        Math.hypot(Math.max(x + r - pxx, pxx - (x + w - r), 0), Math.max(y + r - py, py - (y + h - r), 0)) <= r;
      if (inside) blend(c, pxx, py, col, 1);
    }
  }
}

/** يملأ مضلعات (مساحة بكسل) بتغطية تراكمية في مخزن محلي — التدرّج الحَدّي من 4 صفوف فرعية/بكسل */
function fillPolys(polys: number[][], cov: Float32Array, bw: number, bh: number, ox: number, oy: number, ss = 4): void {
  interface Edge { y0: number; y1: number; x0: number; dx: number; dir: number }
  const edges: Edge[] = [];
  for (const poly of polys) {
    const n = poly.length / 2; // أزواج x,y
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = poly[i * 2], y0 = poly[i * 2 + 1];
      const x1 = poly[j * 2], y1 = poly[j * 2 + 1];
      if (y0 === y1) continue;
      const top = Math.min(y0, y1), bot = Math.max(y0, y1);
      edges.push({ y0: top, y1: bot, x0: y1 < y0 ? x1 : x0, dx: (x0 - x1) / (y0 - y1), dir: y0 < y1 ? 1 : -1 });
    }
  }
  if (!edges.length) return;
  const inv = 1 / ss;
  for (let row = 0; row < bh * ss; row++) {
    const y = oy + (row + 0.5) * inv;
    const xs: Array<{ x: number; dir: number }> = [];
    for (const e of edges) {
      if (y >= e.y0 && y < e.y1) xs.push({ x: e.x0 + (y - e.y0) * e.dx, dir: e.dir });
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p.x - q.x);
    let wind = 0;
    const py = Math.floor(row / ss);
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].dir;
      if (wind === 0) continue;
      const xa = Math.max(xs[i].x, ox);
      const xb = Math.min(xs[i + 1].x, ox + bw);
      const ia = Math.max(0, Math.floor(xa - ox));
      const ib = Math.min(bw - 1, Math.ceil(xb - ox) - 1);
      for (let i2 = ia; i2 <= ib; i2++) {
        const ov = Math.min(xb, ox + i2 + 1) - Math.max(xa, ox + i2);
        if (ov > 0) cov[py * bw + i2] += ov * inv;
      }
    }
  }
}

/** يرسم محرفاً واحداً بأصل الرسم (pen) وخط القاعدة */
function drawGlyph(c: Canvas, face: Face, gid: number, penX: number, baseY: number, size: number, color: string): number {
  const adv = (face.adv[gid] ?? 0) * (size / face.upem);
  const contours = glyphContours(face, gid);
  if (!contours.length) return adv;
  const scale = size / face.upem;
  const polys: number[][] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cont of contours) {
    const flat = flattenContour(cont, scale, penX, baseY);
    if (flat.length < 6) continue;
    polys.push(flat);
    for (let i = 0; i < flat.length; i += 2) {
      if (flat[i] < minX) minX = flat[i];
      if (flat[i] > maxX) maxX = flat[i];
      if (flat[i + 1] < minY) minY = flat[i + 1];
      if (flat[i + 1] > maxY) maxY = flat[i + 1];
    }
  }
  if (!polys.length) return adv;
  const ox = Math.max(0, Math.floor(minX) - 1);
  const oy = Math.max(0, Math.floor(minY) - 1);
  const bw = Math.min(c.w, Math.ceil(maxX) + 1) - ox;
  const bh = Math.min(c.h, Math.ceil(maxY) + 1) - oy;
  if (bw <= 0 || bh <= 0) return adv;
  const cov = new Float32Array(bw * bh);
  fillPolys(polys, cov, bw, bh, ox, oy);
  const col = hex(color);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const a = cov[y * bw + x];
      if (a > 0.002) blend(c, ox + x, oy + y, col, a > 1 ? 1 : a);
    }
  }
  return adv;
}

/** يحوّل كنتوراً (خطوط + بيزيه تربيعية) إلى مضلع بكسل، y مقلوبة (الخط يرسم صاعداً) */
function flattenContour(cont: Pt[], scale: number, penX: number, baseY: number): number[] {
  const pts = cont.length === 1 ? [cont[0], cont[0]] : cont;
  const start = pts.findIndex((p) => p.on);
  const list: Pt[] = start >= 0 ? pts.slice(start).concat(pts.slice(0, start)) : [
    { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2, on: true },
    ...pts,
  ];
  const X = (p: Pt): number => penX + p.x * scale;
  const Y = (p: Pt): number => baseY - p.y * scale;
  const flat: number[] = [X(list[0]), Y(list[0])];
  const L = list.length;
  let k = 1;
  let guard = 0;
  while (k <= L && guard++ < 4096) {
    const p = list[k % L];
    if (p.on) {
      flat.push(X(p), Y(p));
      k++;
    } else {
      const q = list[(k + 1) % L];
      if (q.on || (k + 1) % L === 0) {
        quad(flat, X(list[(k - 1 + L) % L]), Y(list[(k - 1 + L) % L]), X(p), Y(p), X(q), Y(q));
        k += 2;
      } else {
        const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
        quad(flat, X(list[(k - 1 + L) % L]), Y(list[(k - 1 + L) % L]), X(p), Y(p), penX + mx * scale, baseY - my * scale);
        k++;
      }
    }
    if (k > L) break;
  }
  return flat;
}

/** يضيف منحنى تربيعياً مقسّماً بعدد خطوات متناسب مع الطول */
function quad(out: number[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): void {
  const len = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
  const n = Math.max(2, Math.min(16, Math.ceil(len / 3)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    out.push(mt * mt * x0 + 2 * mt * t * cx + t * t * x1, mt * mt * y0 + 2 * mt * t * cy + t * t * y1);
  }
}

// ============================ قياس ورسم النصوص ============================
let faceCache: Face | null = null;
/** الخط المدمج (يُقرأ مرة واحدة) */
export function fontFace(): Face {
  if (!faceCache) faceCache = parseFace(Buffer.from(BADGE_FONT_B64, 'base64'));
  return faceCache;
}

/** ارتفاع صندوق السطر لقياس خط معيّن */
export function lineBoxHeight(size: number): number {
  const f = fontFace();
  return ((f.ascent - f.descent) / f.upem) * size;
}

/** عرض نص بقياس معيّن (بالبكسل) */
export function textWidth(text: string, size: number, face: Face = fontFace()): number {
  const total = shapeRun(face, text).reduce((s, g) => s + g.adv, 0);
  return (total / face.upem) * size;
}

/** يرسم سطر نص اتجاهي عند صندوق [left, right] */
function drawLine(c: Canvas, text: string, size: number, color: string, top: number, left: number, right: number, align: 'right' | 'left' | 'center'): void {
  const face = fontFace();
  const baseY = top + (face.ascent / face.upem) * size;
  const { items, base } = visualItems(text);
  const drawn = items.map((it) => ({ ...it, glyphs: shapeRun(face, it.text) }));
  const widths = drawn.map((it) => (it.glyphs.reduce((s, g) => s + g.adv, 0) / face.upem) * size);
  const total = widths.reduce((s, w) => s + w, 0);
  // قاعدة السطر rtl ⇒ تُرسم المقاطع بترتيب معكوس لتقع أولى المقاطع المنطقية في أقصى اليمين
  const order = base === 'rtl' ? drawn.slice().reverse() : drawn;
  let x = align === 'right' ? right - total : align === 'left' ? left : left + (right - left - total) / 2;
  for (const it of order) {
    const w = (it.glyphs.reduce((s, g) => s + g.adv, 0) / face.upem) * size;
    let pen = it.dir === 'rtl' ? x + w : x;
    for (const g of it.glyphs) {
      if (it.dir === 'rtl') {
        pen -= (g.adv / face.upem) * size;
        drawGlyph(c, face, g.gid, pen, baseY, size, color);
      } else {
        pen += drawGlyph(c, face, g.gid, pen, baseY, size, color);
      }
    }
    x += w;
  }
}

// ============================ مُرمِّز PNG ============================
let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** يرمّز RGBA8 إلى PNG (بلا فلترة — الضغط على zlib) */
export function encodePng(w: number, h: number, rgba: Uint8ClampedArray | Buffer): Buffer {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  const src = rgba instanceof Buffer ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    src.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // عمق 8 بت
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================ الواجهة العامة ============================
export interface BadgeLine {
  text: string;
  size: number;
  color: string;
  /** أعلى صندوق السطر (بالكامل أعلى الفراغ البيني) */
  top: number;
  align?: 'right' | 'left' | 'center';
}

export interface BadgeSpec {
  width: number;
  height: number;
  bg: string;
  /** لون شريط الحالة الجانبي (يمين الصورة في RTL) */
  accent?: string;
  /** خلفية داخلية بزوايا دائرية */
  panel?: string;
  radius?: number;
  /** شعار المشروع: مربع ملوّن بحرف/حرفين (بلا أي ملفات خارجية) — size/top/left اختيارية للمقاسات الكبيرة */
  logo?: { text: string; bg: string; fg: string; size?: number; top?: number; left?: number };
  lines: BadgeLine[];
}

/** يرسم ملصقاً كاملاً ويعيد بايتات PNG */
export function badgePng(spec: BadgeSpec): Buffer {
  const c = newCanvas(spec.width, spec.height, spec.bg);
  const pad = 8;
  if (spec.panel) roundRect(c, pad, pad, spec.width - pad * 2, spec.height - pad * 2, spec.radius ?? 18, spec.panel);
  if (spec.accent) {
    const w = 10;
    const x = spec.width - pad - 14;
    roundRect(c, x, pad + 14, w, spec.height - pad * 2 - 28, w / 2, spec.accent);
  }
  if (spec.logo && spec.logo.text.trim()) {
    const size = spec.logo.size ?? 64;
    const x = spec.logo.left ?? pad + 16;
    const y = spec.logo.top ?? Math.round((spec.height - size) / 2);
    roundRect(c, x, y, size, size, Math.round(size * 0.25), spec.logo.bg);
    const fs = spec.logo.text.trim().length > 1 ? Math.round(size * 0.4) : Math.round(size * 0.53);
    const top = y + Math.round((size - lineBoxHeight(fs)) / 2);
    drawLine(c, spec.logo.text.trim().slice(0, 2), fs, spec.logo.fg, top, x, x + size, 'center');
  }
  const margin = 34;
  for (const l of spec.lines) {
    drawLine(c, l.text, l.size, l.color, l.top, margin, spec.width - margin, l.align ?? 'right');
  }
  return encodePng(spec.width, spec.height, c.px);
}

/** ألوان الحالة الموحّدة مع شارة الويب (share.ts) */
export function badgeColor(score: number): string {
  return score >= 80 ? '#22c55e' : score >= 60 ? '#f59e0b' : '#ef4444';
}
