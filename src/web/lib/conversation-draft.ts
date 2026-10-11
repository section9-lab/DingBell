import * as v from 'valibot';
import type { PendingReplyScope, PendingReplyStorage } from './conversation-reply-pending.ts';

type StorageInput = PendingReplyStorage | null | undefined;
type Selector = Pick<PendingReplyScope, 'userId'> & Partial<Omit<PendingReplyScope, 'userId'>>;
type Draft = { state: 'none' } | { state: 'saved'; body: string } | { state: 'unavailable' };
const prefix = 'dingbell:reply-draft:v1:';
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(256), v.check(value => !!value.trim() && value.isWellFormed() && !/[\u0000-\u001f\u007f]/.test(value)));
const scopeSchema = v.strictObject({ userId: identifier, memberId: identifier, companyId: identifier, conversationId: identifier });
const selectorSchema = v.strictObject({ userId: identifier, memberId: v.optional(identifier), companyId: v.optional(identifier), conversationId: v.optional(identifier) });
const bodySchema = v.pipe(v.string(), v.maxLength(1000));
const recordSchema = v.strictObject({ v: v.literal(1), scope: scopeSchema, body: bodySchema });
function keyFor(scope: PendingReplyScope) { return prefix + encodeURIComponent(JSON.stringify([scope.userId, scope.memberId, scope.companyId, scope.conversationId])); }
function keyScope(key: string): PendingReplyScope | null {
  try {
    const parsed = v.safeParse(v.tuple([identifier, identifier, identifier, identifier]), JSON.parse(decodeURIComponent(key.slice(prefix.length))));
    if (!parsed.success) return null;
    const [userId, memberId, companyId, conversationId] = parsed.output, scope = { userId, memberId, companyId, conversationId };
    return keyFor(scope) === key ? scope : null;
  } catch { return null; }
}
export function readReplyDraft(storage: StorageInput, scope: PendingReplyScope): Draft {
  try {
    if (!storage || !v.is(scopeSchema, scope)) return { state: 'unavailable' };
    const key = keyFor(scope), raw = storage.getItem(key);
    if (raw === null) return { state: 'none' };
    if (raw.length > 16_384) return { state: 'unavailable' };
    const parsed = v.safeParse(recordSchema, JSON.parse(raw));
    if (!parsed.success || keyFor(parsed.output.scope) !== key) return { state: 'unavailable' };
    return { state: 'saved', body: parsed.output.body };
  } catch { return { state: 'unavailable' }; }
}
export function saveReplyDraft(storage: StorageInput, scope: PendingReplyScope, body: string): boolean {
  try {
    if (!storage || !v.is(scopeSchema, scope) || !v.is(bodySchema, body)) return false;
    const key = keyFor(scope);
    if (!body) { if (storage.getItem(key) !== null) storage.removeItem(key); return storage.getItem(key) === null; }
    storage.setItem(key, JSON.stringify({ v: 1, scope, body }));
    const result = readReplyDraft(storage, scope); return result.state === 'saved' && result.body === body;
  } catch { return false; }
}
export function clearReplyDrafts(storage: StorageInput, selector: Selector): boolean {
  try {
    if (!storage || !v.is(selectorSchema, selector)) return false;
    const keys: string[] = [], length = storage.length;
    if (!Number.isSafeInteger(length) || length < 0) return false;
    for (let index = 0; index < length; index++) { const key = storage.key(index); if (key?.startsWith(prefix)) keys.push(key); }
    let complete = true;
    for (const key of keys) {
      const scope = keyScope(key); if (!scope) { complete = false; continue; }
      if (!Object.entries(selector).every(([field, value]) => value === undefined || scope[field as keyof PendingReplyScope] === value)) continue;
      storage.removeItem(key); if (storage.getItem(key) !== null) complete = false;
    }
    return complete;
  } catch { return false; }
}
