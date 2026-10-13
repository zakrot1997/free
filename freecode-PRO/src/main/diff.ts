// فرق أسطر بسيط (LCS) لعرض التعديلات قبل الموافقة عليها.

export type DiffLine = { t: ' ' | '+' | '-'; text: string; oldNo?: number; newNo?: number };
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface DiffResult {
  added: number;
  removed: number;
  hunks: Hunk[];
  truncated: boolean;
}

const MAX_CELLS = 4_000_000; // حد أمان لحجم جدول LCS

export function diffLines(oldText: string, newText: string, context = 3): DiffResult {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');

  // نقتطع البادئة واللاحقة المشتركة لتقليل الجدول
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const ops: DiffLine[] = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', text: a[i] });

  let truncated = false;
  if (am.length * bm.length > MAX_CELLS) {
    // ملف ضخم: نعرض الكتلة كلها كحذف ثم إضافة
    truncated = true;
    for (const l of am) ops.push({ t: '-', text: l });
    for (const l of bm) ops.push({ t: '+', text: l });
  } else {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: ' ', text: am[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        ops.push({ t: '-', text: am[i++] });
      } else {
        ops.push({ t: '+', text: bm[j++] });
      }
    }
    while (i < n) ops.push({ t: '-', text: am[i++] });
    while (j < m) ops.push({ t: '+', text: bm[j++] });
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', text: a[i] });

  // ترقيم الأسطر
  let o = 1;
  let nn = 1;
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === ' ') {
      op.oldNo = o++;
      op.newNo = nn++;
    } else if (op.t === '-') {
      op.oldNo = o++;
      removed++;
    } else {
      op.newNo = nn++;
      added++;
    }
  }

  // تجميع المقاطع (hunks) مع سياق
  const changed: number[] = [];
  ops.forEach((op, idx) => op.t !== ' ' && changed.push(idx));
  const hunks: Hunk[] = [];
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    let last = k;
    while (last + 1 < changed.length && changed[last + 1] - context <= end + 1) {
      last++;
      end = Math.min(ops.length - 1, changed[last] + context);
    }
    const lines = ops.slice(start, end + 1);
    const first = lines.find((l) => l.oldNo !== undefined);
    const firstNew = lines.find((l) => l.newNo !== undefined);
    hunks.push({ oldStart: first?.oldNo ?? 0, newStart: firstNew?.newNo ?? 0, lines });
    k = last + 1;
    start = 0;
  }
  return { added, removed, hunks, truncated };
}
