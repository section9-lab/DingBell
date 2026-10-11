declare const DINGBELL_TEST_STORE_CHECKER: string;

export const syntheticStoreFetch = (async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://api-seller.ozon.ru' || request.method !== 'POST' || !['/v1/roles', '/v3/product/list', '/v3/product/info/list', '/v3/chat/list', '/v3/chat/history', '/v4/posting/fbs/list', '/v3/posting/fbs/get', '/v1/chat/send/message'].includes(url.pathname)) throw new Error('Unexpected synthetic connector destination');
  if (url.pathname === '/v1/chat/send/message' && request.redirect !== 'manual') throw new Error('Synthetic sends must refuse redirects');
  // Preserve numeric ID tokens; never forward the synthetic credential headers.
  return fetch(DINGBELL_TEST_STORE_CHECKER, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: request.signal,
    body: JSON.stringify({ method: request.method, path: url.pathname, bodySource: await request.text() }),
  });
}) as typeof fetch;
