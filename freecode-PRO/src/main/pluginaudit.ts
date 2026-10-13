// مراجعة دلالية للإضافة بموديل ثانٍ: الهدف أن يُشرح *ما تفعله الإضافة فعلاً*
// قبل تثبيتها — لا مجرد عدّ ملفات وأوامر.
//
// مبادئ:
//   • نُرسل **نصّاً محدوداً** من ملفات الإضافة (مانيفست + أوامر hooks + مقتطفات
//     المهارات) بلا تنفيذ أي شيء، وبسقف صريح للحجم.
//   • لا نُرسل أي شيء من مشروع المستخدم: مجلد الإضافة المؤقت فقط.
//   • رأي الموديل **معلومات إضافية لا إذن**: التثبيت يبقى بقرار المستخدم، وفشل
//     المراجعة الذكية لا يمنع التثبيت — يُذكر كنقص في المعلومات.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { streamChat, type ChatMessage, type LLMConfig } from './llm';

export interface AuditBundle {
  text: string;
  files: number;
  chars: number;
  truncated: boolean;
}

const AUDIT_SYSTEM = `أنت مراجع أمني لإضافات محرّرات الأكواد. ستصلك محتويات إضافة (مانيفست + أوامر hooks + قواعد صلاحيات + مقتطفات مهارات).
مهمتك أن تشرح للمستخدم العربي، بإيجاز ودقة:
1. ما تفعله هذه الإضافة فعلاً في جملتين.
2. هل تطلب صلاحيات أوسع مما تحتاجه وظيفتها؟ أين بالضبط؟
3. أي سلوك خفي أو مريب: أوامر تُنفَّذ تلقائياً، ملفات تُقرأ/تُرفع، اتصال شبكي، تعديل إعدادات، تعطيل فحوص.
4. الحكم النهائي في سطر واحد: «آمنة للتجربة» أو «تحتاج مراجعة يدوية» أو «لا تثبّتها» مع السبب.
قواعد: لا تخمّن ما ليس في النص. إن كان النص ناقصاً أو مقتطعاً فاذكر ذلك وأثّره على حكمك. لا تكتب كوداً، ولا تطلب معلومات. أجب بماركداون عربي، بلا مقدمات.`;

/** يجمع نصّاً محدوداً من ملفات الإضافة للمراجعة (بلا أي تنفيذ) */
export async function collectAuditBundle(stagingDir: string, opts: { maxChars?: number; maxSkillChars?: number; maxFiles?: number } = {}): Promise<AuditBundle> {
  const maxChars = opts.maxChars ?? 24_000;
  const maxSkillChars = opts.maxSkillChars ?? 3_000;
  const maxFiles = opts.maxFiles ?? 40;
  const parts: string[] = [];
  let chars = 0;
  let files = 0;
  let truncated = false;

  const add = (title: string, body: string): void => {
    if (chars >= maxChars) {
      truncated = true;
      return;
    }
    const room = maxChars - chars;
    const text = body.length > room ? body.slice(0, room) + '\n…[اقتُطع]' : body;
    if (body.length > room) truncated = true;
    parts.push(`\n### ${title}\n${text}`);
    chars += text.length;
  };

  const readIf = async (rel: string, cap: number): Promise<string> => {
    try {
      const t = await fs.readFile(path.join(stagingDir, rel), 'utf8');
      return t.length > cap ? t.slice(0, cap) + '\n…[اقتُطع]' : t;
    } catch {
      return '';
    }
  };

  add('plugin.json', await readIf('plugin.json', 4_000));

  // أوامر hooks وملفاتها
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stagingDir, 'plugin.json'), 'utf8'));
    const hooks = raw?.hooks ?? {};
    for (const phase of ['PreToolUse', 'PostToolUse']) {
      const list = Array.isArray(hooks[phase]) ? hooks[phase] : [];
      for (const h of list.slice(0, 10)) {
        if (!h || typeof h.command !== 'string') continue;
        add(`hook ${phase} (matcher: ${String(h.matcher ?? '*')})`, `$ ${h.command}`);
        // نص السكربت المشار إليه إن كان ملفاً داخل الإضافة
        const m = /([\w./-]+\.(?:js|cjs|mjs|sh|py|ts))/.exec(h.command);
        if (m) add(`سكربت الـ hook: ${m[1]}`, await readIf(m[1].replace(/^\.\//, ''), 2_500));
      }
    }
  } catch {
    /* المانيفست تالف — المراجعة النصية تكفي */
  }

  // المهارات: مقتطفات (أول ما يقرؤه الموديل عادة)
  const walk = async (dir: string, depth = 0): Promise<void> => {
    if (depth > 3 || files >= maxFiles || chars >= maxChars) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.slice(0, 60)) {
      if (files >= maxFiles || chars >= maxChars) {
        truncated = true;
        return;
      }
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(stagingDir, p);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.(md|json|ya?ml|txt)$/i.test(e.name)) {
        files++;
        add(rel, await readIf(rel, maxSkillChars));
      } else if (/\.(js|cjs|mjs|ts|sh|py)$/i.test(e.name) && /hooks?\//.test(rel)) {
        files++;
        add(rel, await readIf(rel, 2_000));
      }
    }
  };
  await walk(stagingDir);

  parts.push('\n### ملاحظة منهجية\nالمحتوى أعلاه نصّي فقط ولم يُنفَّذ شيء منه. الحكم المطلوب مبني على ما هو مذكور حرفياً.');
  return { text: parts.join('\n'), files, chars: parts.join('\n').length, truncated };
}

export interface AuditResult {
  ok: boolean;
  text: string;
  error?: string;
  ms: number;
}

/** المراجعة الذكية: نموذج ثانٍ يشرح الإضافة (بلا أدوات، بلا تنفيذ) */
export async function semanticAudit(cfg: LLMConfig, bundle: AuditBundle, signal?: AbortSignal): Promise<AuditResult> {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: AUDIT_SYSTEM },
    { role: 'user', content: `هذه محتويات الإضافة للمراجعة (${bundle.files} ملفاً نصياً${bundle.truncated ? '، مقتطعة عبر سقف الحجم' : ''}):\n${bundle.text}` },
  ];
  try {
    const res = await streamChat(cfg, messages, [], signal, () => {}, { maxAttempts: 2 });
    const text = String(res.content ?? '').trim();
    if (!text) return { ok: false, text: '', error: 'أعاد الموديل نصاً فارغاً', ms: Date.now() - started };
    return { ok: true, text, ms: Date.now() - started };
  } catch (e: any) {
    return { ok: false, text: '', error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - started };
  }
}

/** قسم عربي يُلحق بتقرير المراجعة */
export function formatAuditSection(res: AuditResult, model: string): string {
  if (!res.ok) {
    return [
      '#### المراجعة الذكية (نموذج ثانٍ)',
      '',
      `تعذّرت المراجعة الذكية: ${res.error ?? 'سبب غير معروف'} — وهذا لا يمنع التثبيت، لكنه يعني أنك تعتمد على الفحص الآلي وحدك.`,
    ].join('\n');
  }
  return ['#### المراجعة الذكية (نموذج ثانٍ)', '', `_الموديل: ${model} · ${(res.ms / 1000).toFixed(1)}ث_`, '', res.text].join('\n');
}


// ======================= المراجعة بموديلين متقاطعَين =======================
// الفكرة: حكم واحد من موديل واحد قابل للخطأ والهلس. موديلان مستقلان على **نفس النص**،
// ثم:
//   • الإشارات «المشتركة» = ما ذكره الاثنان ⇒ ثقة أعلى (تقاطع الظهور).
//   • ما ذكره أحدهما فقط = إشارة تحتاج نظراً، لا تُهمل.
//   • الحكم: **الأشد تحفظاً يفوز** (reject > manual > safe) — لا تصويت أغلبية.
// هذا تقطير معجمي صريح من النص الحر (لا مصنّف)، ويُعرض دائماً ليُراجعه المستخدم.

/** معجم الإشارات: مفتاح + وصف + نمط يُبحَث به في نص المراجعة */
export const AUDIT_SIGNALS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: 'network', label: 'اتصال/إرسال شبكي خارجي', re: /(شبك|خارجي|إرسال|رفع|تسريب|https?:\/\/|curl|wget|collect\.example)/i },
  { key: 'secrets', label: 'أسرار/مفاتيح/متغيرات بيئة', re: /(سر|مفتاح|توكن|رمز|كلمة مرور|SECRET|TOKEN|API_KEY|\.env)/i },
  { key: 'exec', label: 'تنفيذ أوامر أو سكربتات تلقائياً', re: /(تنفيذ|سكربت|أوامر تُنفَّذ|shell|bash|hook|hooks\/|صلاحية أمر)/i },
  { key: 'delete', label: 'حذف/تدمير/كتابة خطِرة', re: /\b(حذف|يمسح|مسح|تدمير|rm\s+-|rmdir|force)/i },
  { key: 'widePerm', label: 'صلاحيات أوسع من الحاجة', re: /(أوسع من|واسع|بلا سؤال|allow|تلقائي بالكامل|دائم|deny)/i },
  { key: 'obfusc', label: 'إخفاء/تشويش/ترميز', re: /(مبهم|خفي|تحايل|مشفّر|مشفرة|base64|إخفاء|مموّه)/i },
  { key: 'bypass', label: 'تجاوز فحوص أو أمان', re: /(تجاوز|تعطيل (الفحص|التحقق|الأمان)|bypass|skip|--no-verify|CI_SECRET)/i },
  { key: 'untrusted', label: 'مصدر غير موثوق/انتحال', re: /(غير موثوق|مجهول|مريب|انتحال|شبيه بـ|typosquat)/i },
];

/** يستخرج مفاتيح الإشارات الظاهرة فعلاً في نص مراجعة */
export function extractSignals(text: string): string[] {
  return AUDIT_SIGNALS.filter((s) => s.re.test(text)).map((s) => s.key);
}

/** حكم سطر النص: يقبل الصيغ الثلاث المطلوبة في تعليمات المراجعة */
export function extractVerdict(text: string): 'reject' | 'manual' | 'safe' | 'unknown' {
  if (/لا تثبّتها|لا تثبتها|لا تثبَتها/.test(text)) return 'reject';
  if (/تحتاج مراجعة يدوية/.test(text)) return 'manual';
  if (/آمنة للتجربة|آمن للتجربة/.test(text)) return 'safe';
  return 'unknown';
}

const SEVERITY: Record<'reject' | 'manual' | 'safe' | 'unknown', number> = { reject: 3, manual: 2, safe: 1, unknown: 0 };

export interface CrossAuditResult {
  ok: boolean;
  models: [string, string];
  primary: AuditResult;
  secondary: AuditResult;
  /** إشارات ظهرت في المراجعتين معاً — تقاطع الظهور */
  shared: string[];
  onlyPrimary: string[];
  onlySecondary: string[];
  /** الأشد تحفظاً من حكمَي الموديلين */
  verdict: 'reject' | 'manual' | 'safe' | 'unknown' | 'error';
  /** وصف الخلاف إن وُجد (يُستخدم لإحالته إلى موديل ثالث محايد) */
  disagreement: string | null;
}

/** يشغّل مراجعتين مستقلتين على نفس الحزمة ثم يقاطعهما ويأخذ الأشد تحفظاً */
export async function crossModelAudit(cfgs: [LLMConfig, LLMConfig], bundle: AuditBundle, signal?: AbortSignal): Promise<CrossAuditResult> {
  const [a, b] = await Promise.all([semanticAudit(cfgs[0], bundle, signal), semanticAudit(cfgs[1], bundle, signal)]);
  const sigA = a.ok ? extractSignals(a.text) : [];
  const sigB = b.ok ? extractSignals(b.text) : [];
  const shared = sigA.filter((k) => sigB.includes(k));
  const onlyPrimary = sigA.filter((k) => !sigB.includes(k));
  const onlySecondary = sigB.filter((k) => !sigA.includes(k));
  const verdicts = [
    a.ok ? extractVerdict(a.text) : null,
    b.ok ? extractVerdict(b.text) : null,
  ].filter((x): x is 'reject' | 'manual' | 'safe' | 'unknown' => x !== null);
  const verdict = verdicts.length
    ? verdicts.reduce((worst, v) => (SEVERITY[v] > SEVERITY[worst] ? v : worst))
    : 'error';
  const res: CrossAuditResult = { ok: a.ok || b.ok, models: [cfgs[0].model, cfgs[1].model], primary: a, secondary: b, shared, onlyPrimary, onlySecondary, verdict, disagreement: null };
  res.disagreement = disagreementOf(res);
  return res;
}

const VERDICT_AR: Record<CrossAuditResult['verdict'], string> = {
  reject: 'لا تثبّتها — أحد الموديلين رفضها صراحةً (الأشد تحفظاً يفوز)',
  manual: 'تحتاج مراجعة يدوية',
  safe: 'آمنة للتجربة وفق الموديلين',
  unknown: 'حكم غير صريح — راجع النصين بنفسك',
  error: 'تعذّرت المراجعة (الموديلان معاً)',
};

/** قسم عربي: التقاطع أولاً ثم ما انفرد به كل موديل، ثم النصان كاملين */
export function formatCrossAuditSection(res: CrossAuditResult): string {
  const label = (keys: string[]): string => keys.map((k) => AUDIT_SIGNALS.find((s) => s.key === k)?.label ?? k).join(' · ') || '—';
  const lines: string[] = ['#### المراجعة بموديلين متقاطعَين', ''];
  lines.push(`_الموديلان: **${res.models[0]}** و**${res.models[1]}** — نفس النص، حكمان مستقلان._`);
  lines.push('');
  lines.push(`**الحكم المشترك (الأشد تحفظاً):** ${VERDICT_AR[res.verdict]}`);
  lines.push('');
  lines.push('| تقاطع الإشارات | المفتاح |');
  lines.push('|---|---|');
  lines.push(`| مشتركة (ذكرها الاثنان — ثقة أعلى) | ${label(res.shared)} |`);
  lines.push(`| انفرد بها ${res.models[0]} | ${label(res.onlyPrimary)} |`);
  lines.push(`| انفرد بها ${res.models[1]} | ${label(res.onlySecondary)} |`);
  lines.push('');
  lines.push('> التقطيع معجمي صريح من النص الحر (لا مصنّف ولا حكم آلي نهائي) — الهدف إبراز ما اتفق عليه موديلان مستقلان، وما ذكره أحدهما لينظر إليه المستخدم. القرار النهائي لك.');
  const show = (r: AuditResult, m: string): string[] => (r.ok ? ['', `##### مراجعة ${m} (${(r.ms / 1000).toFixed(1)}ث)`, '', r.text] : ['', `##### مراجعة ${m} — تعذّرت: ${r.error ?? 'سبب غير معروف'}`]);
  lines.push(...show(res.primary, res.models[0]));
  lines.push(...show(res.secondary, res.models[1]));
  return lines.join('\n');
}


// ---------------- تفسير الخلاف بموديل ثالث محايد ----------------
// عندما يختلف الحكمان، لا يكفي عرض نصّين متعارضين: يُسأل موديل ثالث (محايد لم يرَ
// أحد الحكمين من قبل) أن يحدد موضع الخلاف وأيّهما أرجح بالاستشهاد الحرفي، والسؤال
// الحاسم الذي يحسم الأمر — بلا تجميل القول، وبتصريح إن كان الخلاف لفظياً.

const VERDICT_SHORT: Record<NonNullable<CrossAuditResult['verdict']>, string> = {
  reject: '«لا تثبّتها»',
  manual: '«تحتاج مراجعة يدوية»',
  safe: '«آمنة للتجربة»',
  unknown: '«حكم غير صريح»',
  error: '«تعذّرت المراجعة»',
};

/** يصف الخلاف إن وُجد خلاف يستحق الإحالة، وإلا null (لا نستدعي موديلاً بلا داعٍ) */
export function disagreementOf(res: CrossAuditResult): string | null {
  const va = res.primary.ok ? extractVerdict(res.primary.text) : null;
  const vb = res.secondary.ok ? extractVerdict(res.secondary.text) : null;
  if (va && vb && va !== vb) {
    return `اختلاف حكم صريح: «${res.models[0]}» قال ${VERDICT_SHORT[va]} و«${res.models[1]}» قال ${VERDICT_SHORT[vb]}.`;
  }
  if (va && vb && res.shared.length === 0 && res.onlyPrimary.length + res.onlySecondary.length > 0) {
    return 'لا إشارات مشتركة بين المراجعتين: كل موديل ذكر إشارات مختلفة عن الآخر.';
  }
  return null;
}

const DISAGREE_SYSTEM = `أنت محكّم محايد بين مراجعتين أمنيتين لإضافة محرّك أكواد، وصلك حكمان متعارضان من موديلين على نفس المحتوى.
مهمتك بلا مجاملة:
1. حدّد **موضع الخلاف بالضبط**: هل هو في وقائع النص، أم في تفسيره، أم في الحكم فقط؟
2. بيّن أيّ الحكمين أرجح ولماذا، بالاستشهاد الحرفي من المحتوى (اقتبس سطراً واحداً كافياً).
3. اذكر السؤال أو الفحص العملي الحاسم الذي يحسم الأمر للمستخدم في دقيقة.
إن كان الخلاف لفظياً لا جوهرياً فقل ذلك صراحةً. لا تكرّر النصين، ولا تخمّن ما ليس في المحتوى. أجب بماركداون عربي موجز بلا مقدمات.`;

export interface DisagreementExplanation {
  ok: boolean;
  text: string;
  error?: string;
  ms: number;
}

/** موديل ثالث يفسّر الخلاف (يُستدعى فقط عند وجود خلاف فعلي) */
export async function explainDisagreement(
  cfg: LLMConfig,
  res: CrossAuditResult,
  bundle: AuditBundle,
  signal?: AbortSignal,
): Promise<DisagreementExplanation> {
  const started = Date.now();
  const clip = (t: string): string => (t.length > 2400 ? `${t.slice(0, 2400)}…` : t);
  const messages: ChatMessage[] = [
    { role: 'system', content: DISAGREE_SYSTEM },
    {
      role: 'user',
      content: [
        `## سبب الإحالة\n${disagreementOf(res) ?? 'اختلاف عام بين المراجعتين'}`,
        `## حكم الموديل الأول (${res.models[0]})\n${res.primary.ok ? clip(res.primary.text) : `(تعذّرت المراجعة: ${res.primary.error ?? 'سبب غير معروف'})`}`,
        `## حكم الموديل الثاني (${res.models[1]})\n${res.secondary.ok ? clip(res.secondary.text) : `(تعذّرت المراجعة: ${res.secondary.error ?? 'سبب غير معروف'})`}`,
        `## محتوى الإضافة كما وصلهما (مقتطع)\n${bundle.text.slice(0, 4000)}`,
      ].join('\n\n'),
    },
  ];
  try {
    const r = await streamChat(cfg, messages, [], signal, () => {}, { maxAttempts: 2 });
    const text = String(r.content ?? '').trim();
    if (!text) return { ok: false, text: '', error: 'أعاد الموديل نصاً فارغاً', ms: Date.now() - started };
    return { ok: true, text, ms: Date.now() - started };
  } catch (e: any) {
    return { ok: false, text: '', error: String(e?.message ?? e).slice(0, 200), ms: Date.now() - started };
  }
}

export type AuditVerdict = NonNullable<CrossAuditResult['verdict']>;

/** حكم الأغلبية من أصوات صريحة (يُهمل الغائب) — null إن لم يوجد صوتان صالحان */
export function majorityVerdict(votes: Array<string | null>): { verdict: AuditVerdict; count: number; total: number } | null {
  const valid = votes.filter((v): v is AuditVerdict => !!v && v !== 'unknown' && v !== 'error');
  if (valid.length < 2) return null;
  const tally = new Map<AuditVerdict, number>();
  for (const v of valid) tally.set(v, (tally.get(v) ?? 0) + 1);
  const severity: Record<string, number> = { reject: 3, manual: 2, safe: 1 };
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || (severity[b[0]] ?? 0) - (severity[a[0]] ?? 0))[0];
  return { verdict: top[0], count: top[1], total: valid.length };
}

/** قسم عربي: سبب الإحالة ثم حكم الأغلبية (إن وُجد) ثم تفسير المحكّم */
export function formatDisagreementSection(d: DisagreementExplanation, model: string, reason: string | null, res?: CrossAuditResult): string {
  if (!d.ok) {
    return [
      '#### تفسير الخلاف (موديل محايد)',
      '',
      `تعذّر التفسير: ${d.error ?? 'سبب غير معروف'}${reason ? ` — والخلاف المعلن: ${reason}` : ''}.`,
    ].join('\n');
  }
  const lines = [`#### تفسير الخلاف (موديل محايد: ${model} · ${(d.ms / 1000).toFixed(1)}ث)`];
  if (reason) lines.push('', `_سبب الإحالة: ${reason}_`);
  // أصوات الثلاثة: حكمان صريحان + حكم مستخرَج من نص المحكّم إن ذكره
  const third = extractVerdict(d.text);
  const mv = res
    ? majorityVerdict([
        res.primary.ok ? extractVerdict(res.primary.text) : null,
        res.secondary.ok ? extractVerdict(res.secondary.text) : null,
        third === 'unknown' ? null : third,
      ])
    : null;
  if (mv && mv.count >= 2) lines.push('', `> 🗳️ **حكم الأغلبية: ${VERDICT_SHORT[mv.verdict]} (${mv.count} من ${mv.total} أصوات صريحة)** — الأشد تحفظاً يبقى الحاكم عند التعادل.`);
  else if (res && mv && mv.count < 2) lines.push('', '> 🗳️ الأصوات الثلاثة متفرقة — لا أغلبية؛ القرار لك، والتفسير أعلاه يرسم الفرق.');
  lines.push('', d.text);
  return lines.join('\n');
}

export { AUDIT_SYSTEM };
