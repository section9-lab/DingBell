export type OzonReadCode = 'invalid_request' | 'invalid_response' | 'invalid_credentials' | 'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'redirect_refused' | 'network_error' | 'timed_out' | 'aborted';
export class OzonReadError extends Error {
  readonly code: OzonReadCode;
  readonly retryAfterMs?: number;
  constructor(code: OzonReadCode, retryAfterMs?: number) { super(code); this.name = 'OzonReadError'; this.code = code; this.retryAfterMs = retryAfterMs; }
}
export type Credentials = { clientId: string; apiKey: string };
const decimal = /^(0|[1-9][0-9]{0,39})$/;
const idFields = new Set(['id', 'product_id', 'chat_id', 'message_id', 'last_message_id', 'first_unread_message_id', 'sku', 'order_id', 'order_number']);
function invalid(): never { throw new OzonReadError('invalid_response'); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return Math.min(Number(value) * 1_000, Number.MAX_SAFE_INTEGER);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function boundedJSON(response: Response, aborted: Promise<never>): Promise<Record<string, unknown>> {
  if (!response.body) invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > 1_048_576) invalid();
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 1_048_576) invalid();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    // Native source tokens avoid rounding int64 IDs before converting them to strings.
    return object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes), (key: string, value: unknown, context?: { source?: string }) => {
      if (!idFields.has(key) || typeof value !== 'number') return value;
      return context?.source && decimal.test(context.source) ? context.source : value;
    }));
  } finally { void reader.cancel().catch(() => {}); }
}

export async function readOzonJSON(credentials: Credentials, path: '/v3/chat/list' | '/v3/chat/history' | '/v3/product/list' | '/v3/product/info/list' | '/v4/posting/fbs/list' | '/v3/posting/fbs/get', body: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!['/v3/chat/list', '/v3/chat/history', '/v3/product/list', '/v3/product/info/list', '/v4/posting/fbs/list', '/v3/posting/fbs/get'].includes(path)) throw new OzonReadError('invalid_request');
  if (!/^[0-9]{1,32}$/.test(credentials.clientId) || !/^[\x21-\x7e]{1,4096}$/.test(credentials.apiKey)) throw new OzonReadError('invalid_request');
  if (signal?.aborted) throw new OzonReadError('aborted');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new OzonReadError(signal?.aborted ? 'aborted' : 'timed_out')), { once: true }));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8_000);
  let failure: OzonReadCode = 'network_error';
  try {
    const response = await Promise.race([fetcher(`https://api-seller.ozon.ru${path}`, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Client-Id': credentials.clientId, 'Api-Key': credentials.apiKey, 'Content-Type': 'application/json' }, body,
    }), aborted]);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const code = response.status === 401 ? 'invalid_credentials' : response.status === 403 ? 'permission_denied' : response.status === 429 ? 'rate_limited' : response.status >= 300 && response.status < 400 ? 'redirect_refused' : 'provider_unavailable';
      throw new OzonReadError(code, code === 'rate_limited' ? retryAfter(response.headers.get('retry-after')) : undefined);
    }
    failure = 'invalid_response';
    return await boundedJSON(response, aborted);
  } catch (error) {
    if (error instanceof OzonReadError) throw error;
    throw new OzonReadError(controller.signal.aborted ? signal?.aborted ? 'aborted' : 'timed_out' : failure);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
