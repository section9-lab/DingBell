import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewFetch,PREVIEW_ENDPOINT,type PreviewEvidence } from '../src/modules/translations/transport.ts';

const usage={prompt_tokens:12,completion_tokens:3,total_tokens:15,prompt_tokens_details:{cached_tokens:2,cache_write_tokens:1}};
function sse(value:unknown=usage,options:{finish?:string;tools?:boolean;done?:boolean;content?:string}={}){
  const chunks=[{id:'synthetic',choices:[{index:0,delta:{content:options.content??'Здравствуйте!',...(options.tools?{tool_calls:[{id:'t',function:{name:'bad',arguments:'{}'}}]}:{})},finish_reason:options.finish??'stop'}]},
    ...(value===undefined?[]:[{id:'synthetic',choices:[],usage:value}])];
  return chunks.map(chunk=>`data: ${JSON.stringify(chunk)}\n\n`).join('')+(options.done===false?'':'data: [DONE]\n\n');
}
function setup(body=sse(),status=200,allowed=true){
  const evidence:PreviewEvidence[]=[];let claims=0,spends=0,calls=0,redirect:unknown;
  const send:typeof fetch=async(_input,init)=>{calls++;redirect=init?.redirect;return new Response(body,{status,headers:{'content-type':'text/event-stream',location:'https://example.invalid'}});};
  const transport=previewFetch({claim:async()=>{claims++;return allowed;},spend(){spends++;},record(value){evidence.push(value);}},send);
  return {transport,evidence,count:()=>({claims,spends,calls,redirect})};
}
const request={method:'POST',body:'{}'};
test('fixed model transport preserves bytes and records only genuinely reported valid usage',async()=>{
  const f=setup();const response=await f.transport(PREVIEW_ENDPOINT,request);assert.equal(await response.text(),sse());
  assert.deepEqual(f.count(),{claims:1,spends:1,calls:1,redirect:'manual'});
  assert.deepEqual(f.evidence,[{usage:{input:9,output:3,cacheRead:2,cacheWrite:1},usageReported:true,output:'Здравствуйте!',finishReason:'stop',tools:false,complete:true}]);
});
test('missing, zero, malformed and inconsistent usage never becomes a free reported result',async()=>{
  for(const value of [null,{}, {prompt_tokens:0,completion_tokens:0,total_tokens:0}, {...usage,prompt_tokens:-1}, {...usage,total_tokens:99}, {...usage,prompt_tokens_details:{cached_tokens:100}}, {...usage,completion_tokens:1.5}]){
    const f=setup(sse(value));await f.transport(PREVIEW_ENDPOINT,request);assert.equal(f.evidence[0]?.usageReported,false);assert.equal(f.evidence[0]?.usage,null);
  }
  const f=setup('data: {"choices":[{"delta":{"content":"Привет"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');await f.transport(PREVIEW_ENDPOINT,request);assert.equal(f.evidence[0]?.usageReported,false);
});
test('unsupported cache aliases are not silently charged as uncached input',async()=>{
  for(const key of ['prompt_cache_hit_tokens','cached_tokens']){
    const f=setup(sse({...usage,[key]:4}));await f.transport(PREVIEW_ENDPOINT,request);
    assert.equal(f.evidence[0]?.usageReported,false);assert.equal(f.evidence[0]?.usage,null);
  }
});
test('endpoint, method and abort reject before acquiring the irreversible permission',async()=>{
  for(const [url,init]of [['https://example.invalid',request],[PREVIEW_ENDPOINT,{method:'GET'}],[PREVIEW_ENDPOINT,{...request,signal:AbortSignal.abort()}]]as const){
    const f=setup();await assert.rejects(f.transport(url,init));assert.equal(f.count().calls,0);assert.equal(f.count().claims,0);
  }
});
test('denied permission cannot call the provider and there is no transport retry',async()=>{
  const f=setup(sse(),200,false);await assert.rejects(f.transport(PREVIEW_ENDPOINT,request));assert.equal(f.count().calls,0);
  let calls=0;const transport=previewFetch({claim:async()=>true,spend(){},record(){}},async()=>{calls++;throw new Error('lost response');});
  await assert.rejects(transport(PREVIEW_ENDPOINT,request));assert.equal(calls,1);
});
test('redirects and oversized or malformed responses stop without following or repairing',async()=>{
  for(const f of [setup('',302),setup('x'.repeat(1_048_577)),setup('data: invalid-json\n\n'),setup(sse(),500)]){
    await assert.rejects(f.transport(PREVIEW_ENDPOINT,request));assert.equal(f.count().calls,1);assert.equal(f.evidence.length,0);
  }
});
test('stream completion, stop reason and tool evidence are preserved for deterministic output validation',async()=>{
  const f=setup(sse(usage,{finish:'length',done:false}));await f.transport(PREVIEW_ENDPOINT,request);
  assert.equal(f.evidence[0]?.finishReason,'length');assert.equal(f.evidence[0]?.tools,false);assert.equal(f.evidence[0]?.complete,false);
});
test('even an unsolicited framework tool is never delivered to the SDK for execution',async()=>{
  const f=setup(sse(usage,{tools:true}));await assert.rejects(f.transport(PREVIEW_ENDPOINT,request),/PREVIEW_TOOLS_REJECTED/);
  assert.equal(f.evidence[0]?.tools,true);assert.equal(f.evidence[0]?.usageReported,true);assert.equal(f.count().calls,1);
});
