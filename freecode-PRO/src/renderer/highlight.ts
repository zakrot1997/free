// تلوين صياغة خفيف بدون مكتبات: تعليقات، نصوص، أرقام، كلمات مفتاحية، أنواع، استدعاءات.

const JS_KW =
  'break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield async await as satisfies declare namespace abstract get set';
const PY_KW =
  'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self print';
const SH_KW = 'if then else elif fi for in do done while case esac function return export local echo cd ls cat grep sed awk npm npx git pip python node sudo rm mv cp mkdir';
const C_KW =
  'auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private protected namespace using new delete template typename virtual override final bool true false null nullptr fn let mut pub impl trait use mod match loop func package import interface type go defer chan select range var string byte';
const CSS_KW = 'important';

interface Lang {
  comment: string;
  kw: Set<string>;
  tags?: boolean;
  caseInsensitive?: boolean;
}

const STR = '"(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\'|`(?:\\\\.|[^`\\\\])*`';
const set = (s: string) => new Set(s.split(' '));

const JS: Lang = { comment: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', kw: set(JS_KW) };
const PY: Lang = { comment: '#[^\\n]*|"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'', kw: set(PY_KW) };
const SH: Lang = { comment: '#[^\\n]*', kw: set(SH_KW) };
const C: Lang = { comment: '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/', kw: set(C_KW) };
const CSS: Lang = { comment: '\\/\\*[\\s\\S]*?\\*\\/', kw: set(CSS_KW) };
const HTML: Lang = { comment: '<!--[\\s\\S]*?-->', kw: new Set(), tags: true };
const JSON_: Lang = { comment: '(?!)', kw: set('true false null') };

const BY_NAME: Record<string, Lang> = {
  js: JS, jsx: JS, ts: JS, tsx: JS, mjs: JS, cjs: JS, javascript: JS, typescript: JS,
  json: JSON_, jsonc: JSON_,
  py: PY, python: PY,
  sh: SH, bash: SH, zsh: SH, shell: SH, console: SH,
  c: C, h: C, cpp: C, cc: C, hpp: C, java: C, cs: C, go: C, rs: C, rust: C, kt: C, swift: C, php: C,
  css: CSS, scss: CSS,
  html: HTML, htm: HTML, xml: HTML, svg: HTML, vue: HTML,
};

const cache = new Map<Lang, RegExp>();

function regexFor(lang: Lang): RegExp {
  let re = cache.get(lang);
  if (!re) {
    const tag = lang.tags ? '|(?<g><\\/?[A-Za-z][\\w-]*)' : '';
    re = new RegExp(`(?<c>${lang.comment})|(?<s>${STR})|(?<n>\\b\\d[\\d_]*(?:\\.\\d+)?\\b)${tag}|(?<w>[A-Za-z_$][\\w$-]*)`, 'g');
    cache.set(lang, re);
  }
  return re;
}

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = text;
  return s;
}

export function hasLang(name: string): boolean {
  return name.toLowerCase() in BY_NAME;
}

export function highlight(code: string, langName: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lang = BY_NAME[langName.toLowerCase()];
  if (!lang || code.length > 120_000) {
    frag.append(code);
    return frag;
  }
  const re = new RegExp(regexFor(lang));
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) frag.append(code.slice(last, m.index));
    const g = m.groups!;
    const text = m[0];
    if (g.c !== undefined) frag.append(span('tok-c', text));
    else if (g.s !== undefined) frag.append(span('tok-s', text));
    else if (g.n !== undefined) frag.append(span('tok-n', text));
    else if (g.g !== undefined) frag.append(span('tok-k', text));
    else if (g.w !== undefined) {
      if (lang.kw.has(text)) frag.append(span('tok-k', text));
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(text) && text.length > 1) frag.append(span('tok-t', text));
      else if (code[m.index + text.length] === '(') frag.append(span('tok-f', text));
      else frag.append(text);
    } else frag.append(text);
    last = m.index + text.length;
    if (text.length === 0) re.lastIndex++;
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}
