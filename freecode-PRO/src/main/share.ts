// بطاقة نتائج قابلة للمشاركة: ملف HTML واحد مكتفٍ بذاته + شارة SVG.
// القاعدة: **أرقام لا كود** — لا نصوص ملفاتك ولا مسارات مشروعك ولا أي اتصال شبكي،
// فيمكن إرسال البطاقة بلا قلق (وفيها تنبيه صريح بذلك).
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ModelReport } from './modeleval';
import { rankReports, recommendModel } from './modeleval';
import type { AbReport } from './abtest';
import type { AxisSweepRow } from './abtest';
import { badgePng, badgeColor, textWidth } from './badge';
import type { EvalHistoryEntry } from './metrics';

export interface ShareCardOptions {
  title?: string;
  version?: string;
  project?: string;
  tasksLabel?: string;
  at?: number;
}

/** يقصّ النص ليدخل في عرض متاح (بالبكسل) مع «…» — ويحترم حدود الكلمة إن أمكن */
export function fit(text: string, size: number, maxPx: number): string {
  if (textWidth(text, size) <= maxPx) return text;
  let out = text;
  while (out.length > 2 && textWidth(`${out}…`, size) > maxPx) out = out.slice(0, -1);
  out = out.trimEnd();
  const sp = out.lastIndexOf(' ');
  // اقطع عند آخر مسافة إن لم يبقِ ذلك أقل من 55% من الطول — وإلا فالقطع عند الحرف أصرح من فراغ مفقود
  if (sp > Math.floor(out.length * 0.55)) out = out.slice(0, sp);
  return `${out.trimEnd()}…`;
}

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '—');

function when(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** البطاقة: HTML مكتفٍ بذاته (CSS داخلي، بلا أي مورد خارجي) */
export function evalCardHtml(reports: ModelReport[], opts: ShareCardOptions = {}): string {
  const ranked = rankReports(reports);
  const rec = recommendModel(ranked);
  const tasks = ranked[0]?.outcomes ?? [];
  const at = opts.at ?? Date.now();
  const title = opts.title ?? 'تقييم موديلات FreeCode';
  const rows = ranked
    .map(
      (r) =>
        `<tr><td class="model">${esc(r.label)}</td><td class="num">${r.passed}/${r.total}</td><td class="num">${pct(r.passed, r.total)}</td><td class="num">${r.tokens}</td><td class="num">${r.stepsPerPass || '—'}</td><td class="num">${(r.durationMs / 1000).toFixed(1)}ث</td></tr>`,
    )
    .join('');
  const head = `<tr><th>الموديل</th><th>النجاح</th><th>النسبة</th><th>توكنات</th><th>خطوات/ناجحة</th><th>الزمن</th></tr>`;
  const matrixHead = `<tr><th>الموديل</th>${tasks.map((t) => `<th title="${esc(t.title)}">${esc(String(t.taskId ?? '').replace(/^project-/, '').slice(0, 16))}</th>`).join('')}<th>النتيجة</th></tr>`;
  const matrixRows = ranked
    .map(
      (r) =>
        `<tr><td class="model">${esc(r.label)}</td>${r.outcomes.map((o) => `<td class="num">${o.ok ? '✅' : '❌'}</td>`).join('')}<td class="num">${r.passed}/${r.total}</td></tr>`,
    )
    .join('');
  const failures = ranked
    .flatMap((r) => r.outcomes.filter((o) => !o.ok).map((o) => ({ model: r.label, o })))
    .slice(0, 8)
    .map(({ model, o }) => `<li><b>${esc(model)}</b> × <code>${esc(String(o.taskId ?? ''))}</code>: ${esc(String(o.reason ?? '').replace(/\n/g, ' ').slice(0, 140))}</li>`)
    .join('');

  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — ${esc(when(at))}</title>
<style>
  :root { --bg:#0f1318; --bg2:#141a22; --line:#26303d; --text:#dde4ec; --text2:#9aa8b8; --ok:#62d08f; --act:#5dd6c4; --plan:#7aa7ff; --bad:#f06a78; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 18px 40px; background:var(--bg); color:var(--text); font:15px/1.7 "IBM Plex Sans Arabic","Segoe UI",Tahoma,system-ui,sans-serif; }
  .card { max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--text2); font-size:13px; margin-bottom:18px; }
  h2 { font-size:15px; color:var(--act); margin:26px 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--bg2); border-radius:10px; overflow:hidden; }
  th, td { border:1px solid var(--line); padding:6px 9px; text-align:right; }
  th { background:#1a222b; color:var(--text2); font-weight:600; }
  td.num { text-align:center; font-variant-numeric:tabular-nums; }
  td.model { font-weight:600; }
  .rec { border:1px solid var(--line); border-right:3px solid var(--ok); background:var(--bg2); border-radius:10px; padding:12px 14px; }
  .rec b { color:var(--ok); }
  ul { margin:6px 0 0; padding-inline-start:20px; color:var(--text2); font-size:13px; }
  code { background:#1a222b; border:1px solid var(--line); border-radius:5px; padding:1px 5px; font-size:12px; direction:ltr; }
  footer { margin-top:26px; color:var(--text2); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
</style>
</head>
<body>
<div class="card">
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(when(at))}${opts.version ? ` · FreeCode ${esc(opts.version)}` : ''}${opts.project ? ` · المشروع: ${esc(path.basename(opts.project))}` : ''} · ${esc(opts.tasksLabel ?? `${tasks.length} مهمة`)}</div>

  <h2>ملخّص الترتيب</h2>
  <table>${head}${rows}</table>

  <h2>تفصيل المهام</h2>
  <table>${matrixHead}${matrixRows}</table>

  <h2>التوصية</h2>
  <div class="rec">${rec ? (rec.label ? `<b>استخدم «${esc(rec.label)}»</b> — ${esc(rec.why)}` : esc(rec.why)) : 'لا توصية (لا بيانات كافية).'}</div>

  ${failures ? `<h2>أسباب الفشل</h2><ul>${failures}</ul>` : ''}

  <footer>
    البيانات أرقام فقط: لا تحتوي أي كود من مشروعك ولا مساراته ولا مفاتيح API. المهام تُنفَّذ محلياً على مشاريع مؤقتة، والحكم من محاسب مخفي يفحص السلوك لا كلام الموديل.
  </footer>
</div>
</body>
</html>`;
}


/** بطاقة مقارنة A/B: نفس الهوية، وأرقام النسختين لا الكود */
export function abCardHtml(report: AbReport, opts: ShareCardOptions = {}): string {
  const at = opts.at ?? Date.now();
  const title = opts.title ?? 'مقارنة تعليمات FreeCode (A/B)';
  const rows = report.summary
    .map((x) => `<tr><td class="model">${esc(x.variant)}</td><td class="num">${x.passed}/${x.total}</td><td class="num">${(x.total ? Math.round((x.passed / x.total) * 100) : 0)}%</td><td class="num">${x.tokens}</td><td class="num">${x.stepsPerPass || '—'}</td></tr>`)
    .join('');
  const matrixHead = `<tr><th>المهمة</th>${report.variants.map((v) => `<th>${esc(v)}</th>`).join('')}</tr>`;
  const matrixRows = report.tasks
    .map((t) => `<tr><td>${esc(t.taskId)}</td>${report.variants.map((v) => `<td class="num">${t.runs.filter((r) => r.variant === v).map((r) => (r.ok ? '✅' : '❌')).join(' ')}</td>`).join('')}</tr>`)
    .join('');
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)} — ${esc(when(at))}</title>
<style>
  :root { --bg:#0f1318; --bg2:#141a22; --line:#26303d; --text:#dde4ec; --text2:#9aa8b8; --ok:#62d08f; --act:#5dd6c4; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px 18px 40px; background:var(--bg); color:var(--text); font:15px/1.7 "IBM Plex Sans Arabic","Segoe UI",Tahoma,system-ui,sans-serif; }
  .card { max-width:820px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { color:var(--text2); font-size:13px; margin-bottom:18px; }
  h2 { font-size:15px; color:var(--act); margin:26px 0 8px; }
  table { width:100%; border-collapse:collapse; font-size:13px; background:var(--bg2); border-radius:10px; overflow:hidden; }
  th, td { border:1px solid var(--line); padding:6px 9px; text-align:right; }
  th { background:#1a222b; color:var(--text2); font-weight:600; }
  td.num { text-align:center; font-variant-numeric:tabular-nums; }
  td.model { font-weight:600; }
  .verdict { border:1px solid var(--line); border-right:3px solid var(--ok); background:var(--bg2); border-radius:10px; padding:12px 14px; }
  footer { margin-top:26px; color:var(--text2); font-size:12px; border-top:1px solid var(--line); padding-top:12px; }
</style>
</head>
<body>
<div class="card">
  <h1>${esc(title)}</h1>
  <div class="sub">${esc(when(at))}${opts.version ? ` · FreeCode ${esc(opts.version)}` : ''} · ${esc(report.taskLabel)} · ${report.tasks.length} مهمة × ${report.repeats} تكرار${opts.project ? ` · المشروع: ${esc(path.basename(opts.project))}` : ''}</div>

  <h2>الملخّص</h2>
  <table><tr><th>النسخة</th><th>النجاح</th><th>النسبة</th><th>توكنات</th><th>خطوات/ناجحة</th></tr>${rows}</table>

  <h2>تفصيل المهام</h2>
  <table>${matrixHead}${matrixRows}</table>

  <h2>الحكم</h2>
  <div class="verdict">${esc(report.verdict)}</div>

  <footer>
    نفس المهام ونفس الموديل ونفس الظروف؛ الفرق الوحيد نص ملف التعليمات. البيانات أرقام فقط: لا كود من مشروعك ولا مساراته ولا مفاتيح API. الحكم من محاسب مخفي لا من كلام الموديل — والفرق بين نسختين قد يتذبذب، فكرّر للتأكيد.
  </footer>
</div>
</body>
</html>`;
}

/** شارة صغيرة (SVG) تُلصق في README مثل شارات البناء */
export function evalBadgeSvg(reports: ModelReport[], opts: ShareCardOptions = {}): string {
  const ranked = rankReports(reports);
  const best = ranked[0];
  const label = (opts.title ?? 'freecode eval').slice(0, 28);
  const value = best ? `${best.label} ${best.passed}/${best.total}` : 'لا بيانات';
  const ok = best && best.total && best.passed / best.total >= 0.8;
  const color = !best ? '#6a7a8e' : ok ? '#2f6b4a' : best.passed > 0 ? '#7a5a1f' : '#7a2b33';
  const wLabel = 8 + label.length * 7;
  const wValue = 10 + value.length * 7;
  const total = wLabel + wValue;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <rect width="${wLabel}" height="20" fill="#1a222b"/>
  <rect x="${wLabel}" width="${wValue}" height="20" fill="${color}"/>
  <g fill="#dde4ec" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${wLabel / 2}" y="14" text-anchor="middle">${esc(label)}</text>
    <text x="${wLabel + wValue / 2}" y="14" text-anchor="middle">${esc(value)}</text>
  </g>
</svg>`;
}

/** يكتب البطاقة والشارة في مجلد (مشروع المستخدم أو .freecode) */
export interface BadgeCardData {
  title: string;
  /** 0..100 — يحدد لون شريط الحالة (نفس عتبات شارة الويب) */
  score: number;
  headline: string;
  sub: string;
  footer?: string;
}

/** ملصق PNG للقنوات التي لا تقبل HTML — مربع 1080×1080 للأفاتار والشبكات، أو شريط 900×260 */
export function shareBadgePng(d: BadgeCardData, opts: { square?: boolean; product?: string } = {}): Buffer {
  if (opts.square) {
    const project = shortLogoName(d.title);
    return badgePng({
      width: 1080,
      height: 1080,
      bg: '#0b1220',
      panel: '#111a2b',
      radius: 30,
      accent: badgeColor(d.score),
      logo: { text: d.title.slice(0, 1) || 'F', bg: logoColor(d.title), fg: '#f8fafc', size: 150, top: 90, left: 90 },
      lines: [
        { text: project, size: 34, color: '#94a3b8', top: 60, align: 'right' },
        { text: d.headline, size: 230, color: '#f8fafc', top: 300, align: 'center' },
        { text: d.sub.slice(0, 120), size: 34, color: '#cbd5e1', top: 700, align: 'right' },
        { text: d.footer ?? 'أُنشئ محلياً — بلا رفع أي كود ولا بيانات مشروع', size: 24, color: '#64748b', top: 990, align: 'left' },
      ],
    });
  }
  return badgePng({
    width: 900,
    height: 260,
    bg: '#0b1220',
    panel: '#111a2b',
    radius: 22,
    accent: badgeColor(d.score),
    lines: [
      { text: d.title, size: 26, color: '#94a3b8', top: 26, align: 'right' },
      { text: d.headline, size: 72, color: '#f8fafc', top: 58, align: 'right' },
      { text: d.sub, size: 22, color: '#cbd5e1', top: 168, align: 'right' },
      { text: d.footer ?? 'أُنشئ محلياً — بلا رفع أي كود ولا بيانات مشروع', size: 16, color: '#64748b', top: 208, align: 'left' },
    ],
  });
}

/** بيانات ملصق تقييم الموديلات (يُبنى منها الشريط أو المقاس المربع) */
export function evalBadgeData(reports: ModelReport[], opts: ShareCardOptions = {}): BadgeCardData {
  const top = rankReports(reports)[0];
  const total = top?.total ?? 0;
  const passed = top?.passed ?? 0;
  const score = total ? Math.round((passed / total) * 100) : 0;
  const avg = total ? Math.round((top?.tokens ?? 0) / Math.max(1, total)) : 0;
  const sub = total ? `ناجحة ${passed} من ${total} مهمة · ~${avg} توكن/مهمة · ${top.label}` : 'لا نتائج بعد';
  return { title: `تقييم الموديلات${opts.version ? ` ${opts.version}` : ''} — freecode`, score, headline: `${score}%`, sub };
}

/** ملصق PNG من تقرير تقييم الموديلات */
export function evalBadgePng(reports: ModelReport[], opts: ShareCardOptions = {}): Buffer {
  return shareBadgePng(evalBadgeData(reports, opts));
}

/** لون ثابت مشتق من اسم المشروع — hex لأن راسم الملصق يقبل #rrggbb فقط */
export function logoColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) % 360;
  // hsl → rgb بمعادلة قياسية، بتشبع 62% وإضاءة 42% ثم تعتيم خفيف ليتباين مع النص
  const s = 0.62;
  const l = 0.42;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(h / 60) % 6;
  const [r1, g1, b1] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const to2 = (v: number): string => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to2(r1)}${to2(g1)}${to2(b1)}`;
}

/** اسم مختصر للمشروع في الملصق: أول كلمتين بحد أقصى 18 محرفاً */
export function shortLogoName(project: string): string {
  const parts = project.trim().split(/[\s_\-–—]+/).filter(Boolean);
  const two = parts.slice(0, 2).join(' ');
  return (two || project).slice(0, 18);
}

/** حرف الشعار: أول حرف عربي/لاتيني ظاهر في الاسم، وإلا هلال افتراضي */
export function logoLetter(project: string): string {
  const t = project.replace(/^[^\p{L}\p{N}]+/u, '');
  return t ? [...t][0] : '⌘';
}

/** ملصق PNG لآخر جولة تقييم من السجل (بلا تقرير كامل — للأرشفة السريعة) */
export function historyBadgePng(entry: EvalHistoryEntry, opts: ShareCardOptions = {}): Buffer {
  const best = entry.models.find((m) => m.label === entry.best) ?? [...entry.models].sort((a, b) => b.passed - a.passed || a.tokens - b.tokens)[0];
  const total = best?.total ?? 0;
  const passed = best?.passed ?? 0;
  const score = total ? Math.round((passed / total) * 100) : Math.round(entry.bestRate * 100);
  const avg = total ? Math.round((best?.tokens ?? 0) / Math.max(1, total)) : 0;
  const date = new Date(entry.at).toISOString().slice(0, 10);
  const project = (opts.project ?? '').trim() || 'مشروعك';
  const kind = entry.quick ? 'المجموعة السريعة' : 'البنك الكامل';
  const sub = total
    ? `ناجحة ${passed} من ${total} · ~${avg} توكن/مهمة · ${entry.models.length} موديل · ${kind}`
    : `لا موديل نجح في هذه الجولة · ${entry.models.length} موديل · ${kind}`;
  return badgePng({
    width: 900,
    height: 260,
    bg: '#0b1220',
    panel: '#111a2b',
    radius: 22,
    accent: badgeColor(score),
    logo: { text: logoLetter(project), bg: logoColor(project), fg: '#f8fafc' },
    lines: [
      { text: fit(`${project} — آخر جولة تقييم ${date}`, 24, 900 - 34 * 2 - 110), size: 24, color: '#94a3b8', top: 26, align: 'right' },
      { text: `${score}%`, size: 68, color: '#f8fafc', top: 58, align: 'right' },
      { text: fit(entry.best ? `الأفضل: ${entry.best} — ${sub}` : sub, 21, 900 - 34 * 2 - 110), size: 21, color: '#cbd5e1', top: 164, align: 'right' },
      { text: `freecode${opts.version ? ` ${opts.version}` : ''} — أُنشئ محلياً بلا أي رفع`, size: 16, color: '#64748b', top: 208, align: 'left' },
    ],
  });
}

/** بيانات ملصق مقارنة A/B (تعليمات أو سياق) */
export function abBadgeData(report: AbReport, opts: ShareCardOptions = {}): BadgeCardData {
  const best = [...report.summary].sort((a, b) => b.passed - a.passed || a.tokens - b.tokens)[0];
  const score = best && best.total ? Math.round((best.passed / best.total) * 100) : 0;
  const sub = report.summary.map((s) => `${s.variant} ${s.passed}/${s.total}`).join(' · ') + (best ? ` — الفائز: ${best.variant}` : '');
  const kind = report.kind === 'context' ? 'لسياق الوكيل' : 'للتعليمات';
  return { title: `مقارنة A/B ${kind}${opts.version ? ` ${opts.version}` : ''} — freecode`, score, headline: `${score}%`, sub: sub.slice(0, 140) };
}

/** ملصق PNG من تقرير مقارنة A/B */
export function abBadgePng(report: AbReport, opts: ShareCardOptions = {}): Buffer {
  return shareBadgePng(abBadgeData(report, opts));
}

/** ملصق PNG من جرد محاور السياق: النسبة = الصفوف التي توصي الخلاصة بإبقائها */
export function ctxSweepBadgePng(rows: AxisSweepRow[], opts: { tasks?: number; project?: string; version?: string } = {}): Buffer {
  const keep = rows.filter((r) => r.deltaPassed > 0 || (r.deltaPassed === 0 && r.tokenSavingPct >= 8)).length;
  const pctKeep = rows.length ? Math.round((keep / rows.length) * 100) : 0;
  const axes = [...new Set(rows.map((r) => r.axis))].join('/');
  const models = new Set(rows.map((r) => r.model)).size;
  const project = (opts.project ?? '').trim();
  return badgePng({
    width: 900,
    height: 260,
    bg: '#0b1220',
    panel: '#111a2b',
    radius: 22,
    accent: badgeColor(pctKeep),
    logo: project ? { text: logoLetter(project), bg: logoColor(project), fg: '#f8fafc' } : undefined,
    lines: [
      { text: `جرد محاور السياق${opts.version ? ` ${opts.version}` : ''} — freecode`, size: 24, color: '#94a3b8', top: 26, align: 'right' },
      { text: `${keep}/${rows.length}`, size: 68, color: '#f8fafc', top: 58, align: 'right' },
      { text: fit(`صفوف يوصي الجدول بإبقائها (${pctKeep}%) · ${models} موديل · محاور ${axes}${opts.tasks ? ` · ${opts.tasks} مهمة` : ''}`, 21, 900 - 34 * 2 - 110), size: 21, color: '#cbd5e1', top: 164, align: 'right' },
      { text: `freecode${opts.version ? ` ${opts.version}` : ''} — أُنشئ محلياً بلا أي رفع`, size: 16, color: '#64748b', top: 208, align: 'left' },
    ],
  });
}

/** يكتب البطاقة والشارة والملصق PNG في مجلد (مشروع المستخدم أو .freecode) */
export async function writeShareCard(dir: string, reports: ModelReport[], opts: ShareCardOptions = {}): Promise<{ ok: boolean; html?: string; svg?: string; png?: string; error?: string }> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date(opts.at ?? Date.now()).toISOString().slice(0, 10);
    const htmlFile = path.join(dir, `model-eval-card-${stamp}.html`);
    const svgFile = path.join(dir, `model-eval-badge-${stamp}.svg`);
    const pngFile = path.join(dir, `model-eval-badge-${stamp}.png`);
    await fs.writeFile(htmlFile, evalCardHtml(reports, opts), 'utf8');
    await fs.writeFile(svgFile, evalBadgeSvg(reports, opts), 'utf8');
    await fs.writeFile(pngFile, evalBadgePng(reports, opts));
    return { ok: true, html: htmlFile, svg: svgFile, png: pngFile };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}
