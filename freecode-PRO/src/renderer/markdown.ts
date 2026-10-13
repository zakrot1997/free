// عارض Markdown آمن: يبني عناصر DOM مباشرة (بدون innerHTML) فلا يمكن حقن HTML من النموذج.
import { h } from './util';
import { highlight } from './highlight';
import { icon } from './icons';

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>()"']+)/g;

function inline(text: string): Node[] {
  const out: Node[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(document.createTextNode(text.slice(last, i)));
    const t = m[0];
    if (t.startsWith('`')) out.push(h('code', { class: 'ic', text: t.slice(1, -1) }));
    else if (t.startsWith('**')) out.push(h('strong', {}, ...inline(t.slice(2, -2))));
    else if (t.startsWith('*')) out.push(h('em', {}, ...inline(t.slice(1, -1))));
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      out.push(link(mm[1], mm[2]));
    } else out.push(link(t.replace(/[.,;:!?،؛؟]+$/, ''), t.replace(/[.,;:!?،؛؟]+$/, '')));
    last = i + t.length;
    if (/[.,;:!?،؛؟]+$/.test(t) && !t.startsWith('[') && !t.startsWith('`') && !t.startsWith('*')) {
      const trailing = /[.,;:!?،؛؟]+$/.exec(t)![0];
      out.push(document.createTextNode(trailing));
    }
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function link(label: string, url: string): HTMLAnchorElement {
  return h('a', { text: label, attrs: { href: url, 'data-ext': '1' }, title: url });
}

export function codeBlock(code: string, lang: string): HTMLElement {
  const pre = h('pre', { dir: 'ltr' });
  const codeEl = h('code');
  codeEl.append(highlight(code, lang));
  pre.append(codeEl);
  const copy = h('button', { class: 'copy', title: 'نسخ', attrs: { type: 'button' } }, icon('copy', 14));
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(code).then(() => {
      copy.classList.add('done');
      setTimeout(() => copy.classList.remove('done'), 1200);
    });
  });
  return h('div', { class: 'codeblock' }, h('div', { class: 'code-head' }, h('span', { text: lang || 'نص' }), copy), pre);
}

function tableFrom(rows: string[]): HTMLElement {
  const split = (r: string) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = split(rows[0]);
  const body = rows.slice(2).map(split);
  return h(
    'div',
    { class: 'tbl' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...head.map((c) => h('th', { dir: 'auto' }, ...inline(c))))),
      h('tbody', {}, ...body.map((r) => h('tr', {}, ...r.map((c) => h('td', { dir: 'auto' }, ...inline(c)))))),
    ),
  );
}

/** يبني عناصر المحتوى. يتحمّل النص غير المكتمل أثناء البث (سياج ``` مفتوح يُعامل ككتلة كود). */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      frag.append(h('p', { dir: 'auto' }, ...inline(para.join(' '))));
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // السياج المغلِق
      frag.append(codeBlock(buf.join('\n'), fence[1]));
      continue;
    }

    const hd = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hd) {
      flushPara();
      const tag = (`h${Math.min(4, hd[1].length + 1)}`) as 'h2' | 'h3' | 'h4' | 'h5';
      frag.append(h(tag as 'h2', { dir: 'auto' }, ...inline(hd[2])));
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      frag.append(h('hr'));
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      frag.append(tableFrom(rows));
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      frag.append(h('blockquote', { dir: 'auto' }, ...inline(buf.join(' '))));
      continue;
    }

    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]);
      const items: Node[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        const nested = m[1].length >= 2;
        const node = h('li', { dir: 'auto', class: nested ? 'nested' : '' }, ...inline(m[3]));
        items.push(node);
        i++;
      }
      frag.append(h(ordered ? 'ol' : 'ul', {}, ...items));
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return frag;
}
