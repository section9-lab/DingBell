import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as v from 'valibot';
import type {AiRun} from '../src/modules/conversations/ai-state.ts';
async function api(){const m=await import('../src/modules/conversations/knowledge-tool.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.createKnowledgeTool,'function');return m!;}
function run():AiRun{return {schemaVersion:1,scope:{organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'},request:{runId:crypto.randomUUID(),expectedVersion:0,messageId:'message',policyId:'policy',stage:'presale',language:'ru'},
 admission:{messageId:'message',inputRevision:1,question:'Какая ширина?',policyId:'policy',policyRevision:1,policyConfig:{kind:'automatic',name:'Support',storeIds:['store'],priority:50,stages:['presale'],mode:'automatic',language:'customer',tone:'concise',instructions:''},stage:'presale',language:'ru'},controlEpoch:1,startedAt:1,deadlineAt:60001};}
test('the knowledge tool has no model-selected scope or question and rechecks persisted evidence after durable replay',async()=>{
 const m=await api(),work=run(),evidence={runId:work.request.runId,scope:{storeId:'store',productRef:null,language:'ru'},questionHash:'a'.repeat(64),chunks:[{documentId:crypto.randomUUID(),revision:1,chunkId:'b'.repeat(64),bodyHash:'c'.repeat(64),body:'26 см',title:'Synthetic',contentHash:'d'.repeat(64),score:.8}]};
 let searches=0,reviews=0,valid=true;const tool=m.createKnowledgeTool(work,{async search(scope,id){assert.deepEqual(scope,work.scope);assert.equal(id,work.request.runId);searches++;return {status:'found',canSend:false,evidence};},async review(scope,id,value){assert.deepEqual(scope,work.scope);assert.equal(id,work.request.runId);reviews++;return valid?value:null;}});
 assert.equal(tool.name,'search_knowledge');assert.ok(v.is(tool.input,{}));assert.ok(!v.is(tool.input,{storeId:'foreign'}));assert.ok(!v.is(tool.input,{query:'other customer question'}));
 let saved:unknown;const ctx={data:{},toolCallId:'synthetic',step:{do:async(_name:string,fn:()=>unknown)=>saved??=await fn()},log:{info(){},warn(){},error(){}}};
 const first=await tool.run(ctx as any);assert.equal(first.output.status,'found');assert.equal(first.output.canSend,false);
 assert.equal(JSON.stringify(first.output).includes(work.request.runId),false);assert.equal(JSON.stringify(first.output).includes('questionHash'),false);assert.equal(JSON.stringify(first.output).includes('storeId'),false);
 assert.deepEqual(await tool.run(ctx as any),first);assert.equal(searches,1);assert.equal(reviews,2);valid=false;
 assert.equal((await tool.run(ctx as any)).output.status,'changed');assert.equal(searches,1);
});
