// إرفاق الصور في الواجهة: لصق من الحافظة، إسقاط ملفات، أو اختيار من القرص.
// نضغط الصور في المتصفح (canvas) قبل الإرسال حتى لا نستهلك السياق والنطاق:
// حدّ أقصى 1600 بكسل، ولقطات الشاشة تبقى PNG (نص حاد) والباقي JPEG مضغوط.
import { $, clear, h } from './util';
import { icon } from './icons';
import { S } from './state';

export const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
/** إن تجاوز PNG هذا الحجم نحوّل إلى JPEG */
const PNG_KEEP_LIMIT = 1_200_000;

interface Pending {
  dataUrl: string;
  name: string;
}

let pending: Pending[] = [];

const strip = $<HTMLDivElement>('attach-strip');
const input = $<HTMLTextAreaElement>('input');
const composer = $<HTMLDivElement>('composer');

export function pendingImages(): string[] {
  return pending.map((p) => p.dataUrl);
}

export function clearPendingImages(): void {
  pending = [];
  renderStrip();
}

/** يقرأ ملفاً ويضغطه إلى data URL مناسب للإرسال */
export async function fileToDataUrl(file: File): Promise<Pending | null> {
  if (!file.type.startsWith('image/')) return null;
  const raw = await new Promise<string | null>((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(file);
  });
  if (!raw) return null;
  try {
    const img = await loadImage(raw);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
    if (scale === 1 && raw.length <= PNG_KEEP_LIMIT) return { dataUrl: raw, name: file.name || 'صورة' };
    const w = Math.max(1, Math.round(img.width * scale));
    const hh = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hh;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: raw, name: file.name || 'صورة' };
    ctx.drawImage(img, 0, 0, w, hh);
    // لقطات الشاشة: PNG يحافظ على حِدّة النص؛ الصور الفوتوغرافية: JPEG أصغر بكثير
    let out = canvas.toDataURL('image/png');
    if (out.length > PNG_KEEP_LIMIT) out = canvas.toDataURL('image/jpeg', 0.85);
    return { dataUrl: out, name: file.name || 'صورة' };
  } catch {
    return null;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function addPending(item: Pending): void {
  if (pending.length >= MAX_IMAGES) {
    notify(`الحدّ ${MAX_IMAGES} صور في الرسالة الواحدة.`);
    return;
  }
  pending.push(item);
  renderStrip();
}

let noticeEl: HTMLElement | null = null;

/** إشعار صغير أسفل صفّ الصور (لا نستدعي واجهة المحادثة لتجنّب الاستيراد الدائري) */
function notify(text: string): void {
  if (!noticeEl) {
    noticeEl = h('div', { class: 'attach-note' });
    strip.append(noticeEl);
    setTimeout(() => {
      noticeEl?.remove();
      noticeEl = null;
    }, 4000);
  }
  noticeEl.textContent = text;
}

function renderStrip(): void {
  clear(strip);
  if (!pending.length) {
    strip.hidden = true;
    return;
  }
  strip.hidden = false;
  pending.forEach((p, i) => {
    const chip = h('div', { class: 'attach-chip' }, h('img', { attrs: { src: p.dataUrl, alt: p.name } }));
    const rm = h('button', {
      class: 'x',
      attrs: { type: 'button', title: 'إزالة' },
      on: {
        click: () => {
          pending.splice(i, 1);
          renderStrip();
        },
      },
    }, icon('x', 11));
    chip.append(rm);
    strip.append(chip);
  });
  void S;
}

async function addFiles(files: FileList | File[]): Promise<void> {
  for (const f of Array.from(files)) {
    if (pending.length >= MAX_IMAGES) break;
    const item = await fileToDataUrl(f);
    if (item) addPending(item);
  }
}

export function initAttach(): void {
  // لصق صورة من الحافظة (لقطة شاشة مثلاً)
  input.addEventListener('paste', (ev) => {
    const dt = ev.clipboardData;
    if (!dt) return;
    const files = [...dt.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    ev.preventDefault(); // لا نُدخل اسم الملف كنص
    void addFiles(files);
  });

  // إسقاط ملفات على صندوق الكتابة
  const stop = (ev: DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  composer.addEventListener('dragover', (ev) => {
    stop(ev);
    composer.classList.add('dropping');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('dropping'));
  composer.addEventListener('drop', (ev) => {
    stop(ev);
    composer.classList.remove('dropping');
    const files = ev.dataTransfer?.files;
    if (files?.length) void addFiles(files);
  });

  // زرّ الإرفاق
  const picker = $<HTMLInputElement>('attach-input');
  $('attach-btn').addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => {
    if (picker.files?.length) void addFiles(picker.files);
    picker.value = '';
  });
}
