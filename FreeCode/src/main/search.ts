// بحث في الويب للوكيل: مزوّدون بمفتاح (Tavily / Brave / Serper) وبديل مجاني بلا مفتاح
// (DuckDuckGo HTML). الهدف: أن يتحقق الوكيل من التوثيق وواجهات المكتبات الحديثة بنفسه.
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type SearchProvider = 'auto' | 'tavily' | 'brave' | 'serper' | 'duckduckgo';

export interface SearchOptions {
  provider?: SearchProvider;
  apiKey?: string;
  count?: number;
  /** للاختبار: حقن fetch بديل */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface SearchResponse {
  provider: string;
  results: SearchResult[];
  note?: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

const stripTags = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

/** يختار المزوّد الفعلي: المزوّد المطلوب إن توفر مفتاحه، وإلا DuckDuckGo المجاني */
export function pickProvider(provider: SearchProvider | undefined, apiKey: string | undefined): Exclude<SearchProvider, 'auto'> {
  const key = (apiKey ?? '').trim();
  if (provider && provider !== 'auto' && provider !== 'duckduckgo' && key) return provider;
  if (provider && provider !== 'auto' && provider !== 'duckduckgo' && !key) return 'duckduckgo';
  return 'duckduckgo';
}

async function tavilySearch(query: string, apiKey: string, count: number, f: typeof fetch, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await f('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey, query, max_results: count, search_depth: 'basic' }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: clip(String(r.content ?? ''), 400) }));
}

async function braveSearch(query: string, apiKey: string, count: number, f: typeof fetch, signal?: AbortSignal): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
  const res = await f(url, { headers: { accept: 'application/json', 'x-subscription-token': apiKey }, signal });
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.web?.results ?? []).map((r: any) => ({ title: stripTags(String(r.title ?? '')), url: String(r.url ?? ''), snippet: clip(stripTags(String(r.description ?? '')), 400) }));
}

async function serperSearch(query: string, apiKey: string, count: number, f: typeof fetch, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await f('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({ q: query, num: count }),
    signal,
  });
  if (!res.ok) throw new Error(`Serper HTTP ${res.status}`);
  const json: any = await res.json();
  return (json?.organic ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.link ?? ''), snippet: clip(String(r.snippet ?? ''), 400) }));
}

/** يفكّ روابط إعادة التوجيه في نتائج DuckDuckGo (‎/l/?uddg=…) */
export function unwrapDdgUrl(href: string): string {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (!m) return href.startsWith('//') ? `https:${href}` : href;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return href;
  }
}

/** محلّل HTML لصفحة نتائج DuckDuckGo — مفصول ليُختبَر وحده */
export function parseDuckDuckGo(html: string, count: number): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]));
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && out.length < count) {
    const url = unwrapDdgUrl(m[1]);
    if (!/^https?:/i.test(url)) continue;
    out.push({ title: stripTags(m[2]), url, snippet: snippets[out.length] ?? '' });
  }
  return out;
}

async function ddgSearch(query: string, count: number, f: typeof fetch, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FreeCode/0.4)', accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  return parseDuckDuckGo(await res.text(), count);
}

export async function performSearch(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const f = opts.fetchImpl ?? fetch;
  const count = Math.min(Math.max(1, opts.count ?? 5), 10);
  const provider = pickProvider(opts.provider, opts.apiKey);
  const apiKey = (opts.apiKey ?? '').trim();

  if (provider === 'duckduckgo') {
    const results = await ddgSearch(query, count, f, opts.signal);
    return {
      provider: 'duckduckgo',
      results,
      note: apiKey ? undefined : 'بحث مجاني بلا مفتاح (DuckDuckGo). لجودة أعلى أضف مفتاح Tavily أو Brave في الإعدادات.',
    };
  }
  const results = provider === 'tavily' ? await tavilySearch(query, apiKey, count, f, opts.signal) : provider === 'brave' ? await braveSearch(query, apiKey, count, f, opts.signal) : await serperSearch(query, apiKey, count, f, opts.signal);
  return { provider, results };
}

export function formatResults(res: SearchResponse): string {
  if (!res.results.length) return `لا نتائج (المزوّد: ${res.provider}). جرّب صياغة أخرى أو استخدم web_fetch على رابط تعرفه.`;
  const lines = res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  return `نتائج البحث (${res.provider}):\n${lines.join('\n')}${res.note ? `\n\nملاحظة: ${res.note}` : ''}`;
}
