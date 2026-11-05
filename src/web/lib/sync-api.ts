import { request } from './api.ts';
import * as v from 'valibot';
import {orderHistorySchema,type OrderHistoryCommand,type PostingSource} from '../../shared/order-history.ts';

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
  history:v.optional(v.nullable(v.pipe(orderHistorySchema,v.check(value=>value.source==='fbs_postings'))),null),
  historyStart: v.nullable(v.string()), windowSince: v.nullable(v.string()), windowTo: v.nullable(v.string()), lastCompletedTo: v.nullable(v.string()),
});
const fboState=v.object({...fbsState.entries,source:v.literal('fbo_postings'),history:v.optional(v.nullable(v.pipe(orderHistorySchema,v.check(value=>value.source==='fbo_postings'))),null)});
const receipt = (storeId: string) => v.pipe(state, v.check(value => value.storeId === storeId));
export type SyncState = v.InferOutput<typeof state>;
export type ProductSyncState = v.InferOutput<typeof productState>;
export type FbsSyncState = v.InferOutput<typeof fbsState>;
export type FboSyncState = v.InferOutput<typeof fboState>;
const fbpState=v.object({...fbsState.entries,source:v.literal('fbp_postings'),history:v.optional(v.nullable(v.pipe(orderHistorySchema,v.check(value=>value.source==='fbp_postings'))),null)});
export type FbpSyncState=v.InferOutput<typeof fbpState>;
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
export function changeOrderHistory(companyId:string,storeId:string,source:PostingSource,body:OrderHistoryCommand){
  return request(`${path(companyId,storeId)}/${source==='fbs_postings'?'fbs-postings':source==='fbo_postings'?'fbo-postings':'fbp-postings'}/history`,v.object({companyId:v.literal(companyId),storeId:v.literal(storeId),source:v.literal(source),history:v.pipe(orderHistorySchema,v.check(value=>value.source===source&&value.commandRevision===body.expectedHistoryRevision+1&&(body.operation==='start'?value.state!=='cancelled'&&Date.parse(value.requestedFrom)<=Date.parse(body.since+'T00:00:00Z'):value.state==='cancelled'))),wakePending:v.boolean()}),{method:'POST',body:JSON.stringify(body)});
}
export function readFbpSync(companyId:string,storeId:string,signal?:AbortSignal){
  return request(`${path(companyId,storeId)}/fbp-postings`,v.object({sync:v.pipe(fbpState,v.check(value=>value.storeId===storeId)),configured:v.boolean()}),{signal});
}
export function setFbpSync(companyId:string,storeId:string,expectedEpoch:number,enabled:boolean){
  return request(`${path(companyId,storeId)}/fbp-postings`,v.object({sync:v.pipe(fbpState,v.check(value=>value.storeId===storeId&&value.epoch===expectedEpoch+1&&value.enabled===enabled)),configured:v.boolean(),wakePending:v.boolean()}),{method:'POST',body:JSON.stringify({expectedEpoch,enabled})});
}
export function readFboSync(companyId:string,storeId:string,signal?:AbortSignal){
  return request(`${path(companyId,storeId)}/fbo-postings`,v.object({sync:v.pipe(fboState,v.check(value=>value.storeId===storeId)),configured:v.boolean()}),{signal});
}
export function setFboSync(companyId:string,storeId:string,expectedEpoch:number,enabled:boolean){
  return request(`${path(companyId,storeId)}/fbo-postings`,v.object({sync:v.pipe(fboState,v.check(value=>value.storeId===storeId&&value.epoch===expectedEpoch+1&&value.enabled===enabled)),configured:v.boolean(),wakePending:v.boolean()}),{method:'POST',body:JSON.stringify({expectedEpoch,enabled})});
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
