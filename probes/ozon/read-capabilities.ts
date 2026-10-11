interface ReadCheck {
  path: string;
  available: boolean;
  httpStatus?: number;
  sampleCount?: number;
  hasNext?: boolean;
  error?: 'http_error' | 'redirect_refused' | 'invalid_response' | 'network_error';
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readOzonCapabilities(
  credentials: { clientId: string; apiKey: string },
  fetcher: typeof fetch = fetch,
  now = new Date(),
) {
  if (!credentials.clientId?.trim() || !credentials.apiKey?.trim()) throw new Error('Ozon configuration is missing.');
  const requests = [
    { path: '/v1/roles', body: {}, field: 'roles' },
    { path: '/v3/product/list', body: { filter: { visibility: 'ALL' }, last_id: '', limit: 1 }, field: 'items' },
    { path: '/v3/chat/list', body: { limit: 1 }, field: 'chats' },
    { path: '/v4/posting/fbs/list', body: {
      filter: { since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to: now.toISOString() }, limit: 1,
    }, field: 'postings' },
  ];
  const checks: ReadCheck[] = [];
  for (const request of requests) {
    const check: ReadCheck = { path: request.path, available: false };
    checks.push(check);
    try {
      const response = await fetcher(`https://api-seller.ozon.ru${request.path}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(15_000),
        headers: { 'Client-Id': credentials.clientId.trim(), 'Api-Key': credentials.apiKey.trim(), 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
      check.httpStatus = response.status;
      if (response.status >= 300 && response.status < 400) check.error = 'redirect_refused';
      else if (!response.ok) check.error = 'http_error';
      else {
        const body = object(await response.json().catch(() => null));
        const data = request.field === 'items' ? object(body.result) : body;
        const items = data[request.field];
        if (!Array.isArray(items)) check.error = 'invalid_response';
        else {
          check.available = true;
          check.sampleCount = items.length;
          if (typeof data.has_next === 'boolean') check.hasNext = data.has_next;
        }
      }
      // Never return upstream error text, headers, identifiers, or customer content.
    } catch {
      check.error = 'network_error';
    }
    if (request.field === 'roles' && !check.available) break;
  }
  return { checkedAt: now.toISOString(), readOnly: true, checks };
}
