import { request } from './api.ts';
import * as v from 'valibot';

const count = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const state = v.object({
  storeId: v.string(), enabled: v.boolean(), epoch: count, dueAt: v.string(), lastSuccessAt: v.nullable(v.string()),
  blockedUntil: v.nullable(v.string()),
  lastError: v.nullable(v.string()), failures: count, conversationCount: count, messageCount: count, running: v.boolean(),
});
const productState = v.object({
  storeId: v.string(), source: v.literal('products'), enabled: v.boolean(), epoch: count, dueAt: v.string(), lastSuccessAt: v.nullable(v.string()),
  blockedUntil: v.nullable(v.string()), lastError: v.nullable(v.string()), failures: count, running: v.boolean(),
  productCount: count, readyCount: count, pendingCount: count, failedCount: count,
});
const fbsState = v.object({
  storeId: v.string(), source: v.literal('fbs_postings'), enabled: v.boolean(), epoch: count, dueAt: v.string(), lastSuccessAt: v.nullable(v.string()),
  blockedUntil: v.nullable(v.string()), lastError: v.nullable(v.string()), failures: count, running: v.boolean(),
  postingCount: count, readyCount: count, pendingCount: count, failedCount: count,
  historyStart: v.nullable(v.string()), windowSince: v.nullable(v.string()), windowTo: v.nullable(v.string()), lastCompletedTo: v.nullable(v.string()),
});
const receipt = (storeId: string) => v.pipe(state, v.check(value => value.storeId === storeId));
export type SyncState = v.InferOutput<typeof state>;
export type ProductSyncState = v.InferOutput<typeof productState>;
export type FbsSyncState = v.InferOutput<typeof fbsState>;
const path = (companyId: string, storeId: string) => `/api/companies/${encodeURIComponent(companyId)}/stores/${encodeURIComponent(storeId)}/sync`;
export function readStoreSync(companyId: string, storeId: string, signal?: AbortSignal) {
  return request(path(companyId, storeId), v.object({ sync: receipt(storeId), configured: v.boolean() }), { signal });
}
export function setStoreSync(companyId: string, storeId: string, expectedEpoch: number, enabled: boolean) {
  return request(path(companyId, storeId), v.object({
    sync: v.pipe(receipt(storeId), v.check(value => value.epoch === expectedEpoch + 1 && value.enabled === enabled)),
    configured: v.boolean(), wakePending: v.boolean(),
  }), { method: 'POST', body: JSON.stringify({ expectedEpoch, enabled }) });
}
export function readProductSync(companyId: string, storeId: string, signal?: AbortSignal) {
  return request(`${path(companyId, storeId)}/products`, v.object({
    sync: v.pipe(productState, v.check(value => value.storeId === storeId)), configured: v.boolean(),
  }), { signal });
}
export function setProductSync(companyId: string, storeId: string, expectedEpoch: number, enabled: boolean) {
  return request(`${path(companyId, storeId)}/products`, v.object({
    sync: v.pipe(productState, v.check(value => value.storeId === storeId && value.epoch === expectedEpoch + 1 && value.enabled === enabled)),
    configured: v.boolean(), wakePending: v.boolean(),
  }), { method: 'POST', body: JSON.stringify({ expectedEpoch, enabled }) });
}
export function readFbsSync(companyId: string, storeId: string, signal?: AbortSignal) {
  return request(`${path(companyId, storeId)}/fbs-postings`, v.object({
    sync: v.pipe(fbsState, v.check(value => value.storeId === storeId)), configured: v.boolean(),
  }), { signal });
}
export function setFbsSync(companyId: string, storeId: string, expectedEpoch: number, enabled: boolean) {
  return request(`${path(companyId, storeId)}/fbs-postings`, v.object({
    sync: v.pipe(fbsState, v.check(value => value.storeId === storeId && value.epoch === expectedEpoch + 1 && value.enabled === enabled)),
    configured: v.boolean(), wakePending: v.boolean(),
  }), { method: 'POST', body: JSON.stringify({ expectedEpoch, enabled }) });
}
