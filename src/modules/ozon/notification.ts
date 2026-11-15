import { writeOzonJSON, OzonReadError, type Credentials } from './read.ts';

/**
 * Ozon 卖家后台的 Push 订阅：把本应用的回调地址登记到卖家账号上。
 * 契约来自 dev.ozon.ru 的 Notification 接口（beta）：
 *   POST /v1/notification/list   → { urls: [{ id, url, types }] }
 *   POST /v1/notification/set    ← { types, url }
 *   POST /v1/notification/update ← { id, types?, url? }
 *   POST /v1/notification/check  ← { url } → { is_active, errors }
 * 本应用只处理这些类型；未处理的通知会被忽略而不是报错。
 */
export const chatPushTypes = ['TYPE_NEW_MESSAGE', 'TYPE_UPDATE_MESSAGE', 'TYPE_MESSAGE_READ', 'TYPE_CHAT_CLOSED'] as const;

export type PushRegistration = { registered: boolean; updated: boolean; isActive: boolean; errors: string[] };

type Entry = { id: number | null; url: string; types: string[] };

function invalid(): never { throw new OzonReadError('invalid_response'); }
function entries(value: unknown): Entry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const urls = (value as { urls?: unknown }).urls;
  if (!Array.isArray(urls) || urls.length > 100) invalid();
  return urls.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) invalid();
    const item = row as Record<string, unknown>;
    if (typeof item.url !== 'string' || item.url.length > 2048) invalid();
    // read.ts preserves int64 ids as their original source string, so accept both shapes here.
    const rawId = typeof item.id === 'number' ? String(item.id) : typeof item.id === 'string' ? item.id : '';
    const id = /^[0-9]{1,15}$/.test(rawId) ? Number(rawId) : null;
    const types = Array.isArray(item.types) ? item.types.filter((type): type is string => typeof type === 'string') : [];
    return { id, url: item.url, types };
  });
}
function checkResult(value: unknown): { isActive: boolean; errors: string[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (typeof item.is_active !== 'boolean') invalid();
  const errors = Array.isArray(item.errors) ? item.errors.slice(0, 20).map(error => {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const row = error as Record<string, unknown>;
      return typeof row.message === 'string' ? row.message : typeof row.code === 'string' ? row.code : 'unknown_error';
    }
    return 'unknown_error';
  }) : [];
  return { isActive: item.is_active, errors };
}

/**
 * Registers (or reuses) this application's callback URL and asks Ozon to verify it.
 * `isActive` is Ozon's verdict on a live handshake; the caller still has to cut over to Push.
 */
export async function registerOzonPushUrl(
  credentials: Credentials,
  url: string,
  fetcher: typeof fetch,
  options: { types?: readonly string[]; signal?: AbortSignal } = {},
): Promise<PushRegistration> {
  if (url.length > 2048) throw new OzonReadError('invalid_request');
  const types = [...(options.types ?? chatPushTypes)];
  if (!types.length || types.length > 20 || types.some(type => !/^TYPE_[A-Z_]{1,64}$/.test(type))) throw new OzonReadError('invalid_request');
  const existing = entries(await writeOzonJSON(credentials, '/v1/notification/list', '{}', fetcher, options.signal)).find(row => row.url === url);
  let updated = false;
  if (!existing) {
    await writeOzonJSON(credentials, '/v1/notification/set', JSON.stringify({ types, url }), fetcher, options.signal);
  } else if (existing.id !== null && types.some(type => !existing.types.includes(type))) {
    await writeOzonJSON(credentials, '/v1/notification/update', JSON.stringify({ id: existing.id, types: [...new Set([...existing.types, ...types])], url }), fetcher, options.signal);
    updated = true;
  }
  const verified = checkResult(await writeOzonJSON(credentials, '/v1/notification/check', JSON.stringify({ url }), fetcher, options.signal));
  return { registered: true, updated, ...verified };
}
