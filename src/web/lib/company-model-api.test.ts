/// <reference types="node" />
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {listCompanyModels} from './company-model-api.ts';
const body={expectedVersion:0,baseUrl:'https://api.openai.com/v1',apiKey:'synthetic-provider-key'};
const result={companyId:'company',version:0,baseUrl:body.baseUrl,models:['chat'],truncated:false};
test('model catalog client binds company, draft version, endpoint and bounded model IDs',async t=>{
 for(const response of [{...result,companyId:'other'},{...result,version:1},{...result,baseUrl:'https://api.deepseek.com/v1'},{...result,models:['']},{...result,models:Array(2001).fill('chat')}]){
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(response));
  await assert.rejects(listCompanyModels('company',body),{code:'MODEL_CATALOG_UNAVAILABLE'});mock.mock.restore();
 }
 const calls:{path:string;body:unknown}[]=[];t.mock.method(globalThis,'fetch',async(path:string,init:RequestInit)=>{calls.push({path,body:JSON.parse(String(init.body))});return Response.json(result);});
 assert.deepEqual(await listCompanyModels('company',body),result);
 assert.deepEqual(calls,[{path:'/api/companies/company/settings/ai-model/models',body}]);
});
test('failed model-list POSTs are read failures, not uncertain configuration writes and never retry',async t=>{
 let calls=0;const mock=t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('synthetic offline');});
 await assert.rejects(listCompanyModels('company',body),{code:'MODEL_CATALOG_UNAVAILABLE'});assert.equal(calls,1);mock.mock.restore();
 t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'MODEL_CATALOG_UNSUPPORTED'}},{status:502}));
 await assert.rejects(listCompanyModels('company',body),{code:'MODEL_CATALOG_UNSUPPORTED'});
});
