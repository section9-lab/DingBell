import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as api from './knowledge-api.ts';
import { ApiError } from './api.ts';

const id='10000000-0000-8000-8000-000000000001';
const scope={kind:'guide',storeId:null,productRef:null,language:'en'};
const file=new File(['verified content'],'notes.txt',{type:'text/plain'});
const preview={companyId:'company',scope,file:{name:file.name,format:'text',bytes:file.size,sha256:'a'.repeat(64)},manifestHash:'b'.repeat(64),
  entries:[{documentId:id,title:'Notes',source:{format:'text',content:'verified content'},contentHash:'c'.repeat(64),exists:false}]};
const method=(name:string)=>{const fn=(api as unknown as Record<string,(...args:any[])=>Promise<any>>)[name];assert.equal(typeof fn,'function',`${name} is available`);return fn;};
test('file requests use multipart, bind company/scope/file and confirm the exact preview with no automatic retries',async t=>{
  const calls:RequestInit[]=[];let result:unknown=preview;
  t.mock.method(globalThis,'fetch',async(_url:string,init:RequestInit)=>{calls.push(init);return Response.json(result);});
  const read=method('previewKnowledgeUpload'),write=method('importKnowledgeUpload');
  assert.deepEqual(await read('company',file,scope,'Notes'),preview);
  assert.ok(calls[0].body instanceof FormData);assert.equal(new Headers(calls[0].headers).has('content-type'),false);
  result={...preview,entries:preview.entries.map(entry=>({...entry,exists:true}))};
  await write('company',file,'Notes',preview);
  assert.equal((calls[1].body as FormData).get('manifestHash'),preview.manifestHash);
  for(const wrong of [{companyId:'other'},{scope:{...scope,storeId:'foreign'}},{file:{...preview.file,name:'other.txt'}},{entries:[...preview.entries,...preview.entries]}]) {
    result={...preview,...wrong};await assert.rejects(()=>read('company',file,scope,'Notes'),ApiError);
  }
  result={...preview,manifestHash:'d'.repeat(64)};await assert.rejects(()=>write('company',file,'Notes',preview),ApiError);
  let attempts=0;t.mock.method(globalThis,'fetch',async()=>{attempts++;throw new Error('lost response');});
  await assert.rejects(()=>write('company',file,'Notes',preview),(e:unknown)=>e instanceof ApiError&&e.code==='OPERATION_UNCONFIRMED');assert.equal(attempts,1);
});
test('file validation errors expose only the safe record number and preview failures do not claim a possible write',async t=>{
  t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'KNOWLEDGE_FILE_CONTENT',row:3,message:'untrusted content'}},{status:400}));
  await assert.rejects(()=>method('previewKnowledgeUpload')('company',file,scope,'Notes'),(e:unknown)=>e instanceof ApiError&&e.message.includes('第 3 条')&&!e.message.includes('untrusted'));
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('offline');});
  await assert.rejects(()=>method('previewKnowledgeUpload')('company',file,scope,'Notes'),(e:unknown)=>e instanceof ApiError&&e.code==='KNOWLEDGE_FILE_PREVIEW_FAILED');
});
