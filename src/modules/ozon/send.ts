import * as v from 'valibot';
import { replyBodySchema } from '../conversations/control-state.ts';
import type { Credentials } from './read.ts';

export type OzonSendResult = {
  outcome: 'sent' | 'failed' | 'unknown'; httpStatus: number | null;
  providerResult: 'success' | null; errorCode: string | null; retryAfterMs?: number;
};
function result(outcome: OzonSendResult['outcome'], httpStatus: number | null, errorCode: string | null): OzonSendResult {
  return { outcome, httpStatus, providerResult: outcome === 'sent' ? 'success' : null, errorCode };
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  if (/^[0-9]+$/.test(value)) return Math.min(Number(value) * 1000, Number.MAX_SAFE_INTEGER);
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
async function accepted(response: Response, aborted: Promise<never>): Promise<boolean> {
  if (!response.body) return false;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > 65536) return false;
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65536) return false;
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    return !!value && typeof value === 'object' && !Array.isArray(value) && 'result' in value && value.result === 'success';
  } finally { void reader.cancel().catch(() => {}); }
}

export async function sendOzonMessage(credentials: Credentials, input: { chatId: string; body: string }, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<OzonSendResult> {
  if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.apiKey !== 'string' || !/^[0-9]{1,32}$/.test(credentials.clientId) || !/^[\x21-\x7e]{1,4096}$/.test(credentials.apiKey)
    || !input || typeof input.chatId !== 'string' || input.chatId.length === 0 || input.chatId.length > 256 || !v.is(replyBodySchema, input.body)) return result('failed', null, 'invalid_request');
  if (signal?.aborted) return result('failed', null, 'aborted_before_request');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Send interrupted.')), { once: true }));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8000);
  let httpStatus: number | null = null, failure = 'network_error';
  try {
    const response = await Promise.race([fetcher('https://api-seller.ozon.ru/v1/chat/send/message', {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Client-Id': credentials.clientId, 'Api-Key': credentials.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: input.chatId, text: input.body }),
    }), aborted]);
    httpStatus = response.status;
    if (httpStatus !== 200) {
      void response.body?.cancel().catch(() => {});
      const rejected: Record<number, string> = { 400: 'invalid_request', 401: 'invalid_credentials', 403: 'permission_denied', 404: 'not_found', 422: 'rejected', 429: 'rate_limited' };
      const code = rejected[httpStatus];
      const value = result(code ? 'failed' : 'unknown', httpStatus, code ?? (httpStatus >= 300 && httpStatus < 400 ? 'redirect_refused' : 'provider_unavailable'));
      const delay = httpStatus === 429 ? retryAfter(response.headers.get('retry-after')) : undefined;
      return delay === undefined ? value : { ...value, retryAfterMs: delay };
    }
    failure = 'invalid_response';
    return await accepted(response, aborted) ? result('sent', httpStatus, null) : result('unknown', httpStatus, failure);
  } catch {
    return result('unknown', httpStatus, controller.signal.aborted ? signal?.aborted ? 'aborted' : 'timed_out' : failure);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
