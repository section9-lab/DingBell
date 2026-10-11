import assert from 'node:assert/strict';
import {test} from 'node:test';
import {previewFetch,PREVIEW_ENDPOINT} from '../src/modules/translations/transport.ts';
const raw=(names:string[])=>[...names.map((name,i)=>({choices:[{index:0,delta:{tool_calls:[{index:i,id:`t${i}`,type:'function',function:{name,arguments:'{}'}}]},finish_reason:'tool_calls'}]})),{choices:[],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}].map(x=>`data: ${JSON.stringify(x)}\n\n`).join('')+'data: [DONE]\n\n';
const request={method:'POST',body:'{}'};
test('a knowledge-enabled run permits either listed tool, but never multiple or unsolicited calls',async()=>{
 for(const names of [['search_knowledge'],['request_handoff'],['task'],['search_knowledge','request_handoff']]){
  const transport=previewFetch({claim:async()=>true,spend(){},record(){}},async()=>new Response(raw(names),{headers:{'content-type':'text/event-stream'}}),{allowedTools:['request_handoff','search_knowledge']});
  if(names.length===1&&names[0]!=='task')assert.equal(await(await transport(PREVIEW_ENDPOINT,request)).text(),raw(names));
  else await assert.rejects(transport(PREVIEW_ENDPOINT,request),/PREVIEW_TOOLS_REJECTED/);
 }
});
test('only an explicitly allowed single handoff tool reaches the SDK, with bytes and usage preserved',async()=>{
 let evidence:any;const text=raw(['request_handoff']);
 const transport=previewFetch({claim:async()=>true,spend(){},record(v){evidence=v;}},async()=>new Response(text,{headers:{'content-type':'text/event-stream'}}),{allowedTool:'request_handoff'});
 assert.equal(await(await transport(PREVIEW_ENDPOINT,request)).text(),text);assert.equal(evidence.tools,true);assert.equal(evidence.usageReported,true);
});
test('unsupported or mixed tool batches stay rejected even with the handoff allowance',async()=>{
 for(const names of [['task'],['request_handoff','task'],['request_handoff','request_handoff']]){
  let evidence:any;const transport=previewFetch({claim:async()=>true,spend(){},record(v){evidence=v;}},async()=>new Response(raw(names),{headers:{'content-type':'text/event-stream'}}),{allowedTool:'request_handoff'});
  await assert.rejects(transport(PREVIEW_ENDPOINT,request),/PREVIEW_TOOLS_REJECTED/);assert.equal(evidence.usageReported,true);
 }
});
test('the SDK cannot continue before asynchronous usage recording finishes or fails',async()=>{
 const order:string[]=[];const transport=previewFetch({claim:async()=>true,spend(){},async record(){await Promise.resolve();order.push('record');throw new Error('synthetic settlement failed');}},async()=>new Response(raw([]),{headers:{'content-type':'text/event-stream'}}));
 await assert.rejects(transport(PREVIEW_ENDPOINT,request),/synthetic settlement failed/);assert.deepEqual(order,['record']);
});
test('a reused tool slot cannot change identity or smuggle a malformed tool payload',async()=>{
 const tool={index:0,id:'one',type:'function',function:{name:'request_handoff',arguments:'{}'}};
 for(const deltas of [[tool,{index:0,id:'two',function:{arguments:'{}'}}],[{...tool,function:{name:'request_handoff',arguments:{}}}]]){
  const text=deltas.map(t=>`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:[t]}}]})}\n\n`).join('')+'data: [DONE]\n\n';
  const transport=previewFetch({claim:async()=>true,spend(){},record(){}},async()=>new Response(text,{headers:{'content-type':'text/event-stream'}}),{allowedTool:'request_handoff'});
  await assert.rejects(transport(PREVIEW_ENDPOINT,request),/PREVIEW_TOOLS_REJECTED/);
 }
});
