import { h } from './util';

const MAX_LINES = 400;

/** عرض الفروقات بأرقام أسطر وألوان إضافة/حذف */
export function renderDiff(diff: DiffData): HTMLElement {
  const root = h('div', { class: 'diff', dir: 'ltr' });
  let shown = 0;
  let hidden = 0;
  for (const hunk of diff.hunks) {
    if (shown >= MAX_LINES) {
      hidden += hunk.lines.length;
      continue;
    }
    root.append(h('div', { class: 'hunk-head', text: `@@ -${hunk.oldStart} +${hunk.newStart} @@` }));
    for (const l of hunk.lines) {
      if (shown >= MAX_LINES) {
        hidden++;
        continue;
      }
      shown++;
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx';
      root.append(
        h(
          'div',
          { class: `dl ${cls}` },
          h('span', { class: 'no', text: l.oldNo !== undefined ? String(l.oldNo) : '' }),
          h('span', { class: 'no', text: l.newNo !== undefined ? String(l.newNo) : '' }),
          h('span', { class: 'sg', text: l.t === ' ' ? '' : l.t }),
          h('span', { class: 'tx', text: l.text === '' ? ' ' : l.text }),
        ),
      );
    }
  }
  if (diff.hunks.length === 0) root.append(h('div', { class: 'hunk-head', text: 'لا تغييرات' }));
  if (hidden) root.append(h('div', { class: 'hunk-head', text: `… و${hidden} سطراً إضافياً` }));
  return root;
}
