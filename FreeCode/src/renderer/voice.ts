// الإدخال الصوتي: زر مِيكروفون في المحرر يستخدم التعرف على الكلام المدمج في المتصفح
// (Web Speech API). ليس كل بناء من Chromium يملك خدمة التعرف، لذلك نفشل بلطف ونشرح البديل.
import { $ } from './util';
import { addNotice } from './chat';

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
}

function ctor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function initVoice(): void {
  const btn = $<HTMLButtonElement>('voice-btn');
  const input = $<HTMLTextAreaElement>('input');
  if (!btn || !input) return;

  const Ctor = ctor();
  if (!Ctor) {
    btn.title = 'الإدخال الصوتي غير مدعوم في هذا البناء — اكتب نصاً أو استخدم إملاء نظام التشغيل';
    btn.addEventListener('click', () => addNotice('التعرف على الكلام غير متاح في هذا البناء من التطبيق. استخدم إملاء نظام التشغيل (غالباً Win+H أو F5)، أو اكتب نصاً.', 'err'));
    return;
  }

  let rec: SpeechRecognitionLike | null = null;
  let listening = false;
  const base = input.value;

  const stop = () => {
    listening = false;
    btn.classList.remove('on');
    btn.title = 'إدخال صوتي (عربي)';
    try {
      rec?.stop();
    } catch {
      /* تجاهل */
    }
    rec = null;
  };

  btn.addEventListener('click', () => {
    if (listening) {
      stop();
      return;
    }
    const r = new Ctor();
    rec = r;
    r.lang = 'ar-SA';
    r.continuous = true;
    r.interimResults = true;
    let finalText = '';
    r.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      input.value = `${base}${base && (finalText || interim) ? ' ' : ''}${finalText}${interim}`;
      input.dispatchEvent(new Event('input'));
    };
    r.onerror = (e: any) => {
      const code = String(e?.error ?? '');
      const msg =
        code === 'not-allowed' || code === 'service-not-allowed'
          ? 'رُفض إذن المِيكروفون، أو خدمة التعرف غير متوفرة في هذا البناء.'
          : code === 'no-speech'
            ? 'لم أسمع كلاماً — أعد المحاولة.'
            : `تعذّر التعرف على الكلام (${code || 'خطأ'}).`;
      addNotice(msg, 'err');
      stop();
    };
    r.onend = () => stop();
    try {
      r.start();
      listening = true;
      btn.classList.add('on');
      btn.title = 'أوقف الإدخال الصوتي';
    } catch (e: any) {
      addNotice(`تعذّر بدء الإدخال الصوتي: ${String(e?.message ?? e)}`, 'err');
      stop();
    }
  });
}
