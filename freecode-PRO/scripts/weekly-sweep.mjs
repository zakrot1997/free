#!/usr/bin/env node
// الجرد الأسبوعي المؤتمت: يشغّل جرد محاور السياق من إعداد محفوظ (.freecode/sweep.json)،
// يؤرشفه، يقارن بالجرد السابق، يكتب تقريراً مؤرخاً + ملصقاً، ويضيف سطراً لسجل الجرد.
// الاستخدام:
//   npm run sweep:week                 # دورة كاملة (تحتاج npm run build مرة)
//   npm run sweep:week -- --print-cron # اطبع سطر crontab جاهزاً للتشغيل الأسبوعي
//   npm run sweep:week -- --project /path/to/project
// كل شيء محلي: لا شبكة إلا إلى خادم الموديلات الذي في الإعداد.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const project = path.resolve(argOf('--project') ?? process.cwd());
const cli = path.join(root, 'dist', 'main', 'evalcli.js');
const configFile = path.join(project, '.freecode', 'sweep.json');
const outDir = path.join(project, '.freecode', 'sweeps');
const logFile = path.join(project, '.freecode', 'sweep-log.md');
const stamp = new Date().toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');

if (argv.includes('--print-cron')) {
  const cmd = `cd ${JSON.stringify(project)} && ${process.execPath} ${JSON.stringify(cli)} --ctx-sweep --save --compare --out-dir .freecode/sweeps`;
  console.log('# أضف هذا السطر إلى crontab -e لتشغيل الجرد كل يوم أحد 09:00 (يُسجَّل تلقائياً في .freecode/sweep-log.md):');
  console.log(`0 9 * * 0 ${cmd} >> ${JSON.stringify(path.join(project, '.freecode', 'sweep-cron.log'))} 2>&1`);
  console.log(`# ويندوز (Task Scheduler): schtasks /create /tn "freecode-sweep" /tr "${cmd}" /sc weekly /d SUN /st 09:00`);
  process.exit(0);
}

if (!fs.existsSync(cli)) {
  console.error('dist/main/evalcli.js غير موجود — شغّل: npm run build');
  process.exit(1);
}
if (!fs.existsSync(configFile)) {
  console.error(`لا يوجد إعداد جرد: ${configFile}\nأنشئه بأمر: node ${path.relative(process.cwd(), cli)} --init-sweep  (ثم عدّل الموديلات)`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const badge = path.join(outDir, `${stamp}-badge.png`);
const table = path.join(outDir, `${stamp}-table.md`);
const report = path.join(outDir, `${stamp}.md`);

console.log(`جرد أسبوعي — المشروع: ${project}`);
const run = spawnSync(
  process.execPath,
  [cli, '--ctx-sweep', '--save', '--compare', '--timeline', '--badge', badge, '--table-out', table],
  { cwd: project, encoding: 'utf8' },
);
const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
if (out) console.log(out);
if (run.status !== 0) {
  console.error(`فشل الجرد (رمز ${run.status}) — لم يُكتب تقرير.`);
  process.exit(run.status ?? 1);
}

// سطر السجل: مأخوذ من قسم المقارنة/الخلاصة إن وُجد، وإلا سطر عام
const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
const digest = lines.find((l) => l.startsWith('- **')) ?? lines.find((l) => l.includes('لا تغيّر') || l.includes('انحدار') || l.includes('تحسّن')) ?? 'جرد مكتمل';
fs.writeFileSync(report, `# جرد محاور السياق — ${stamp}\n\n\`\`\`\n${out}\n\`\`\`\n`, 'utf8');
const logLine = `- ${stamp} · ${digest.replace(/^-\s*/, '')} · تقرير: \`${path.relative(project, report)}\`\n`;
if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, '# سجل الجرد الأسبوعي\n\n', 'utf8');
fs.appendFileSync(logFile, logLine, 'utf8');

console.log(`\nالتقرير: ${report}`);
console.log(`الملصق: ${badge}`);
console.log(`كتلة README الجاهزة: ${table}`);
console.log(`السجل: ${logFile}`);
