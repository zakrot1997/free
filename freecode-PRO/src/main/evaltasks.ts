/**
 * بنك مهام التقييم: مهام كود صغيرة واقعية على مشاريع مؤقتة، بمحاسب آلي حقيقي.
 *
 * المبدأ: لا نحاسب الموديل على كلامه بل على النتيجة — بعد انتهائه نشغّل فحصاً
 * **مخفياً** (خارج مجلد المشروع، فلا يستطيع قراءته أو تعديله) يختبر السلوك فعلاً.
 * كل المهام بلا اعتماديات خارجية: تنجح على أي جهاز فيه Node، وبلا إنترنت.
 */

export type EvalCategory = 'fix' | 'feature' | 'refactor' | 'test' | 'async' | 'data' | 'i18n' | 'quality' | 'docs';

export interface EvalTask {
  id: string;
  category: EvalCategory;
  /** وصف عربي يظهر في التقرير */
  title: string;
  /** نص المهمة كما يقوله المستخدم للموديل */
  prompt: string;
  /** ملفات البداية (نسبة إلى جذر مشروع المهمة) */
  files: Record<string, string>;
  /** سكربت المحاسب المخفي (CommonJS يُنفَّذ بـnode داخل مجلد المشروع) */
  checkScript: string;
  /** معايير القبول: ما يفحصه المحاسب فعلاً — تُعرض في بنك المهام حتى تعرف ما يُقاس */
  acceptance: string[];
  /** أقصى عدد خطوات (المهام صغيرة) */
  maxSteps?: number;
  /** نسخ مشروع حقيقي كبداية للمهمة (مهام «من عطل المشروع») */
  copyFrom?: string;
  /** ربط node_modules من المشروع الأصلي رمزياً بدل نسخه (سريع ولا يستهلك قرصاً) */
  linkNodeModules?: boolean;
  /** بصمات ملفات الإعداد المحمية: تغييرها = غش يكشفه المحاسب */
  configGuards?: Record<string, string>;
}

const OK = "console.log('OK');";

export const EVAL_TASKS: EvalTask[] = [
  {
    id: 'fix-off-by-one',
    category: 'fix',
    title: 'إصلاح خطأ حدود في حلقة (اختبار فاشل)',
    acceptance: ['يعيد sum([1,2,3]) القيمة 6 لكل العناصر لا حتى ما قبل الأخير', 'المصفوفة الفارغة تعيد 0', 'يبقى التصدير sum كما هو ولا يُعدَّل test.js', 'يمرّ node test.js فعلياً'],
    prompt:
      'في مشروعك الحالي اختبار `test.js` يفشل عند تشغيل `node test.js`.\nشغّل الاختبار، واقرأ `sum.js`، ثم أصلح الخطأ. لا تغيّر واجهة التصدير (يجب أن يبقى `module.exports = { sum }`) ولا تعدّل `test.js`.',
    files: {
      'sum.js': "function sum(nums) {\n  let total = 0;\n  for (let i = 0; i < nums.length - 1; i++) total += nums[i];\n  return total;\n}\n\nmodule.exports = { sum };\n",
      'test.js': "const assert = require('assert');\nconst { sum } = require('./sum');\n\nassert.strictEqual(sum([1, 2, 3]), 6, 'مجموع [1,2,3] يجب أن يكون 6');\nassert.strictEqual(sum([]), 0, 'مجموع [] يجب أن يكون 0');\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { sum } = require(process.cwd() + '/sum.js');
assert.strictEqual(sum([1, 2, 3]), 6, 'المجموع لا يشمل آخر عنصر');
assert.strictEqual(sum([5]), 5);
assert.strictEqual(sum([]), 0);
assert.strictEqual(sum([1, 1, 1, 1]), 4);
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    maxSteps: 10,
  },
  {
    id: 'implement-average',
    category: 'feature',
    title: 'تنفيذ دالة ناقصة حسب اختبار موجود',
    acceptance: ['متوسط [2,4] يساوي 3 ومتوسط [1,2,3,4] يساوي 2.5', 'المصفوفة الفارغة تعيد null (لا NaN ولا انهيار)', 'يبقى التصدير average ولا يُعدَّل test.js'],
    prompt:
      'الدالة `average` في `stats.js` غير منفّذة (ترمي خطأ).\nنفّذها حسب ما يتوقعه `test.js`: متوسط الأعداد، والمصفوفة الفارغة تعيد `null`. شغّل `node test.js` حتى يمرّ، ولا تغيّر واجهة التصدير.',
    files: {
      'stats.js': "function average(nums) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { average };\n",
      'test.js': "const assert = require('assert');\nconst { average } = require('./stats');\n\nassert.strictEqual(average([2, 4]), 3);\nassert.strictEqual(average([1, 2, 3, 4]), 2.5);\nassert.strictEqual(average([]), null);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { average } = require(process.cwd() + '/stats.js');
assert.strictEqual(average([2, 4]), 3);
assert.strictEqual(average([1, 2, 3, 4]), 2.5);
assert.strictEqual(average([]), null);
assert.strictEqual(average([10]), 10);
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    maxSteps: 10,
  },
  {
    id: 'fix-null-crash',
    category: 'fix',
    title: 'معالجة حالة حدية (null واسم فارغ) بلا كسر السلوك',
    acceptance: ['displayName(null) تعيد «مستخدم»', 'الاسم الفارغ أو المسافات فقط تعيد «مستخدم»', 'الاسم الصحيح يبقى كما هو بعد تقصير المسافات بلا كسر السلوك القديم'],
    prompt:
      '`displayName` في `user.js` تنهار عند تمرير `null` أو اسماً فارغاً.\nالمطلوب حسب `test.js`: إن كان الملف الشخصي `null` أو الاسم فارغ/مسافات فقط فتُعاد السلسلة `مستخدم`، وإلا يُعاد الاسم مقصوصاً. شغّل `node test.js` حتى يمرّ.',
    files: {
      'user.js': "function displayName(profile) {\n  return profile.name.trim();\n}\n\nmodule.exports = { displayName };\n",
      'test.js': "const assert = require('assert');\nconst { displayName } = require('./user');\n\nassert.strictEqual(displayName({ name: 'سارة' }), 'سارة');\nassert.strictEqual(displayName({ name: '  ' }), 'مستخدم');\nassert.strictEqual(displayName(null), 'مستخدم');\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { displayName } = require(process.cwd() + '/user.js');
assert.strictEqual(displayName({ name: 'سارة' }), 'سارة');
assert.strictEqual(displayName({ name: '  سارة  ' }), 'سارة');
assert.strictEqual(displayName({ name: '  ' }), 'مستخدم');
assert.strictEqual(displayName(null), 'مستخدم');
assert.strictEqual(displayName({}), 'مستخدم');
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    maxSteps: 12,
  },
  {
    id: 'multifile-rename',
    category: 'refactor',
    title: 'إصلاح عدم تطابق اسم مصدَّر بين ملفين',
    acceptance: ['الاستيراد في app.js يطابق الاسم المصدَّر addNumbers', 'لا يبقى الاسم القديم addNums في app.js', 'calc.js يظل يصدّر addNumbers', 'يمرّ node test.js فعلياً'],
    prompt:
      'الاختبار `node test.js` يفشل لأن `app.js` يستورد اسماً غير موجود من `calc.js`.\nأصلح الجهة الخطأ بحيث يبقى الاسم المصدَّر في `calc.js` كما هو (`addNumbers`) ويمرّ الاختبار.',
    files: {
      'calc.js': "function addNumbers(a, b) {\n  return a + b;\n}\n\nmodule.exports = { addNumbers };\n",
      'app.js': "const { addNums } = require('./calc');\n\nmodule.exports = {\n  total: (xs) => xs.reduce(addNums, 0),\n};\n",
      'test.js': "const assert = require('assert');\nconst { total } = require('./app');\n\nassert.strictEqual(total([1, 2, 3]), 6);\nassert.strictEqual(total([]), 0);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const fs = require('fs');
const { total } = require(process.cwd() + '/app.js');
assert.strictEqual(total([1, 2, 3]), 6);
assert.strictEqual(total([]), 0);
const calc = require(process.cwd() + '/calc.js');
assert.ok(typeof calc.addNumbers === 'function', 'يجب أن يبقى التصدير addNumbers');
const appSrc = fs.readFileSync(process.cwd() + '/app.js', 'utf8');
assert.ok(!/addNums\\b/.test(appSrc), 'الاسم القديم ما زال موجوداً في app.js');
${OK}`,
    maxSteps: 10,
  },
  {
    id: 'write-tests',
    category: 'test',
    title: 'كتابة اختبارات حقيقية لدالة قائمة',
    acceptance: ['4 تأكيدات على الأقل بـassert', 'يمرّ node test.js فعلياً', 'يغطي نصاً عربياً وحالة مسافات/رمز متكرر', 'الاختبارات تفشل لو أُفسدت الدالة (فحص سلوكي مستقل لا شكلي)'],
    prompt:
      'الدالة `slugify` في `slugify.js` تعمل لكن بلا اختبارات.\nاكتب ملف `test.js` (بـassert من Node) يغطي 4 حالات على الأقل: نصاً عربياً، مسافات بادئة ولاحقة، حروفاً كبيرة، ورموزاً متكررة. يجب أن يمرّ `node test.js` فعلاً.',
    files: {
      'slugify.js': "function slugify(text) {\n  return String(text)\n    .trim()\n    .toLowerCase()\n    .replace(/[^a-z0-9\\u0621-\\u064A]+/gi, '-')\n    .replace(/^-+|-+$/g, '');\n}\n\nmodule.exports = { slugify };\n",
      'README.md': '# slugify\n\nتحوّل الدالة نصاً إلى «slug» صالحاً للروابط:\n- تقصّ المسافات من الطرفين وتوحّد الحالة إلى حروف صغيرة\n- تستبدل أي رموز أو مسافات بـ`-`\n- تحذف الشرطات من الطرفين\n\nمثال: `slugify("  Hello World!! ")` ⇒ `hello-world`\n',
    },
    checkScript: `const assert = require('assert');
const fs = require('fs');
const path = process.cwd();
assert.ok(fs.existsSync(path + '/test.js'), 'لم يُنشأ ملف test.js');
const src = fs.readFileSync(path + '/test.js', 'utf8');
assert.ok(/slugify/.test(src), 'الاختبار لا يستدعي slugify');
const assertions = (src.match(/assert[.(]/g) || []).length + (src.match(/strictEqual|deepStrictEqual/g) || []).length;
assert.ok(assertions >= 4, 'الاختبار لا يضم 4 حالات على الأقل');
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
// فحص سلوكي مستقل: يمنع اختباراً شكلياً يطبع نجاحاً بلا فحص
const { slugify } = require(path + '/slugify.js');
assert.strictEqual(slugify('  Hello World!!  '), 'hello-world');
assert.strictEqual(slugify('مرحبا بالعالم'), 'مرحبا-بالعالم');
assert.strictEqual(slugify('A--B'), 'a-b');
${OK}`,
    maxSteps: 12,
  },
  {
    id: 'fix-async-order',
    category: 'async',
    title: 'إصلاح دالة تُعيد قبل انتهاء وعد (خطأ تزامن)',
    acceptance: ['await total() يعيد 42', 'لا يعيد NaN ولا وعداً غير مُنتظر', 'يبقى التصدير total ويعمل node test.js'],
    prompt:
      'الاختبار `node test.js` يفشل لأن `total` في `total.js` تُعيد القيمة قبل انتهاء الوعد من `fetchValue`.\nاجعل `total` تعيد القيمة الصحيحة (42) مع الحفاظ على واجهة التصدير. شغّل الاختبار حتى يمرّ.',
    files: {
      'fetch.js': "async function fetchValue() {\n  return 41;\n}\n\nmodule.exports = { fetchValue };\n",
      'total.js': "const { fetchValue } = require('./fetch');\n\nfunction total() {\n  let value;\n  fetchValue().then((v) => {\n    value = v;\n  });\n  return value + 1;\n}\n\nmodule.exports = { total };\n",
      'test.js': "const assert = require('assert');\nconst { total } = require('./total');\n\n(async () => {\n  assert.strictEqual(await total(), 42);\n  console.log('نجح الاختبار');\n})().catch((e) => {\n  console.error(e.message);\n  process.exit(1);\n});\n",
    },
    checkScript: `const assert = require('assert');
const { total } = require(process.cwd() + '/total.js');
(async () => {
  assert.strictEqual(await total(), 42);
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
  ${OK}
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});`,
    maxSteps: 12,
  },
  // ---- توسعة: مهام البيانات والنصوص والجودة والاختبارات والتوثيق ----
  {
    id: 'parse-csv',
    category: 'data',
    title: 'تنفيذ محلّل CSV يتعامل مع الاقتباس',
    prompt:
      'المشروع فيه `csv.js` بدالة غير منفّذة و`README.md` يشرح العقد بالضبط.\nنفّذ `parseCsv(text)` حسب الشرح: تعيد مصفوفة صفوف، وكل صف مصفوفة خلايا نصية. المدخلات فيها حقول مقتبسة بفواصل داخلها، وعلامات اقتباس مزدوجة مهرَّبة (`""`)، وأسطر تنتهي بـ CRLF، وأسطر فارغة تُتجاهل. شغّل `node test.js` حتى يمرّ.',
    files: {
      'README.md': '# parseCsv\n\nالعقد المطلوب:\n- المدخل نص CSV، والمخرج مصفوفة صفوف (`string[][]`)\n- الحقول المقتبسة بـ`"` قد تحتوي فاصلة أو سطراً جديداً، و`""` داخل الاقتباس تعني علامة اقتباس واحدة\n- الأسطر الفارغة تُتجاهل، ونهاية الأسطر قد تكون LN أو CRLF\n- لا يُضاف رأس ولا تُحوَّل الأنواع: كل الخلايا نصوص كما هي (بلا قصّ مسافات داخل الاقتباس)\n- المدخل الفارغ يعيد `[]`\n\nمثال: `parseCsv("a,b`) ⇒ `[[\"a\",\"b\"]]`\n',
      'csv.js': "function parseCsv(text) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { parseCsv };\n",
      'test.js': "const assert = require('assert');\nconst { parseCsv } = require('./csv');\n\nassert.deepStrictEqual(parseCsv('a,b'), [['a', 'b']]);\nassert.deepStrictEqual(parseCsv('x,\"a,b\",y'), [['x', 'a,b', 'y']]);\nassert.deepStrictEqual(parseCsv('\"say \"\"hi\"\"\",z'), [['say \"hi\"', 'z']]);\nassert.deepStrictEqual(parseCsv('a,b\\r\\n1,2'), [['a', 'b'], ['1', '2']]);\nassert.deepStrictEqual(parseCsv(''), []);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { parseCsv } = require(process.cwd() + '/csv.js');
assert.deepStrictEqual(parseCsv('a,b'), [['a', 'b']], 'صف بسيط');
assert.deepStrictEqual(parseCsv('a,b\\n1,2\\n'), [['a', 'b'], ['1', '2']], 'سطر أخير بلا محتوى');
assert.deepStrictEqual(parseCsv('x,"a,b",y'), [['x', 'a,b', 'y']], 'فاصلة داخل اقتباس');
assert.deepStrictEqual(parseCsv('"say ""hi""",z'), [['say "hi"', 'z']], 'اقتباس مهرَّب');
assert.deepStrictEqual(parseCsv('a,b\\r\\n1,2'), [['a', 'b'], ['1', '2']], 'نهايات CRLF');
assert.deepStrictEqual(parseCsv('col\\n\\n  \\nx'), [['col'], ['  '], ['x']], 'السطر الفارغ تماماً يُتجاهل والمحتوى بمسافات يبقى');
assert.deepStrictEqual(parseCsv(''), [], 'مدخل فارغ');
assert.deepStrictEqual(parseCsv('"multi\\nline",b'), [['multi\\nline', 'b']], 'سطر جديد داخل اقتباس');
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    acceptance: ['حقل مقتبس يحتوي فاصلة يبقى خلية واحدة', 'الاقتباس المهرَّب "" يُفكّ إلى علامة واحدة', 'CRLF والأسطر الفارغة تُعالَج', 'يمرّ node test.js فعلياً'],
    maxSteps: 12,
  },
  {
    id: 'merge-defaults',
    category: 'data',
    title: 'دمج إعدادات المستخدم مع القيم الافتراضية',
    prompt:
      '`config.js` فيه دالة غير منفّذة `withDefaults(user, defaults)`.\nالمطلوب: دمج عميق يعيد كائناً جديداً: القيم من `user` تتقدّم، والكائنات المتشعّبة تُدمج، والمصفوفات تُستبدل لا تُدمج، ويبقى المدخلان بلا أي تغيير. شغّل `node test.js` حتى يمرّ.',
    files: {
      'config.js': "function withDefaults(user, defaults) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { withDefaults };\n",
      'test.js': "const assert = require('assert');\nconst { withDefaults } = require('./config');\n\nconst user = { port: 8080, db: { host: 'db.local' } };\nconst def = { port: 3000, host: 'localhost', db: { host: 'localhost', name: 'app' }, tags: ['a'] };\nconst out = withDefaults(user, def);\nassert.strictEqual(out.port, 8080);\nassert.strictEqual(out.host, 'localhost');\nassert.strictEqual(out.db.host, 'db.local');\nassert.strictEqual(out.db.name, 'app');\nassert.deepStrictEqual(out.tags, ['a']);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { withDefaults } = require(process.cwd() + '/config.js');
const user = { port: 8080, db: { host: 'db.local', pool: 5 }, tags: ['x'] };
const def = { port: 3000, host: 'localhost', db: { host: 'localhost', name: 'app', pool: 2 }, tags: ['a', 'b'] };
const before = JSON.stringify(user);
const out = withDefaults(user, def);
assert.strictEqual(out.port, 8080, 'قيمة المستخدم تتقدّم');
assert.strictEqual(out.host, 'localhost', 'الافتراضي يُضاف');
assert.strictEqual(out.db.host, 'db.local');
assert.strictEqual(out.db.name, 'app', 'الدمج عميق لا سطحي');
assert.strictEqual(out.db.pool, 5);
assert.deepStrictEqual(out.tags, ['x'], 'المصفوفة تُستبدل لا تُدمج');
assert.strictEqual(JSON.stringify(user), before, 'المدخل لا يُعدَّل في مكانه');
assert.strictEqual(JSON.stringify(def), JSON.stringify({ port: 3000, host: 'localhost', db: { host: 'localhost', name: 'app', pool: 2 }, tags: ['a', 'b'] }), 'القيم الافتراضية لا تُعدَّل');
const nested = withDefaults({ a: { b: { c: 1 } } }, { a: { b: { c: 0, d: 2 } } });
assert.strictEqual(nested.a.b.c, 1);
assert.strictEqual(nested.a.b.d, 2, 'مستوى ثالث يُدمج أيضاً');
assert.notStrictEqual(nested.a, def.a, 'لا يُعاد استخدام الكائن نفسه');
${OK}`,
    acceptance: ['قيم المستخدم تتقدّم على الافتراضية', 'الدمج عميق في عدة مستويات', 'المصفوفات تُستبدل لا تُدمج', 'المدخلان لا يُعدَّلان (فحص لقطة قبل/بعد)'],
    maxSteps: 12,
  },
  {
    id: 'arabic-normalize',
    category: 'i18n',
    title: 'تطبيع نص عربي (تشكيل وتطويل وهمزات)',
    prompt:
      '`ar.js` فيه دالة غير منفّذة `normalizeArabic(text)` مطلوبة للبحث والمقارنة.\nالمطلوب حسب `README.md`: إزالة التشكيل والتطويل، وتوحيد الهمزات (أ إ آ ٱ ⇒ ا)، وى ⇒ ي، وة ⇒ ه، وتوحيد المسافات المتكررة، مع بقاء النص اللاتيني كما هو. شغّل `node test.js` حتى يمرّ.',
    files: {
      'README.md': '# normalizeArabic\n\n- إزالة الحركات (التشكيل) وعلامة التطويل ـ\n- توحيد: أ إ آ ٱ ⇒ ا · ى ⇒ ي · ة ⇒ ه (وفئتها المؤنثة المؤنثة مثل ه)\n- ضغط المسافات المتكررة إلى مسافة واحدة وقصّ الأطراف\n- الحروف اللاتينية والأرقام لا تتغيّر\n- نص من تشكيل فقط يعيد نصاً فارغاً\n',
      'ar.js': "function normalizeArabic(text) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { normalizeArabic };\n",
      'test.js': "const assert = require('assert');\nconst { normalizeArabic } = require('./ar');\n\nassert.strictEqual(normalizeArabic('إِسْمَاعِيل كَتَبَ'), 'اسماعيل كتب');\nassert.strictEqual(normalizeArabic('مَــدْرَسَة'), 'مدرسه');\nassert.strictEqual(normalizeArabic('آية وأُمّى'), 'ايه وامي');\nassert.strictEqual(normalizeArabic('Hello   World 42'), 'Hello World 42');\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { normalizeArabic } = require(process.cwd() + '/ar.js');
assert.strictEqual(normalizeArabic('إِسْمَاعِيل'), 'اسماعيل', 'التشكيل يُزال والهمزة تُوحَّد');
assert.strictEqual(normalizeArabic('أحمد'), 'احمد');
assert.strictEqual(normalizeArabic('آمال ٱلْحَق'), 'امال الحق');
assert.strictEqual(normalizeArabic('مصطفى'), 'مصطفي', 'الألف المقصورة');
assert.strictEqual(normalizeArabic('مدرسة'), 'مدرسه', 'التاء المربوطة');
assert.strictEqual(normalizeArabic('مـتـنـاول'), 'متناول', 'التطويل يُزال');
assert.strictEqual(normalizeArabic('  علي   وعمر  '), 'علي وعمر', 'المسافات تُضغط وتُقصّ');
assert.strictEqual(normalizeArabic('Hello World'), 'Hello World', 'اللاتيني لا يتغيّر');
assert.strictEqual(normalizeArabic('١٢٣ abc'), '١٢٣ abc', 'الأرقام العربية لا تتغيّر');
assert.strictEqual(normalizeArabic('ًٌٍَ'), '', 'نص تشكيل فقط يعيد فارغاً');
assert.strictEqual(normalizeArabic(''), '');
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    acceptance: ['التشكيل والتطويل يُزالان', 'الهمزات وى والتاء المربوطة تُوحَّد', 'المسافات تُضغط والنص اللاتيني لا يتغيّر', 'نص تشكيل فقط يعيد نصاً فارغاً'],
    maxSteps: 12,
  },
  {
    id: 'validate-signup',
    category: 'quality',
    title: 'تحقق من مدخلات التسجيل بترتيب أخطاء محدد',
    prompt:
      '`validate.js` فيه دالة غير منفّذة `validate(input)`، وعقدها في `README.md`.\nالمطلوب: تعيد `{ ok, errors }` حيث errors مصفوفة أسماء حقول ناقصة/خاطئة **بترتيب ثابت**: name ثم email ثم password. والقواعد: الاسم بعد القصّ حرفان على الأقل، والبريد يطابق نمطاً بسيطاً فيه @ ونقطة بعدها، وكلمة المرور 8 محارف على الأقل وفيها رقم. ولا تنهار الدالة على مدخل فارغ أو null. شغّل `node test.js` حتى يمرّ.',
    files: {
      'README.md': '# validate\n\n```js\nvalidate({ name, email, password }) -> { ok: boolean, errors: string[] }\n```\n\n- `name`: بعد قصّ المسافات، حرفان على الأقل\n- `email`: نمط بسيط: محارف@محارف.محارف (بلا مسافات)\n- `password`: 8 محارف على الأقل وفيها رقم واحد على الأقل\n- `errors`: أسماء الحقول الفاشلة **بترتيب ثابت**: name ثم email ثم password\n- `ok` تكون true فقط إن كانت errors فارغة · المدخل null أو غير كائن يُعامل ككائن فارغ\n',
      'validate.js': "function validate(input) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { validate };\n",
      'test.js': "const assert = require('assert');\nconst { validate } = require('./validate');\n\nassert.deepStrictEqual(validate({ name: 'علي', email: 'a@b.com', password: 'abcd1234' }), { ok: true, errors: [] });\nassert.deepStrictEqual(validate({ name: 'ع', email: 'bad', password: 'short' }), { ok: false, errors: ['name', 'email', 'password'] });\nassert.deepStrictEqual(validate({ name: 'علي', email: 'a@b.com', password: 'abcdefgh' }), { ok: false, errors: ['password'] });\nassert.strictEqual(validate(null).ok, false);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { validate } = require(process.cwd() + '/validate.js');
const ok = validate({ name: 'علي', email: 'user@mail.co', password: 'pass1234' });
assert.strictEqual(ok.ok, true, 'المدخل الصحيح يُقبل');
assert.deepStrictEqual(ok.errors, []);
assert.deepStrictEqual(validate({ name: ' علي ', email: ' user@mail.co ', password: ' pass1234 ' }).ok, true);
const bad = validate({ name: '', email: 'nope', password: 'valid123' });
assert.deepStrictEqual(bad.errors, ['name', 'email'], 'الترتيب ثابت والحقلان فقط');
assert.deepStrictEqual(validate({}).errors, ['name', 'email', 'password'], 'كائن فارغ = ثلاث أخطاء بالترتيب');
const onlyPw = validate({ name: 'أحمد', email: 'a@b.io', password: 'abcdefghi' });
assert.deepStrictEqual(onlyPw.errors, ['password'], 'كلمة بلا رقم تُرفض');
assert.deepStrictEqual(validate({ name: 'أحمد', email: 'a@b.io', password: '12345678' }).errors, [], 'كلمة أرقام فقط مقبولة');
assert.deepStrictEqual(validate(null).errors, ['name', 'email', 'password'], 'null لا يُنهي البرنامج');
assert.deepStrictEqual(validate(undefined).errors.length, 3);
assert.deepStrictEqual(validate({ name: 'أحمد', email: 'a b@c.io', password: 'abcd1234' }).errors, ['email'], 'مسافة في البريد تُرفض');
assert.strictEqual(validate({ name: 'أحمد', email: 'a@b.io', password: 'abcd1234' }).ok, true);
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    acceptance: ['قواعد الاسم والبريد وكلمة المرور تعمل', 'ترتيب الأخطاء ثابت: name ثم email ثم password', 'null وundefined لا يُنهيان البرنامج', 'يمرّ node test.js فعلياً'],
    maxSteps: 12,
  },
  {
    id: 'group-by',
    category: 'data',
    title: 'تجميع عناصر حسب مفتاح مع الحفاظ على الترتيب',
    prompt:
      '`group.js` فيه دالة غير منفّذة `groupBy(items, keyFn)`.\nالمطلوب: تعيد كائناً مفاتيحه نتائج `keyFn` وقيمها مصفوفات العناصر، بترتيب أول ظهور للمفتاح، ولا تُعدَّل المصفوفة الأصلية، والمفاتيح غير النصية تُحوَّل إلى نص. شغّل `node test.js` حتى يمرّ.',
    files: {
      'group.js': "function groupBy(items, keyFn) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { groupBy };\n",
      'test.js': "const assert = require('assert');\nconst { groupBy } = require('./group');\n\nconst items = [{ t: 'a', n: 1 }, { t: 'b', n: 2 }, { t: 'a', n: 3 }];\nconst out = groupBy(items, (x) => x.t);\nassert.deepStrictEqual(Object.keys(out), ['a', 'b']);\nassert.deepStrictEqual(out.a.map((x) => x.n), [1, 3]);\nassert.deepStrictEqual(out.b.map((x) => x.n), [2]);\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { groupBy } = require(process.cwd() + '/group.js');
const items = [1, 2, 3, 4, 5];
const before = JSON.stringify(items);
const par = groupBy(items, (n) => (n % 2 === 0 ? 'even' : 'odd'));
assert.deepStrictEqual(Object.keys(par), ['odd', 'even'], 'ترتيب أول ظهور للمفتاح');
assert.deepStrictEqual(par.odd, [1, 3, 5], 'وترتيب العناصر داخل المجموعة');
assert.deepStrictEqual(par.even, [2, 4]);
assert.strictEqual(JSON.stringify(items), before, 'المصفوفة الأصلية لا تُعدَّل');
assert.deepStrictEqual(groupBy([], () => 'x'), {}, 'مصفوفة فارغة');
const num = groupBy([10, 20, 11], (n) => (n >= 20 ? 2 : 1));
assert.deepStrictEqual(Object.keys(num), ['1', '2'], 'المفاتيح الرقمية تُحوَّل إلى نص');
assert.deepStrictEqual(num['1'], [10, 11]);
assert.deepStrictEqual(num['2'], [20]);
assert.strictEqual(typeof groupBy([{ a: 1 }], () => 'k').k, 'object', 'كل مجموعة مصفوفة');
assert.deepStrictEqual(groupBy([1, 1], () => 'ز').ز, [1, 1], 'مفتاح عربي يعمل');
${OK}`,
    acceptance: ['المفاتيح بترتيب أول ظهور', 'العناصر داخل كل مجموعة بترتيبها الأصلي', 'المفاتيح الرقمية تُحوَّل إلى نص', 'المصفوفة الأصلية لا تُعدَّل'],
    maxSteps: 12,
  },
  {
    id: 'fix-mutation-bug',
    category: 'fix',
    title: 'إصلاح تلف المدخل: دالة تُرتّب المصفوفة في مكانها',
    prompt:
      'مستخدم يقول إن دالة `topScores` «تفسد» مصفوفته: بعد استدعائها يتغيّر ترتيب المصفوفة الأصلية.\nأصلح `sort.js` بحيث تبقى المصفوفة المُمرَّرة كما هي، وتظل الدالة تعيد أعلى 3 قيم تنازلياً، وتعمل حتى لو كانت المصفوفة مجمّدة بـObject.freeze. لا تعدّل `test.js`.',
    files: {
      'sort.js': "function topScores(scores) {\n  scores.sort((a, b) => b - a);\n  return scores.slice(0, 3);\n}\n\nmodule.exports = { topScores };\n",
      'test.js': "const assert = require('assert');\nconst { topScores } = require('./sort');\n\nconst scores = [3, 1, 2];\nassert.deepStrictEqual(topScores(scores), [3, 2, 1]);\nassert.deepStrictEqual(scores, [3, 1, 2], 'المصفوفة الأصلية يجب أن تبقى كما هي');\nconsole.log('نجح الاختبار');\n",
    },
    checkScript: `const assert = require('assert');
const { topScores } = require(process.cwd() + '/sort.js');
const scores = [3, 1, 2];
const before = JSON.stringify(scores);
assert.deepStrictEqual(topScores(scores), [3, 2, 1], 'أعلى ثلاث قيم تنازلياً');
assert.strictEqual(JSON.stringify(scores), before, 'المدخل لا يتغيّر إطلاقاً');
assert.deepStrictEqual(topScores([5, 5, 4, 4, 3, 9]), [9, 5, 5], 'التعادل يُحفظ');
assert.deepStrictEqual(topScores([]), [], 'مصفوفة فارغة');
assert.deepStrictEqual(topScores([7]), [7]);
const frozen = Object.freeze([2, 9, 4, 4, 1]);
assert.deepStrictEqual(topScores(frozen), [9, 4, 4], 'مصفوفة مجمّدة تعمل');
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
${OK}`,
    acceptance: ['الدالة تعيد أعلى 3 قيم تنازلياً', 'المصفوفة المُمرَّرة لا يتغيّر ترتيبها (لقطة قبل/بعد)', 'تعمل على مصفوفة مجمّدة بـObject.freeze', 'تطابق الحالة الحدية للمصفوفة الفارغة'],
    maxSteps: 10,
  },
  {
    id: 'async-pool',
    category: 'async',
    title: 'تنفيذ معالجة محدودة التزامن مع حفظ الترتيب',
    prompt:
      '`pool.js` فيه دالة غير منفّذة `mapLimited(items, limit, fn)`.\nالمطلوب: تنفّذ `fn` على كل عنصر بحيث لا يتجاوز عدد المهام الجارية `limit` في أي لحظة، وتعيد النتائج **بترتيب المدخلات**، وترفض (reject) إن فشل أي عنصر، والمصفوفة الفارغة تعيد `[]`. شغّل `node test.js` حتى يمرّ.',
    files: {
      'pool.js': "async function mapLimited(items, limit, fn) {\n  throw new Error('not implemented');\n}\n\nmodule.exports = { mapLimited };\n",
      'test.js': "const assert = require('assert');\nconst { mapLimited } = require('./pool');\n\nlet running = 0;\nlet peak = 0;\nconst job = async (n) => {\n  running++;\n  peak = Math.max(peak, running);\n  await new Promise((r) => setTimeout(r, 10));\n  running--;\n  return n * 2;\n};\n\n(async () => {\n  const out = await mapLimited([1, 2, 3, 4, 5], 2, job);\n  assert.deepStrictEqual(out, [2, 4, 6, 8, 10]);\n  assert.ok(peak <= 2, 'لا يتجاوز التزامن الحد المطلوب');\n  console.log('نجح الاختبار');\n})().catch((e) => {\n  console.error(e.message);\n  process.exit(1);\n});\n",
    },
    checkScript: `const assert = require('assert');
const { mapLimited } = require(process.cwd() + '/pool.js');
(async () => {
  let running = 0;
  let peak = 0;
  const job = async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n + 1;
  };
  const out = await mapLimited([1, 2, 3, 4, 5, 6], 2, job);
  assert.deepStrictEqual(out, [2, 3, 4, 5, 6, 7], 'النتائج بترتيب المدخلات');
  assert.ok(peak <= 2, 'التزامن لا يتجاوز الحد (بلغ ' + peak + ')');
  assert.ok(peak >= 2, 'يستفيد من الحد فعلاً بدل التنفيذ التسلسلي (بلغ ' + peak + ')');
  let peak1 = 0;
  let run1 = 0;
  const job1 = async (n) => {
    run1++;
    peak1 = Math.max(peak1, run1);
    await new Promise((r) => setTimeout(r, 2));
    run1--;
    return n;
  };
  await mapLimited([1, 2, 3], 1, job1);
  assert.strictEqual(peak1, 1, 'limit=1 يعني تنفيذاً تسلسلياً');
  assert.deepStrictEqual(await mapLimited([], 3, job), [], 'مصفوفة فارغة');
  let failed = false;
  try {
    await mapLimited([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
  } catch (e) {
    failed = /boom/.test(e.message);
  }
  assert.ok(failed, 'فشل عنصر يرفض الوعد كله');
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, ['test.js'], { cwd: process.cwd(), stdio: 'ignore' });
  ${OK}
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});`,
    acceptance: ['التزامن لا يتجاوز الحد وفي الوقت نفسه يستفيد منه', 'النتائج بترتيب المدخلات', 'فشل عنصر يرفض الوعد كله', 'limit=1 تسلسلي والمصفوفة الفارغة تعيد []'],
    maxSteps: 12,
  },
  {
    id: 'document-readme',
    category: 'docs',
    title: 'توثيق دالة موجودة في README بلا تعديل الكود',
    prompt:
      'المشروع فيه `money.js` بلا توثيق، و`README.md` فارغ تقريباً.\nاكتب في `README.md` قسماً يوثّق `formatAmount(amount, currency)` : جملة وصف، وثلاث نقاط على الأقل تشرح السلوك (التقريب إلى منزلتين، والقيمة الافتراضية للعملة، والتعامل مع القيم السالبة)، ومثال كود في كتلة ``` فيه استدعاء فعلي للدالة. **لا تعدّل `money.js`**.',
    files: {
      'money.js': "function formatAmount(amount, currency) {\n  const cur = currency || 'USD';\n  const rounded = Math.round(Number(amount) * 100) / 100;\n  return `${rounded} ${cur}`;\n}\n\nmodule.exports = { formatAmount };\n",
      'README.md': '# money\n\nمكتبة أدوات مالية صغيرة.\n',
    },
    checkScript: `const assert = require('assert');
const fs = require('fs');
const rd = fs.readFileSync(process.cwd() + '/README.md', 'utf8');
assert.ok(/formatAmount/.test(rd), 'التوثيق يذكر اسم الدالة');
assert.ok(/formatAmount\\s*\\(/.test(rd), 'التوثيق فيه استدعاء فعلي للدالة');
const fence = String.fromCharCode(96).repeat(3);
assert.ok(rd.includes(fence), 'التوثيق فيه كتلة كود بسياج ثلاثي');
const bullets = rd.split(/\\r?\\n/).filter((l) => /^\\s*[-*•]\\s+\\S/.test(l));
assert.ok(bullets.length >= 3, 'ثلاث نقاط على الأقل (وُجد ' + bullets.length + ')');
assert.ok(/round|تقريب|منزلتين/i.test(rd), 'يشرح التقريب');
assert.ok(/currency|عملة/i.test(rd), 'يشرح معامل العملة');
assert.ok(/negative|سال|سالب/i.test(rd), 'يشرح القيم السالبة');
const src = fs.readFileSync(process.cwd() + '/money.js', 'utf8');
assert.ok(/function formatAmount/.test(src), 'الكود لم يُعدَّل (الدالة كما هي)');
assert.ok(!/module\\.exports\\s*=\\s*\\{\\s*\\}/.test(src), 'التصدير سليم');
const { formatAmount } = require(process.cwd() + '/money.js');
assert.strictEqual(formatAmount(1.005 + 0, 'EUR'), (Math.round(1.005 * 100) / 100) + ' EUR', 'السلوك الأصلي لم يتغيّر');
assert.strictEqual(formatAmount(5), '5 USD');
${OK}`,
    acceptance: ['README يذكر الدالة واستدعاءً فعلياً داخل كتلة كود', 'ثلاث نقاط تشرح التقريب والعملة الافتراضية والقيم السالبة', 'لا يُعدَّل money.js وسلوكها الأصلي سليم'],
    maxSteps: 10,
  },

];

export function taskById(id: string): EvalTask | undefined {
  return EVAL_TASKS.find((t) => t.id === id || t.id.startsWith(id));
}

/** مجموعة مصغّرة سريعة (للتجربة والخيار --quick) */
export function quickTasks(): EvalTask[] {
  return EVAL_TASKS.filter((t) => ['fix-off-by-one', 'implement-average', 'multifile-rename'].includes(t.id));
}


/**
 * حلول مرجعية للبنك: تُستخدم في `--verify-bank` ليتأكد المستخدم (ونحن) أن البنك
 * سليم فعلاً — كل مهمة يجب أن **تفشل** في حالتها الأولى وأن **تنجح** بعد تطبيق
 * حلها المرجعي. أي مهمة تنحرف تُكتشف فوراً بدل أن تحسب على الموديل ظلماً.
 */
export const EVAL_SOLUTIONS: Record<string, Record<string, string>> = {
  'fix-off-by-one': {
    'sum.js': "function sum(nums) {\n  let total = 0;\n  for (let i = 0; i < nums.length; i++) total += nums[i];\n  return total;\n}\n\nmodule.exports = { sum };\n",
  },
  'implement-average': {
    'stats.js': "function average(nums) {\n  if (!nums.length) return null;\n  return nums.reduce((a, b) => a + b, 0) / nums.length;\n}\n\nmodule.exports = { average };\n",
  },
  'fix-null-crash': {
    'user.js': "function displayName(profile) {\n  const raw = profile && typeof profile === 'object' && typeof profile.name === 'string' ? profile.name.trim() : '';\n  return raw || 'مستخدم';\n}\n\nmodule.exports = { displayName };\n",
  },
  'multifile-rename': {
    'app.js': "const { addNumbers } = require('./calc');\n\nmodule.exports = {\n  total: (xs) => xs.reduce(addNumbers, 0),\n};\n",
  },
  'write-tests': {
    'test.js': "const assert = require('assert');\nconst { slugify } = require('./slugify');\n\nassert.strictEqual(slugify('  Hello World!!  '), 'hello-world');\nassert.strictEqual(slugify('مرحبا بالعالم'), 'مرحبا-بالعالم');\nassert.strictEqual(slugify('A--B'), 'a-b');\nassert.strictEqual(slugify('منتج 42'), 'منتج-42');\nassert.strictEqual(slugify('!!!'), '');\nconsole.log('نجح الاختبار');\n",
  },
  'fix-async-order': {
    'total.js': "const { fetchValue } = require('./fetch');\n\nasync function total() {\n  return (await fetchValue()) + 1;\n}\n\nmodule.exports = { total };\n",
  },
  'parse-csv': {
    'csv.js': "function parseCsv(text) {\n  const src = text === null || text === undefined ? '' : String(text);\n  if (!src) return [];\n  const rows = [];\n  let row = [];\n  let cell = '';\n  let inQuotes = false;\n  let started = false;\n  let i = 0;\n  while (i < src.length) {\n    const ch = src[i];\n    if (inQuotes) {\n      if (ch === '\"') {\n        if (src[i + 1] === '\"') {\n          cell += '\"';\n          i += 2;\n          continue;\n        }\n        inQuotes = false;\n        i++;\n        continue;\n      }\n      cell += ch;\n      i++;\n      continue;\n    }\n    if (ch === '\"') {\n      inQuotes = true;\n      started = true;\n      i++;\n      continue;\n    }\n    if (ch === ',') {\n      row.push(cell);\n      cell = '';\n      started = true;\n      i++;\n      continue;\n    }\n    if (ch === '\\r') {\n      i++;\n      continue;\n    }\n    if (ch === '\\n') {\n      if (started) {\n        row.push(cell);\n        rows.push(row);\n      }\n      row = [];\n      cell = '';\n      started = false;\n      i++;\n      continue;\n    }\n    cell += ch;\n    started = true;\n    i++;\n  }\n  if (started) {\n    row.push(cell);\n    rows.push(row);\n  }\n  return rows;\n}\n\nmodule.exports = { parseCsv };\n",
  },
  'merge-defaults': {
    'config.js': "function isPlain(v) {\n  return !!v && typeof v === 'object' && !Array.isArray(v);\n}\n\nfunction withDefaults(user, defaults) {\n  const u = isPlain(user) ? user : {};\n  const d = isPlain(defaults) ? defaults : {};\n  const out = {};\n  const keys = new Set([...Object.keys(d), ...Object.keys(u)]);\n  for (const k of keys) {\n    const uv = u[k];\n    const dv = d[k];\n    if (uv === undefined) out[k] = isPlain(dv) ? withDefaults({}, dv) : dv;\n    else if (isPlain(uv) && isPlain(dv)) out[k] = withDefaults(uv, dv);\n    else out[k] = uv;\n  }\n  return out;\n}\n\nmodule.exports = { withDefaults };\n",
  },
  'arabic-normalize': {
    'ar.js': "const TASHKEEL = /[\\u0610-\\u061A\\u064B-\\u065F\\u0670\\u06D6-\\u06DC\\u06DF-\\u06E8\\u06EA-\\u06ED]/g;\n\nfunction normalizeArabic(text) {\n  let s = text === null || text === undefined ? '' : String(text);\n  s = s.replace(/\\u0640/g, '');\n  s = s.replace(TASHKEEL, '');\n  s = s.replace(/[\\u0623\\u0625\\u0622\\u0671]/g, '\\u0627');\n  s = s.replace(/\\u0649/g, '\\u064A');\n  s = s.replace(/\\u0629/g, '\\u0647');\n  s = s.replace(/\\s+/g, ' ').trim();\n  return s;\n}\n\nmodule.exports = { normalizeArabic };\n",
  },
  'validate-signup': {
    'validate.js': "const EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;\n\nfunction validate(input) {\n  const v = input && typeof input === 'object' ? input : {};\n  const errors = [];\n  const name = typeof v.name === 'string' ? v.name.trim() : '';\n  const email = typeof v.email === 'string' ? v.email.trim() : '';\n  const password = typeof v.password === 'string' ? v.password.trim() : '';\n  if (name.length < 2) errors.push('name');\n  if (!EMAIL.test(email)) errors.push('email');\n  if (password.length < 8 || !/\\d/.test(password)) errors.push('password');\n  return { ok: errors.length === 0, errors };\n}\n\nmodule.exports = { validate };\n",
  },
  'group-by': {
    'group.js': "function groupBy(items, keyFn) {\n  const out = {};\n  for (const item of items || []) {\n    const key = String(keyFn(item));\n    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = [];\n    out[key].push(item);\n  }\n  return out;\n}\n\nmodule.exports = { groupBy };\n",
  },
  'fix-mutation-bug': {
    'sort.js': "function topScores(scores) {\n  return [...scores].sort((a, b) => b - a).slice(0, 3);\n}\n\nmodule.exports = { topScores };\n",
  },
  'async-pool': {
    'pool.js': "async function mapLimited(items, limit, fn) {\n  const list = Array.from(items || []);\n  const width = Math.max(1, Math.floor(Number(limit) || 1));\n  const out = new Array(list.length);\n  let next = 0;\n  const worker = async () => {\n    for (;;) {\n      const i = next++;\n      if (i >= list.length) return;\n      out[i] = await fn(list[i], i);\n    }\n  };\n  const workers = [];\n  for (let k = 0; k < Math.min(width, list.length); k++) workers.push(worker());\n  await Promise.all(workers);\n  return out;\n}\n\nmodule.exports = { mapLimited };\n",
  },
  'document-readme': {
    'README.md': "# money\n\nمكتبة أدوات مالية صغيرة.\n\n## formatAmount(amount, currency)\n\nتُنسّق قيمة مالية كنص جاهز للعرض مع رمز العملة.\n\n- تُقرَّب القيمة إلى منزلتين عشريتين (تقريب حسابي عادي)\n- معامل ``currency`` اختياري، وقيمته الافتراضية ``USD``\n- القيم السالبة تُنسَّق كما هي مع إشارة السالب، فنرى ``-12.5 USD``\n\n```js\nconst { formatAmount } = require('./money');\n\nformatAmount(12.345, 'EUR'); // '12.35 EUR'\nformatAmount(5); // '5 USD'\n```\n",
  },
};
export function solutionFor(id: string): Record<string, string> | undefined {
  return EVAL_SOLUTIONS[id];
}

/** بنك المهام كنص عربي (سطر لكل مهمة + معايير القبول) — يُستخدم في CLI والواجهة */
export function formatTaskBank(tasks: EvalTask[] = EVAL_TASKS): string {
  const lines: string[] = [];
  for (const t of tasks) {
    lines.push(`• ${t.id} — ${t.title} _(${t.category})_`);
    for (const a of t.acceptance) lines.push(`    ◦ ${a}`);
  }
  return lines.join('\n');
}
