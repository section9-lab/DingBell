import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './knowledge-api.ts';
import { ApiError } from './api.ts';

const id='10000000-0000-8000-8000-000000000001',snapshotId='20000000-0000-4000-8000-000000000001';
const preview={companyId:'company',documentId:id,source:{storeId:'store',productId:'1001',snapshotId,observedAt:1},expectedVersion:0,
  scope:{kind:'product',storeId:'store',productRef:'1001',language:'ru'},draft:{title:'Name',source:{format:'product',facts:[{label:'Name',value:'Verified name'}]}},
  importedRevision:null,currentDraft:null,activeRevision:null};
const method=(name:string)=>{const value=(api as unknown as Record<string,(...args:any[])=>Promise<any>>)[name];assert.equal(typeof value,'function',`${name} is available`);return value;};

test('product import requests bind the previewed source and current draft without sending editable knowledge content',async t=>{
  let body:unknown=preview;const calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(body);});
  const read=method('readKnowledgeProductPreview'),write=method('importKnowledgeProduct');
  assert.deepEqual(await read('company',{storeId:'store',productId:'1001',language:'ru'}),preview);
  assert.equal(new URL(calls[0].url,'https://example.invalid').searchParams.get('productId'),'1001');
  body={companyId:'company',documentId:id,revision:1,status:'imported'};
  await write('company',preview);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)),{storeId:'store',productId:'1001',language:'ru',snapshotId,expectedVersion:0});
  assert.equal(calls[1].init.method,'POST');
});

test('product import responses reject changed scopes and unknown writes are never resubmitted automatically',async t=>{
  let body:unknown=preview;let writes=0;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{if(init.method==='POST'){writes++;throw new TypeError('synthetic lost acknowledgement');}return Response.json(body);});
  const read=method('readKnowledgeProductPreview');
  for(const changed of [{companyId:'other'},{scope:{...preview.scope,productRef:'1002'}},{source:{...preview.source,storeId:'other'}},{expectedVersion:0,importedRevision:1}]){
    body={...preview,...changed};await assert.rejects(()=>read('company',{storeId:'store',productId:'1001',language:'ru'}));
  }
  await assert.rejects(()=>method('importKnowledgeProduct')('company',preview),(error:unknown)=>error instanceof ApiError&&error.code==='OPERATION_UNCONFIRMED');assert.equal(writes,1);
});
