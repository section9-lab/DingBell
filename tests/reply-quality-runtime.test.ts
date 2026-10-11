import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReplyQuality,checkReplyQuality } from '../probes/reply-quality/evaluate.ts';
import {replyTestSampling} from '../src/modules/reply-tests/output.ts';
async function api(){const m=await import('../probes/reply-quality/runtime.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.runReplyQualityCase,'function','evaluation must use bounded native Flue with durable attempt capture');return m!;}
test('native evaluation uses the production prompt and SSE evidence, captures before one HTTP and disables task execution',{timeout:30000},async t=>{
  const m=await api(),directory=await mkdtemp(join(tmpdir(),'dingbell-quality-'));t.after(()=>rm(directory,{recursive:true,force:true}));const plan=await prepareReplyQuality(),item=plan.cases[0],events:any[]=[],requests:any[]=[];
  const output=JSON.stringify({kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:item.input.untrustedKnowledge[0].chunkId,quote:'26 см.'}]});
  const result=await m.runReplyQualityCase({plan,item,repeat:1,database:join(directory,'flue.sqlite'),apiKey:'synthetic',origin:'synthetic',capture:async e=>{events.push(e);},send:async(input,init)=>{
    assert.equal(events.at(-1).phase,'attempt');assert.equal(String(input),'https://integrate.api.nvidia.com/v1/chat/completions');const body=JSON.parse(String(init?.body));requests.push(body);
    assert.equal(body.tool_choice,'none');assert.equal(body.tools,undefined);assert.equal(body.stream,true);assert.equal(body.max_tokens??body.max_completion_tokens,2048);assert.equal(body.chat_template_kwargs.enable_thinking,false);
    return new Response([{choices:[{index:0,delta:{role:'assistant',content:output},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}].map(x=>`data: ${JSON.stringify({id:'synthetic',object:'chat.completion.chunk',created:1,model:plan.model,...x})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  }});
  const text=(content:any)=>typeof content==='string'?content:content.map((part:any)=>part.text??'').join('');
  assert.equal(requests.length,1);assert.ok(requests[0].messages.some((x:any)=>x.role==='system'&&text(x.content).includes(plan.instructions)),'application prompt must reach the provider');assert.ok(requests[0].messages.some((x:any)=>x.role==='user'&&text(x.content).includes(item.input.question)),'question must reach the provider');assert.equal(result.status,'completed');assert.equal(result.evidence!.usageReported,true);assert.equal(result.evidence!.usage!.output,8);assert.equal(checkReplyQuality(item,result.output).contractPassed,true);assert.deepEqual(events.map(e=>e.phase),['started','attempt','result']);
});
test('capture failure prevents network and a provider failure is recorded once without an automatic retry',{timeout:30000},async t=>{
  const m=await api(),directory=await mkdtemp(join(tmpdir(),'dingbell-quality-'));t.after(()=>rm(directory,{recursive:true,force:true}));const plan=await prepareReplyQuality(),item=plan.cases[0];let calls=0;const events:any[]=[];
  const options={plan,item,repeat:1,apiKey:'synthetic',origin:'synthetic' as const,database:join(directory,'flue.sqlite'),send:async()=>{calls++;throw new Error('synthetic sensitive provider detail');}};
  await assert.rejects(()=>m.runReplyQualityCase({...options,capture:async()=>{throw new Error('capture unavailable');}}),/capture unavailable/);assert.equal(calls,0);
  const result=await m.runReplyQualityCase({...options,capture:async e=>{events.push(e);}});assert.equal(calls,1);assert.equal(result.status,'unknown');assert.equal(result.httpRequests,1);assert.equal(JSON.stringify(events).includes('sensitive provider detail'),false);
});
test('structured evaluation sends the versioned schema through native Flue and rejects altered constraints before HTTP',{timeout:30000},async t=>{
  const m=await api(),directory=await mkdtemp(join(tmpdir(),'dingbell-guided-'));t.after(()=>rm(directory,{recursive:true,force:true}));const plan=await prepareReplyQuality('grounded-reply-v2','nvidia-reply-test-v2'),item=plan.cases[0];let calls=0;
  const options={plan,item,repeat:1,apiKey:'synthetic',origin:'synthetic' as const,database:join(directory,'flue.sqlite'),capture:async()=>{},send:async(input:unknown,init?:RequestInit)=>{
    calls++;const body=JSON.parse(String(init?.body));assert.deepEqual(body.guided_json,replyTestSampling('nvidia-reply-test-v2').guided_json);assert.equal(body.tools,undefined);
    return new Response('schema unsupported',{status:400});
  }};
  const altered=structuredClone(plan);(altered.samplingParams!.guided_json as any).oneOf=[];
  await assert.rejects(()=>m.runReplyQualityCase({...options,plan:altered}),/REPLY_QUALITY_OUTPUT_CONSTRAINT_CHANGED/);assert.equal(calls,0);
  const result=await m.runReplyQualityCase(options);assert.equal(calls,1);assert.equal(result.status,'unknown');assert.deepEqual(result.httpStatuses,[400]);assert.equal(result.evidence,null,'unsupported schema must never fall back to unconstrained generation');
});
