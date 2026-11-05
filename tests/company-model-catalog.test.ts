import assert from 'node:assert/strict';
import {test} from 'node:test';
import {listProviderModels,ModelCatalogError} from '../src/modules/company-model/catalog.ts';
const base='https://api.openai.com/v1',key='synthetic-private-catalog-key';
const read=(fetcher:typeof fetch,signal=new AbortController().signal)=>listProviderModels(base,key,fetcher,signal);
const fails=(code:string)=>(error:unknown)=>error instanceof ModelCatalogError&&error.code===code&&!JSON.stringify(error).includes(key);

test('catalog GET returns only bounded, sorted unique model IDs without making inference requests',async()=>{
 let calls=0;
 const result=await read(async(input,init)=>{
  calls++;assert.equal(String(input),base+'/models');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'manual');assert.equal(init?.body,undefined);assert.ok(init?.signal);assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);
  return Response.json({object:'list',data:[{id:'z/chat',name:'DO_NOT_RETAIN',pricing:{free:'do not guess'}},{id:'a-chat'},{id:'a-chat'}]});
 });
 assert.deepEqual(result,{models:['a-chat','z/chat'],truncated:false});assert.equal(calls,1);
 assert.deepEqual(await read(async()=>Response.json({data:[]})),{models:[],truncated:false});
 const large=await read(async()=>Response.json({data:Array.from({length:2001},(_,i)=>({id:`model-${i}`}))}));assert.equal(large.models.length,2000);assert.equal(large.truncated,true);
 assert.equal((await read(async()=>Response.json({data:[{id:'chat'}],has_more:true}))).truncated,true);
});

test('catalog failures are classified without redirects, retries or provider body disclosure',async()=>{
 for(const [status,code] of [[401,'MODEL_CATALOG_UNAUTHORIZED'],[403,'MODEL_CATALOG_UNAUTHORIZED'],[404,'MODEL_CATALOG_UNSUPPORTED'],[405,'MODEL_CATALOG_UNSUPPORTED'],[501,'MODEL_CATALOG_UNSUPPORTED'],[429,'MODEL_CATALOG_RATE_LIMITED'],[302,'MODEL_CATALOG_UNAVAILABLE'],[503,'MODEL_CATALOG_UNAVAILABLE']] as const){
  let calls=0;await assert.rejects(read(async()=>{calls++;return new Response(key,{status,headers:{location:'http://127.0.0.1/'}});}),fails(code));assert.equal(calls,1);
 }
 for(const body of [{models:['chat']},{data:[{name:'chat'}]},{data:[{id:''}]},{data:[{id:'x\ny'}]},{data:[{id:' chat '}]},{data:[{id:'x'.repeat(257)}]},{data:[{id:key}]}])await assert.rejects(read(async()=>Response.json(body)),fails('MODEL_CATALOG_INVALID_RESPONSE'));
 await assert.rejects(read(async()=>new Response('{')),fails('MODEL_CATALOG_INVALID_RESPONSE'));
 await assert.rejects(read(async()=>{throw new Error(key);}),fails('MODEL_CATALOG_UNAVAILABLE'));
});

test('catalog reads bound declared and streamed bytes, honor cancellation and discard interrupted bodies',async()=>{
 let cancelled=false;
 await assert.rejects(read(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-length':String(2*1024*1024+1)}})),fails('MODEL_CATALOG_INVALID_RESPONSE'));assert.equal(cancelled,true);
 await assert.rejects(read(async()=>new Response('x'.repeat(2*1024*1024+1))),fails('MODEL_CATALOG_INVALID_RESPONSE'));
 const controller=new AbortController();let started!:()=>void;
 const bodyStarted=new Promise<void>(resolve=>started=resolve);
 const request=read(async()=>new Response(new ReadableStream({pull(){started();},cancel(){cancelled=true;}})),controller.signal);
 await bodyStarted;controller.abort();await assert.rejects(request,fails('MODEL_CATALOG_UNAVAILABLE'));
 let calls=0;await assert.rejects(read(async()=>{calls++;return Response.json({data:[]});},controller.signal),fails('MODEL_CATALOG_UNAVAILABLE'));assert.equal(calls,0);
});
