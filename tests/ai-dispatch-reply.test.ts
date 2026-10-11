import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dispatchAiReceptions} from '../src/modules/ai-runs/dispatch.ts';

function fixture(outcome='accepted'){
 const intake=crypto.randomUUID(),answer=crypto.randomUUID(),calls:string[]=[],finishes:unknown[][]=[];
 const scope={organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'controller'};
 const controller={admitAiDispatch:async()=>({outcome:'accepted',answerRunId:answer}),readClassifiedInput:async()=>null,
  enqueueAiReply:async(s:unknown,id:string)=>{assert.deepEqual(s,scope);assert.equal(id,answer);calls.push('enqueue');return {outcome};},
  stopAiDispatch:async()=>{calls.push('stop');return {outcome:'accepted'};}};
 const db={prepare(sql:string){return {bind(...values:unknown[]){return {
  all:async()=>({results:[{...scope,eventId:'event',runId:intake,inputSequence:1,createdAt:Date.now()}]}),
  run:async()=>{if(sql.includes('token=NULL'))finishes.push(values);},
 };}};}};
 const env={DB:db,AI_RECEPTION_ENABLED:'true',AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true',CONVERSATION_CONTROLLER:{idFromName:(id:string)=>id,get:()=>controller}} as any;
 return {env,calls,finishes,intake,answer};
}
test('completed automatic dispatch commits the original AI send receipt without rotating its epoch',async()=>{
 const f=fixture();await dispatchAiReceptions(f.env,{reconcile:async()=>({status:'pending'}),execute:async()=>({status:'completed'})});
 assert.deepEqual(f.calls,['enqueue']);assert.equal(f.finishes.length,1);assert.equal(f.finishes[0][0],null);
});
test('failed or unconfirmed enqueue preserves the existing safe dispatcher fallback',async()=>{
 const f=fixture('unavailable');await dispatchAiReceptions(f.env,{reconcile:async()=>({status:'pending'}),execute:async()=>({status:'completed'})});
 assert.deepEqual(f.calls,['enqueue','stop']);assert.equal(f.finishes[0][0],null);
});
test('pending original answers do not acquire a send receipt or lose their dispatch target',async()=>{
 const f=fixture();await dispatchAiReceptions(f.env,{reconcile:async()=>({status:'pending'}),execute:async(_env,_scope,id)=>({status:id===f.answer?'pending':'completed'})});
 assert.deepEqual(f.calls,[]);assert.equal(typeof f.finishes[0][0],'number');
});
