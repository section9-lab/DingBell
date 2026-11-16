import { writeOzonJSON, OzonReadError, type Credentials } from './read.ts';

/**
 * Ozon 卖家后台的 Push 订阅：把本应用的回调地址登记到卖家账号上。
 * 契约来自 dev.ozon.ru 的 Notification 接口（beta）：
 *   POST /v1/notification/list   → { urls: [{ id, url, enable, types: [{type, description}] }] }
 *   POST /v1/notification/set    ← { types, url }
 *   POST /v1/notification/update ← { id, types?, url? }
 *   POST /v1/notification/enable ← { id, enabled }   （登记后必须开启，否则不投递）
 *   POST /v1/notification/delete ← { id }
 *   POST /v1/notification/check  ← { url } → { is_active, errors }
 * 同一个通知类型只能绑定一个 URL：卖家已把聊天类型绑到别的服务时，set 返回
 * 400 "Type already in use: <TYPE>"，必须先让旧订阅释放这些类型（见 takeOver）。
 */
export const chatPushTypes = ['TYPE_NEW_MESSAGE', 'TYPE_UPDATE_MESSAGE', 'TYPE_MESSAGE_READ', 'TYPE_CHAT_CLOSED'] as const;

export type PushRegistration = {
  registered: boolean;
  updated: boolean;
  enabled: boolean;
  isActive: boolean;
  errors: string[];
  /** Subscriptions that had to release these types; empty when nothing was taken over. */
  adopted: { id: number | null; url: string; types: string[] }[];
};

export type PushEntry = { id: number | null; url: string; enable: boolean; types: string[] };

/** Thrown when another URL owns the requested notification types and takeover was not allowed. */
export class PushTypesInUse extends Error {
  readonly conflicts: PushEntry[];
  constructor(conflicts: PushEntry[]) {
    super(conflicts.map(row => `${row.url} (id ${row.id ?? '?'})`).join(', '));
    this.name = 'PushTypesInUse';
    this.conflicts = conflicts;
  }
}

type Entry = PushEntry;

function invalid(): never { throw new OzonReadError('invalid_response'); }
function typeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') { names.push(item); continue; }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const name = (item as Record<string, unknown>).type;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}
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
    const enable = item.enable === true;
    return { id, url: item.url, enable, types: typeNames(item.types) };
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
      return typeof row.description === 'string' ? row.description : typeof row.message === 'string' ? row.message : typeof row.type === 'string' ? row.type : 'unknown_error';
    }
    return 'unknown_error';
  }) : [];
  return { isActive: item.is_active, errors };
}

/** A type can only belong to one URL, so Ozon answers 400 with this message. */
function isTypeConflict(error: unknown): error is OzonReadError {
  return error instanceof OzonReadError && error.code === 'provider_unavailable'
    && error.status === 400 && /already in use/i.test(error.providerMessage ?? '');
}

type Call = (path: '/v1/notification/list' | '/v1/notification/set' | '/v1/notification/update' | '/v1/notification/delete' | '/v1/notification/enable' | '/v1/notification/check', body: string) => Promise<Record<string, unknown>>;

function caller(credentials: Credentials, fetcher: typeof fetch, signal?: AbortSignal): Call {
  // Ozon allows roughly one call per second; retry briefly instead of failing the whole registration.
  return async (path, body) => {
    for (let attempt = 0; ; attempt++) {
      try { return await writeOzonJSON(credentials, path, body, fetcher, signal, { errorDetail: true }); }
      catch (error) {
        if (attempt < 3 && error instanceof OzonReadError && error.code === 'rate_limited') {
          await new Promise(resolve => setTimeout(resolve, Math.min(error.retryAfterMs ?? 1_000, 3_000)));
          continue;
        }
        throw error;
      }
    }
  };
}

async function subscriptions(call: Call): Promise<Entry[]> {
  return entries(await call('/v1/notification/list', '{}'));
}

async function findOurs(call: Call, url: string): Promise<Entry | null> {
  return (await subscriptions(call)).find(row => row.url === url) ?? null;
}

/**
 * Registers (or reuses) this application's callback URL, enables delivery and asks Ozon to verify it.
 * `isActive` is Ozon's verdict on a live handshake; the caller still has to cut over to Push.
 * When another URL owns the requested types the call throws PushTypesInUse unless `takeOver` is set.
 */
export async function registerOzonPushUrl(
  credentials: Credentials,
  url: string,
  fetcher: typeof fetch,
  options: { types?: readonly string[]; takeOver?: boolean; signal?: AbortSignal } = {},
): Promise<PushRegistration> {
  if (url.length > 2048) throw new OzonReadError('invalid_request');
  const wanted = [...(options.types ?? chatPushTypes)];
  if (!wanted.length || wanted.length > 20 || wanted.some(type => !/^TYPE_[A-Z_]{1,64}$/.test(type))) throw new OzonReadError('invalid_request');
  const call = caller(credentials, fetcher, options.signal);
  const first = await subscriptions(call);
  let ours = first.find(row => row.url === url) ?? null;
  let updated = false;
  const adopted: PushRegistration['adopted'] = [];
  if (!ours) {
    const conflicts = first.filter(row => row.types.some(type => wanted.includes(type)));
    if (conflicts.length) {
      if (!options.takeOver) throw new PushTypesInUse(conflicts);
      for (const row of conflicts) {
        if (row.id === null) invalid();
        const freed = row.types.filter(type => !wanted.includes(type));
        // Keep the previous destination for every type this app does not handle.
        if (freed.length) await call('/v1/notification/update', JSON.stringify({ id: row.id, types: freed, url: row.url }));
        else await call('/v1/notification/delete', JSON.stringify({ id: row.id }));
        adopted.push({ id: row.id, url: row.url, types: row.types.filter(type => wanted.includes(type)) });
      }
    }
    await call('/v1/notification/set', JSON.stringify({ types: wanted, url })).catch(async (error: unknown) => {
      // Another client may claim the type between our list and set; report it as a conflict, not an outage.
      if (!isTypeConflict(error)) throw error;
      throw new PushTypesInUse((await subscriptions(call)).filter(row => row.types.some(type => wanted.includes(type))));
    });
    ours = await findOurs(call, url);
    if (!ours) invalid();
  }
  if (ours.id !== null && wanted.some(type => !ours!.types.includes(type))) {
    await call('/v1/notification/update', JSON.stringify({ id: ours.id, types: [...new Set([...ours.types, ...wanted])], url }));
    updated = true;
  }
  // Registered URLs stay disabled until enable is called; without it Ozon never delivers events.
  let enabled = false;
  if (ours.id !== null) {
    await call('/v1/notification/enable', JSON.stringify({ id: ours.id, enabled: true }));
    enabled = true;
  }
  const verified = checkResult(await call('/v1/notification/check', JSON.stringify({ url })));
  return { registered: true, updated, enabled, ...verified, adopted };
}
