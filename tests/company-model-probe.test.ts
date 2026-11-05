import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {URL} from 'node:url';
import {probeCompanyModel} from '../src/modules/company-model/probe.ts';
import {sealModelKey} from '../src/modules/company-model/security.ts';
import type {ModelRecord} from '../src/modules/company-model/storage.ts';
const env={STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,8).toString('base64')}),STORE_CREDENTIAL_ACTIVE_KEY:'v1'};
const key='synthetic-private-probe-key',baseUrl='https://api.openai.com/v1',model='synthetic-chat';
async function row():Promise<ModelRecord>{return {companyId:'company',revision:1,baseUrl,model,execution:null,...await sealModelKey(env,'company',1,baseUrl,model,key)};}
const stream=(choice:unknown,done=true)=>new Response(`data: ${JSON.stringify({choices:[choice]})}\n\n${done?'data: [DONE]\n\n':''}`,{headers:{'content-type':'text/event-stream'}});
const tool=(name='connection_probe')=>({index:0,delta:{tool_calls:[{index:0,id:'probe',type:'function',function:{name,arguments:'{"ok":true}'}}]},finish_reason:'tool_calls'});

test('test diagnostic migration preserves populated legacy results without guessing old errors',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec('PRAGMA foreign_keys=ON');const directory=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')&&name<'0056').sort())db.exec(readFileSync(new URL(name,directory),'utf8'));
  db.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1); INSERT INTO company_ai_model_test(organization_id,revision,attempt_id,status,tested_at,next_test_at) VALUES('company',3,'original-attempt','failed',1000,2000)");
  db.exec(readFileSync(new URL('0056_model_test_diagnostics.sql',directory),'utf8'));
  const saved=db.prepare('SELECT * FROM company_ai_model_test').get()!;assert.equal(saved.revision,3);assert.equal(saved.attempt_id,'original-attempt');assert.equal(saved.status,'failed');assert.equal(saved.failure_code,null);assert.equal(saved.provider_status,null);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>db.exec("UPDATE company_ai_model_test SET failure_code='raw-provider-error'"));
 }finally{db.close();}
});

test('connection diagnostics retain safe HTTP classifications without exposing bodies or retrying',async()=>{
 const record=await row();
 for(const [status,failureCode] of [[401,'unauthorized'],[403,'forbidden'],[404,'not_found'],[400,'request_rejected'],[422,'request_rejected'],[429,'rate_limited'],[503,'provider_unavailable'],[302,'redirect_refused']] as const){
  let calls=0;
  const result=await probeCompanyModel(env,record,async(input,init)=>{calls++;assert.equal(String(input),baseUrl+'/chat/completions');assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${key}`);assert.equal(Object.hasOwn(JSON.parse(String(init?.body)),'max_tokens'),false);return new Response(key+' raw-provider-details',{status});},new AbortController().signal,async()=>true);
  assert.deepEqual(result,{status:'failed',failureCode,providerStatus:status});assert.equal(calls,1);assert.equal(JSON.stringify(result).includes(key),false);
 }
});

test('connection diagnostics distinguish tool support, truncated output and invalid SSE from HTTP permission errors',async()=>{
 const record=await row(),run=(response:Response)=>probeCompanyModel(env,record,async()=>response,new AbortController().signal,async()=>true);
 assert.deepEqual(await run(stream(tool())),{status:'passed',failureCode:null,providerStatus:200});
 assert.equal((await run(stream({index:0,delta:{reasoning_content:'thinking'},finish_reason:'length'}))).failureCode,'output_limit');
 assert.equal((await run(stream({index:0,delta:{content:'Hello'},finish_reason:'stop'}))).failureCode,'tool_call_missing');
 assert.equal((await run(stream(tool(),false))).failureCode,'invalid_response');
 assert.equal((await run(stream(tool('unexpected_tool')))).failureCode,'tool_call_invalid');
 assert.equal((await run(Response.json({message:'not an SSE response'}))).failureCode,'invalid_response');
 const network=await probeCompanyModel(env,record,async()=>{throw new Error(key);},new AbortController().signal,async()=>true);assert.deepEqual(network,{status:'failed',failureCode:'network_error',providerStatus:null});
});

test('test diagnostics fail closed before network I/O for rejected URLs, unreadable keys or expired deadlines',async t=>{
 const record=await row();let calls=0;const send:typeof fetch=async()=>{calls++;return stream(tool());};
 assert.equal((await probeCompanyModel(env,{...record,baseUrl:'http://127.0.0.1'},send,new AbortController().signal,async()=>true)).failureCode,'url_rejected');
 assert.equal((await probeCompanyModel({...env,STORE_CREDENTIAL_KEYS:'{}'},record,send,new AbortController().signal,async()=>true)).failureCode,'credentials_unavailable');
 t.mock.method(AbortSignal,'timeout',()=>AbortSignal.abort(new DOMException('Timeout','TimeoutError')));
 assert.equal((await probeCompanyModel(env,record,send,new AbortController().signal,async()=>true)).failureCode,'timed_out');assert.equal(calls,0);
});
