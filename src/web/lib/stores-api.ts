import * as v from 'valibot';
import { request } from './api.ts';

const revision = v.pipe(v.number(), v.integer(), v.minValue(1));
const storeSchema = v.object({
  id: v.string(), name: v.string(), platform: v.literal('ozon'), platformStoreId: v.string(),
  status: v.picklist(['unverified', 'verified', 'partial', 'attention', 'paused', 'disconnected']),
  revision, credentialVersion: revision, hasCredentials: v.boolean(), checking: v.boolean(),
  capabilities: v.array(v.object({ code: v.string(), status: v.picklist(['unknown', 'available', 'denied', 'unsupported']), reason: v.string() })),
  checkedAt: v.nullable(v.string()), expiresAt: v.nullable(v.string()),
});
export type StoreRecord = v.InferOutput<typeof storeSchema>;
const path = (companyId: string, storeId?: string) => `/api/companies/${encodeURIComponent(companyId)}/stores${storeId ? `/${encodeURIComponent(storeId)}` : ''}`;
const receipt = (storeId: string) => v.object({ store: v.pipe(storeSchema, v.check(store => store.id === storeId)) });

export function readStores(companyId: string, offset = 0, signal?: AbortSignal) {
  return request(`${path(companyId)}?offset=${offset}`, v.object({ stores: v.array(storeSchema), configured: v.boolean(), nextOffset: v.nullable(v.number()) }), { signal });
}
export function readStore(companyId: string, storeId: string, signal?: AbortSignal) {
  return request(path(companyId, storeId), receipt(storeId), { signal });
}
export function createStore(companyId: string, body: { id: string; name: string; clientId: string; apiKey: string }) {
  return request(path(companyId), receipt(body.id), { method: 'POST', body: JSON.stringify(body) });
}
type StoreActions = {
  state: { expectedRevision: number; state: 'paused' | 'unverified' | 'disconnected' };
  credentials: { expectedRevision: number; apiKey: string };
  check: { expectedRevision: number };
};
export function updateStore<A extends keyof StoreActions>(companyId: string, storeId: string, action: A, body: StoreActions[A]) {
  return request(`${path(companyId, storeId)}/${action}`, receipt(storeId), { method: 'POST', body: JSON.stringify(body) });
}
export function readStoreGrants(companyId: string, storeId: string, offset = 0, signal?: AbortSignal) {
  return request(`${path(companyId, storeId)}/grants?offset=${offset}`, v.object({
    members: v.array(v.object({ memberId: v.string(), name: v.string(), email: v.string(), role: v.string(), granted: v.boolean() })),
    nextOffset: v.nullable(v.number()),
  }), { signal });
}
export function setStoreGrant(companyId: string, storeId: string, memberId: string, expectedGranted: boolean, granted: boolean) {
  return request(`${path(companyId, storeId)}/grants/${encodeURIComponent(memberId)}`, v.object({ memberId: v.literal(memberId), granted: v.literal(granted) }), {
    method: 'POST', body: JSON.stringify({ expectedGranted, granted }),
  });
}
