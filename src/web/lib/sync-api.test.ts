/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStoreSync, setStoreSync } from './sync-api.ts';
import * as syncAPI from './sync-api.ts';

const receipt = { sync: { storeId: 'store', enabled: true, epoch: 3, dueAt: '2026-10-09T00:00:00Z', lastSuccessAt: null,
  blockedUntil: null, lastError: null, failures: 0, conversationCount: 0, messageCount: 0, running: false }, configured: true, wakePending: false };

test('sync mutation receipts must match store, intended state and the next epoch', async t => {
  for (const sync of [{ ...receipt.sync, storeId: 'other' }, { ...receipt.sync, enabled: false }, { ...receipt.sync, epoch: 2 }]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ ...receipt, sync }));
    await assert.rejects(setStoreSync('company', 'store', 2, true), { code: 'OPERATION_UNCONFIRMED' });
    mock.mock.restore();
  }
});

test('sync reads reject a different store and unknown write acknowledgements are not retried', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json(receipt));
  await assert.rejects(readStoreSync('company', 'other'), { code: 'INVALID_RESPONSE' });
  mock.mock.restore();
  const calls: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, body: JSON.parse(String(options.body)) });
    throw new Error('Synthetic lost acknowledgement');
  });
  await assert.rejects(setStoreSync('c/1', 's/1', 2, false), { code: 'OPERATION_UNCONFIRMED' });
  assert.deepEqual(calls, [{ path: '/api/companies/c%2F1/stores/s%2F1/sync', body: { expectedEpoch: 2, enabled: false } }]);
});

test('product sync receipts require the products source, matching store and committed epoch', async t => {
  const read = Reflect.get(syncAPI,'readProductSync') as (company:string,store:string)=>Promise<unknown>;
  const write = Reflect.get(syncAPI,'setProductSync') as (company:string,store:string,epoch:number,enabled:boolean)=>Promise<unknown>;
  assert.equal(typeof read,'function'); assert.equal(typeof write,'function');
  const product = { ...receipt, sync:{...receipt.sync,source:'products',productCount:8,readyCount:5,pendingCount:4,failedCount:1} };
  for (const sync of [{...product.sync,source:'chat'},{...product.sync,storeId:'other'},{...product.sync,epoch:2},{...product.sync,enabled:false}]) {
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...product,sync}));
    await assert.rejects(write('company','store',2,true),{code:'OPERATION_UNCONFIRMED'});
    mock.mock.restore();
  }
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({...product,sync:{...product.sync,source:'chat'}}));
  await assert.rejects(read('company','store'),{code:'INVALID_RESPONSE'}); mock.mock.restore();
  const calls:unknown[]=[];
  t.mock.method(globalThis,'fetch',async(path:string,options:RequestInit)=>{calls.push({path,body:JSON.parse(String(options.body))});throw new Error('Synthetic lost product acknowledgement');});
  await assert.rejects(write('c/1','s/1',2,false),{code:'OPERATION_UNCONFIRMED'});
  assert.deepEqual(calls,[{path:'/api/companies/c%2F1/stores/s%2F1/sync/products',body:{expectedEpoch:2,enabled:false}}]);
});

test('FBS receipts bind source and store and reject stale epochs without repeating requests', async t => {
  const read = Reflect.get(syncAPI,'readFbsSync') as (company:string,store:string)=>Promise<unknown>;
  const write = Reflect.get(syncAPI,'setFbsSync') as (company:string,store:string,epoch:number,enabled:boolean)=>Promise<unknown>;
  assert.equal(typeof read,'function'); assert.equal(typeof write,'function');
  const fbs = {...receipt,sync:{...receipt.sync,source:'fbs_postings',postingCount:2,readyCount:2,pendingCount:0,failedCount:0,
    historyStart:'2026-09-09T00:00:00Z',windowSince:'2026-09-09T00:00:00Z',windowTo:'2026-10-09T00:00:00Z',lastCompletedTo:null}};
  for (const sync of [{...fbs.sync,source:'products'},{...fbs.sync,storeId:'other'},{...fbs.sync,epoch:2},{...fbs.sync,enabled:false}]) {
    const mock = t.mock.method(globalThis,'fetch',async()=>Response.json({...fbs,sync}));
    await assert.rejects(write('company','store',2,true),{code:'OPERATION_UNCONFIRMED'}); mock.mock.restore();
  }
  const mock = t.mock.method(globalThis,'fetch',async()=>Response.json({...fbs,sync:{...fbs.sync,source:'products'}}));
  await assert.rejects(read('company','store'),{code:'INVALID_RESPONSE'}); mock.mock.restore();
  const calls:unknown[]=[];
  t.mock.method(globalThis,'fetch',async(path:string,options:RequestInit)=>{calls.push({path,body:JSON.parse(String(options.body))});throw new Error('Synthetic lost FBS acknowledgement');});
  await assert.rejects(write('c/1','s/1',2,false),{code:'OPERATION_UNCONFIRMED'});
  assert.deepEqual(calls,[{path:'/api/companies/c%2F1/stores/s%2F1/sync/fbs-postings',body:{expectedEpoch:2,enabled:false}}]);
});
