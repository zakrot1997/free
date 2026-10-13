// عميل متوافق مع OpenAI (chat/completions) مع بث SSE ودعم استدعاء الأدوات.
// FreeLLMAPI يعرض نقطة نهاية متوافقة مع OpenAI، لذلك يكفي تغيير baseUrl والمفتاح.

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * صور مرفقة (data URL). تُرسل كأجزاء متعدّدة الوسائط في حقل content بصيغة OpenAI vision،
   * ولا تُحسب حروفها ضمن تقدير التوكنات (نحسب لكل صورة تقديراً ثابتاً بدلاً من قاعدة 64).
   */
  images?: string[];
}

/** تقدير توكنات الصورة الواحدة (لقطة شاشة نموذجية ≈ 1000 توكن عند المزوّدين) */
export const TOKENS_PER_IMAGE = 1000;

/** يبني حقل content كما يتوقعه المزوّد: نص بسيط، أو أجزاء نصية وبصرية */
export function apiContentOf(m: ChatMessage): unknown {
  if (!m.images?.length) return m.content;
  const parts: unknown[] = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  for (const url of m.images) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/** رسالة جاهزة للإرسال (مع تحويل الصور إلى أجزاء متعدّدة الوسائط) */
function toApiMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: apiContentOf(m) };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  return out;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LLMConfig {
  baseUrl: string; // مثال: http://127.0.0.1:31415  (يُضاف /v1 تلقائياً)
  apiKey: string; // المفتاح الموحد freellmapi-...
  model: string; // مثال: freellmapi/auto
}

export interface StreamResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface RetryInfo {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

/** يُزيل الشرطة الأخيرة ويضيف /v1 إن لم يكن موجوداً، فيصلح أن يُدخل المستخدم 127.0.0.1:31415 فقط. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

function isRetryable(e: unknown): boolean {
  if (e instanceof HttpError) return e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500;
  // أخطاء الشبكة (fetch failed / ECONNRESET) قابلة لإعادة المحاولة
  const msg = String((e as any)?.message ?? e);
  return /fetch failed|ECONNRESET|ETIMEDOUT|terminated|socket/i.test(msg);
}

export interface StreamOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
}

/**
 * طلب بث واحد مع إعادة محاولة تلقائية (مهمة جداً مع المزودين المجانيين الذين يعيدون 429 كثيراً).
 * لا نعيد المحاولة إذا بدأ بث نص بالفعل، حتى لا يتكرر المحتوى.
 */
export async function streamChat(
  cfg: LLMConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal | undefined,
  onDelta: (text: string) => void,
  opts: StreamOptions = {},
): Promise<StreamResult> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelay = opts.baseDelayMs ?? 1500;

  for (let attempt = 1; ; attempt++) {
    let started = false;
    try {
      return await streamOnce(cfg, messages, tools, signal, (t) => {
        started = true;
        onDelta(t);
      });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      if (started || attempt >= maxAttempts || !isRetryable(e)) throw e;
      const delay = e instanceof HttpError && e.retryAfterMs ? e.retryAfterMs : baseDelay * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, maxAttempts, delayMs: delay, reason: String(e?.message ?? e).slice(0, 160) });
      await sleep(delay, signal);
    }
  }
}

async function streamOnce(
  cfg: LLMConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal: AbortSignal | undefined,
  onDelta: (text: string) => void,
): Promise<StreamResult> {
  const res = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: messages.map(toApiMessage),
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      stream: true,
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    const ra = Number(res.headers.get('retry-after'));
    throw new HttpError(
      res.status,
      `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`,
      Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30_000) : undefined,
    );
  }

  let content = '';
  let finishReason: string | null = null;
  const calls = new Map<number, ToolCall>();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (rawLine: string): boolean => {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    if (data === '[DONE]') return true;

    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return false;
    }
    if (json.error) {
      const msg = typeof json.error === 'string' ? json.error : json.error.message ?? JSON.stringify(json.error);
      // مزودون كثيرون يرسلون code نصياً (مثل "invalid_request_error")؛ نعتبر غير الرقمي خطأ طلب
      // دائماً (400) فلا نضيع 4 محاولات على خطأ لا يُصلحه التكرار.
      const raw = typeof json.error === 'object' ? json.error.code ?? json.error.status : undefined;
      const num = typeof raw === 'number' ? raw : Number(raw);
      throw new HttpError(Number.isFinite(num) && num >= 400 && num <= 599 ? num : 400, msg);
    }

    const choice = json.choices?.[0];
    if (!choice) return false;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((tc: any, pos: number) => {
        const idx: number = typeof tc.index === 'number' ? tc.index : pos;
        let cur = calls.get(idx);
        if (!cur) {
          cur = { id: tc.id ?? `call_${idx}_${Date.now()}`, type: 'function', function: { name: '', arguments: '' } };
          calls.set(idx, cur);
        }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.function.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
      });
    }
    return false;
  };

  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (handleLine(line)) {
        done = true;
        break;
      }
    }
  }
  if (!done && buffer) handleLine(buffer);

  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  return { content, toolCalls, finishReason };
}

/** طلب غير مبثوث (للتلخيص). يعيد النص كاملاً مع نفس سياسة إعادة المحاولة. */
export async function chatOnce(cfg: LLMConfig, messages: ChatMessage[], signal?: AbortSignal, opts: StreamOptions = {}): Promise<string> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelay = opts.baseDelayMs ?? 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ model: cfg.model, messages: messages.map(toApiMessage), stream: false }),
        signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HttpError(res.status, `HTTP ${res.status} ${res.statusText}: ${body.slice(0, 400)}`);
      }
      const json: any = await res.json();
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('رد غير متوقع من الخادم');
      return text;
    } catch (e: any) {
      if (signal?.aborted || attempt >= maxAttempts || !isRetryable(e)) throw e;
      const delay = baseDelay * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, maxAttempts, delayMs: delay, reason: String(e?.message ?? e).slice(0, 160) });
      await sleep(delay, signal);
    }
  }
}

export async function listModels(cfg: LLMConfig): Promise<string[]> {
  const res = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json: any = await res.json();
  return (json.data ?? []).map((m: any) => String(m.id));
}

/**
 * تقدير تقريبي لعدد التوكنات. الحروف اللاتينية ≈ 4 أحرف/توكن، أما العربية فتفكيكها
 * للتوكنات أكثر كثافة (وحدة BPE أقصر)، فنحسب كل حرف عربي بـ ~1.2 حرف/توكن لتفادي
 * التقليل المفرط في المحادثات العربية.
 */
const ARABIC_RE = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/g;

export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let arabic = 0;
  let images = 0;
  for (const m of messages) {
    const c = m.content;
    if (c) {
      chars += c.length + 8;
      arabic += c.match(ARABIC_RE)?.length ?? 0;
    } else chars += 8;
    if (m.tool_calls) for (const tc of m.tool_calls) chars += tc.function.name.length + tc.function.arguments.length;
    images += m.images?.length ?? 0;
  }
  return Math.ceil((chars - arabic) / 3.6 + arabic / 1.2) + images * TOKENS_PER_IMAGE;
}
