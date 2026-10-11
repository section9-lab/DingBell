import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './knowledge-api.ts';
import { ApiError } from './api.ts';
const id='10000000-0000-4000-8000-000000000001';
const gap={jobId:id,caseIndex:0,documentId:id,revision:2,title:'Guide',question:'How?',minimumScore:.7,observedScore:null,createdAt:1,
  kind:'guide',storeId:null,productRef:null,language:'en',state:'pending',proof:null};
const read=()=>{const method=(api as unknown as Record<string,(...args:any[])=>Promise<any>>).readKnowledgeGaps;assert.equal(typeof method,'function');return method;};
test('gap requests preserve filters and reject cross-company, duplicated or incoherent progress responses',async t=>{
  let payload:unknown={companyId:'company',gaps:[gap],nextAfter:null};let url='';
  t.mock.method(globalThis,'fetch',async(path:string)=>{url=path;return Response.json(payload);});
  await read()('company',{storeId:null,language:'en',state:'pending',after:''});
  assert.equal(new URL(url,'https://example.invalid').searchParams.get('storeId'),'');
  for(const result of [{companyId:'foreign',gaps:[gap],nextAfter:null},{companyId:'company',gaps:[gap,gap],nextAfter:null},
    {companyId:'company',gaps:[{...gap,state:'published',proof:null}],nextAfter:null},
    {companyId:'company',gaps:[{...gap,state:'retested',proof:{jobId:id,revision:1}}],nextAfter:null},
    {companyId:'company',gaps:[gap],nextAfter:'bad'}]) {
    payload=result;await assert.rejects(()=>read()('company',{}),(e:unknown)=>e instanceof ApiError&&e.code==='INVALID_RESPONSE');
  }
});
test('gap responses retain the existing finite-score contract and require the next cursor to match a full page',async t=>{
  let payload={companyId:'company',gaps:[{...gap,observedScore:-1.001}],nextAfter:null as string|null};
  t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
  assert.equal((await read()('company')).gaps[0].observedScore,-1.001);
  for(const nextAfter of ['',`${id}:0`]) {payload={...payload,nextAfter};await assert.rejects(()=>read()('company'),ApiError);}
});
test('gap pagination preserves accepted uppercase job UUIDs without rewriting their identity',async t=>{
  const rows=Array.from({length:20},(_,i)=>({...gap,jobId:`ABCDEF00-0000-4000-8000-${String(i).padStart(12,'0')}`}));
  const nextAfter=`${rows[19].jobId}:0`;let url='';
  t.mock.method(globalThis,'fetch',async(path:string)=>{url=path;return Response.json({companyId:'company',gaps:rows,nextAfter});});
  assert.equal((await read()('company',{after:nextAfter})).nextAfter,nextAfter);
  assert.equal(new URL(url,'https://example.invalid').searchParams.get('after'),nextAfter);
});
