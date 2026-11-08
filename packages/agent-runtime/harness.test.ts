import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { context, loopSteps, openAgent, providerId, readResult } from './harness.ts';
import type { EntryRecord } from '@earendil-works/pi-durable';
import type { AgentAuthority, AgentDefinition, AgentReceipt } from './contracts.ts';

test('Pi business tool termination is a successful original submission without a second model call',async()=>{
  const definition:AgentDefinition={uid:'fixture',kind:'support',requestId:'original',acceptedAt:new Date().toISOString(),input:'untrusted question',instructions:'Use finish_fixture.',modelId:'nvidia/nemotron-3-super-120b-a12b',maxOutputTokens:512,
    tools:[{name:'finish_fixture',description:'Finish the synthetic task.',parameters:{type:'object',properties:{},additionalProperties:false},timeoutMs:1000}]};
  let calls=0,tools=0,receipt:AgentReceipt|null=null;
  const authority:AgentAuthority={async describe(){return definition;},async apiKey(){return 'synthetic';},async bind(_uid,value){receipt=value;},async receipt(){return receipt;},async metadata(){return{};},
    async tool(){tools++;return{output:{canSend:false},terminate:true};},async provider(){calls++;return new Response([
      {id:'fixture',object:'chat.completion.chunk',created:1,model:definition.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'tool',type:'function',function:{name:'finish_fixture',arguments:'{}'}}]},finish_reason:'tool_calls'}]},
      {choices:[],usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}},
    ].map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}};
  const harness=await openAgent(new MemoryStorage(),definition,authority);
  try{
    const root=await harness.root(context,{agent:{model:{provider:providerId,modelId:definition.modelId},instructions:definition.instructions}});
    const submission=await root.submit({type:'input',content:definition.input,requestId:definition.requestId},context);await submission.wait(context);
    const result=await readResult(harness,definition.uid,String(submission.id),authority);
    assert.equal(result.outcome,'completed',JSON.stringify(await submission.status(context)));assert.equal(calls,1);assert.equal(tools,1);
  }finally{await harness.close(context);}
});

test('the Agent loop view keeps thinking, tool calls and answer text in commit order',()=>{
  const entries=[
    {id:1,conversationId:1,kind:'pi.user',model:[{role:'user',content:'question'}]},
    {id:2,conversationId:1,kind:'pi.assistant',model:[{role:'assistant',content:[
      {type:'thinking',thinking:'look at knowledge'},
      {type:'toolCall',id:'c1',name:'bash',arguments:{command:'ls /knowledge'}},
    ]}]},
    {id:3,conversationId:1,kind:'pi.tool-result',model:[{role:'toolResult',toolCallId:'c1',toolName:'bash',content:[{type:'text',text:'faq.md'}],isError:false,timestamp:1}]},
    {id:4,conversationId:1,kind:'pi.assistant',model:[{role:'assistant',content:[{type:'text',text:'Шляпы доступны.'}]}]},
  ] as unknown as EntryRecord[];
  const loop=loopSteps(entries);
  assert.deepEqual(loop.steps.map(step=>[step.kind,step.kind==='tool'?step.name:step.text]),[
    ['thinking','look at knowledge'],['tool','bash'],['answer','Шляпы доступны.'],
  ]);
  const tool=loop.steps[1];
  assert.equal(tool.kind,'tool');
  if(tool.kind==='tool'){assert.equal(tool.input,'{"command":"ls /knowledge"}');assert.equal(tool.output,'faq.md');assert.equal(tool.failed,false);}
  assert.equal(loop.truncated,false);
});
