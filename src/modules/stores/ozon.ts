export const capabilityCodes = ['auth', 'products_read', 'chats_read', 'orders_fbs_read', 'reply', 'proactive_chat'] as const;
export type CapabilityCode = typeof capabilityCodes[number];
export interface StoreCapability {
  code: CapabilityCode;
  status: 'unknown' | 'available' | 'denied' | 'unsupported';
  reason: string;
}

export function unknownCapabilities(reason = 'unverified'): StoreCapability[] {
  return capabilityCodes.map(code => ({ code, status: 'unknown', reason }));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function boundedJSON(response: Response, aborted: Promise<never>) {
  if (!response.body) throw new Error('Invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(response.headers.get('content-length')) > 65_536) throw new Error('Invalid response.');
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > 65_536) throw new Error('Invalid response.');
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return object(JSON.parse(new TextDecoder().decode(bytes)));
  } finally { void reader.cancel().catch(() => {}); }
}

/** Minimal read-only Ozon evidence. No redirects, retries, message bodies or write probes. */
export async function inspectOzonCapabilities(credentials: { clientId: string; apiKey: string }, fetcher: typeof fetch = fetch, now = new Date()): Promise<StoreCapability[]> {
  const controller = new AbortController();
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Deadline exceeded.')), { once: true }));
  const timer = setTimeout(() => controller.abort(), 8_000);
  const results = unknownCapabilities();
  async function check(code: CapabilityCode, path: string, body: unknown, field: string): Promise<StoreCapability> {
    const evidence: StoreCapability = { code, status: 'unknown', reason: 'network_error' };
    try {
      const response = await Promise.race([fetcher(`https://api-seller.ozon.ru${path}`, {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Client-Id': credentials.clientId, 'Api-Key': credentials.apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), aborted]);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) return { code, status: 'denied', reason: response.status === 401 ? 'invalid_credentials' : 'permission_denied' };
        return { code, status: 'unknown', reason: response.status >= 300 && response.status < 400 ? 'redirect_refused' : response.status === 429 ? 'rate_limited' : 'provider_unavailable' };
      }
      evidence.reason = 'invalid_response';
      const value = await boundedJSON(response, aborted);
      const data = field === 'items' ? object(value.result) : value;
      if (!Array.isArray(data[field])) return evidence;
      // Empty lists prove this endpoint can be read, not a complete business workflow.
      if (data[field].some(item => item === null || typeof item !== 'object' || Array.isArray(item))) return evidence;
      return { code, status: 'available', reason: 'read_verified' };
    } catch { return { ...evidence, reason: controller.signal.aborted ? 'timed_out' : evidence.reason }; }
  }
  try {
    results[0] = await check('auth', '/v1/roles', {}, 'roles');
    if (results[0].status !== 'available') return results;
    const reads = await Promise.all([
      check('products_read', '/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1 }, 'items'),
      check('chats_read', '/v3/chat/list', { limit: 1 }, 'chats'),
      check('orders_fbs_read', '/v4/posting/fbs/list', { filter: { since: new Date(now.getTime() - 7 * 86_400_000).toISOString(), to: now.toISOString() }, limit: 1 }, 'postings'),
    ]);
    results.splice(1, 3, ...reads);
    return results;
  } finally { clearTimeout(timer); }
}
