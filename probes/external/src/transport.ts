import type { ProbeLedger } from './ledger.ts';
import { endpoint } from './constants.ts';

export function probeFetch(ledger: () => ProbeLedger, send: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== endpoint) throw new Error('The external probe endpoint is not allowed.');
    ledger().spend('http');
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeout = AbortSignal.timeout(45_000);
    const response = await send(input, { ...init, redirect: 'manual', signal: parent ? AbortSignal.any([parent, timeout]) : timeout });
    ledger().record('http', { status: response.status, streaming: response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream' });
    if (response.status >= 300 && response.status < 400) throw new Error('The external probe rejects redirects.');
    return response;
  };
}

