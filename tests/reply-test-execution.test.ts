import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent } from 'agents';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { seedReplyTest } from './fixtures/reply-test.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge,type ReplyTestControlReader } from '../src/modules/reply-tests/service.ts';
import { readControlAccess } from '../src/modules/conversations/control-storage.ts';
import { normalizeControlState } from '../src/modules/conversations/control-state.ts';
import { createReplyTestBudget,setReplyTestBudgetEnabled,reserveReplyTest,claimReplyTestProviderRequest,readReplyTestRun } from '../src/modules/reply-tests/storage.ts';
import type { TranslationConfig } from '../src/modules/translations/types.ts';

async function api(){
  const m=await import('../src/modules/reply-tests/execution.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return null;throw error;});
  assert.equal(typeof m?.executeReplyTest,'function','reserved reply tests must execute through native Flue receipts');return m!;
}
async function fixture(){
  const f=await knowledgeFixture(),actor={orgId:'company',actorUserId:'owner',sessionId:f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!.id as string};
  const seed=await seedReplyTest(f.db,actor,'store-a');await seed.source();
  const control:ReplyTestControlReader=async(scope,caller)=>{
    const access=await readControlAccess(f.db,caller,scope.conversationId);
    return access?.directory?{outcome:'found',view:{viewerMemberId:access.memberId,state:normalizeControlState(access.directory.state),projectionPending:false}}:{outcome:'not_found'};
  };
  const context=await prepareReplyTest(f.db,control,actor,seed.input),evidence=await retrieveReplyTestKnowledge(f.db,seed.index,control,actor,context,seed.embedding);
  const config:TranslationConfig={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'nvidia-reply-test-v1',promptVersion:'grounded-reply-v1',maxInputTokens:262144,maxOutputTokens:2048,
    pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cacheReadMicrosPerMillion:50,cacheWriteMicrosPerMillion:100}};
  await createReplyTestBudget(f.db,actor,{id:'budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000,maxRuns:10});
  await setReplyTestBudgetEnabled(f.db,actor,'budget',0,true);
  const reserved=await reserveReplyTest(f.db,control,actor,{requestId:crypto.randomUUID(),budgetId:'budget',context,evidence},config);assert.equal(reserved.outcome,'reserved');
  const run=reserved.run,receipt={submissionId:'native-submission',uid:'native-uid',acceptedAt:new Date().toISOString()},usage={input:9,output:3,cacheRead:2,cacheWrite:1};
  const candidate={kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:evidence.chunks[0].chunkId,quote:'26 см.'}]};
  let prepared=false,dispatched=false,dispatches=0,requests=0,loseReceipt=false,currentUid:string|null=receipt.uid;
  let result:{outcome:'completed';text:string;metadata:unknown}|{outcome:'pending'}|{outcome:'failed'}={outcome:'completed',text:JSON.stringify(candidate),metadata:{replyTest:{usageReported:true,usage,outputValid:true}}};
  const native={
    lookup:async()=>dispatched&&currentUid?{uid:currentUid}:null,
    inspect:async()=>prepared?{run,generation:requests,http:requests,closed:false,evidence:null}:null,
    prepare:async()=>{prepared=true;},
    dispatch:async()=>{dispatches++;if(!dispatched){assert.ok(await claimReplyTestProviderRequest(f.db,control,seed.scope,run.id));requests++;dispatched=true;}if(loseReceipt){loseReceipt=false;throw new Error('synthetic receipt lost');}return receipt;},
    read:async()=>result,
    close:async()=>{throw new Error('an attempted request cannot be closed as unstarted');},
  };
  const env={DB:f.db,REPLY_TEST_ENABLED:'true',NVAPI_KEY:'synthetic',FLUE_REPLY_TEST_AGENT:{} as DurableObjectNamespace<Agent>};
  const target={requestId:run.requestId,memberId:run.actorMemberId};
  return {...f,...seed,actor,run,candidate,env,target,deps:{control,runtime:native},counts:()=>({dispatches,requests}),lose:()=>{loseReceipt=true;},
    result:(next:typeof result)=>{result=next;},uid:(next:string|null)=>{currentUid=next;},saved:()=>readReplyTestRun(f.db,actor,run.requestId,run.actorMemberId)};
}

test('a reserved answer executes once, settles reported usage and returns a reviewed simulation',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  const first=await m.executeReplyTest(f.env,f.actor,f.target,f.deps);
  assert.equal(first.outcome,'found');assert.equal(first.status,'review_required');assert.equal(first.review?.canSend,false);assert.equal(first.review?.factCheck,'not_evaluated');
  assert.equal(first.usageStatus,'settled');assert.equal((await f.saved())!.chargedMicros,1);
  assert.deepEqual(await m.executeReplyTest(f.env,f.actor,f.target,f.deps),first);
  assert.deepEqual(f.counts(),{dispatches:1,requests:1});
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM send_intent').first('n'),0);
});
test('lost receipts are recovered using the same native execution without a second model request',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.lose();
  const lost=await m.executeReplyTest(f.env,f.actor,f.target,f.deps);assert.equal(lost.outcome,'found');assert.equal(lost.status,'unconfirmed');
  assert.equal((await f.saved())!.receipt,null);assert.equal((await f.saved())!.settlement,'held');
  const recovered=await m.executeReplyTest(f.env,f.actor,f.target,f.deps);assert.equal(recovered.outcome,'found');assert.equal(recovered.status,'review_required');assert.equal(f.counts().requests,1);
});
test('stale business context blocks the answer while actual provider usage is still settled',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);f.result({outcome:'pending'});
  assert.equal((await m.executeReplyTest(f.env,f.actor,f.target,f.deps)).outcome,'found');
  await f.message('new-question','Другой вопрос',20);
  f.result({outcome:'completed',text:JSON.stringify(f.candidate),metadata:{replyTest:{usageReported:true,usage:{input:9,output:3,cacheRead:2,cacheWrite:1},outputValid:true}}});
  const result=await m.readExecutedReplyTest(f.env,f.actor,f.target,f.deps);
  assert.equal(result.outcome,'found');assert.equal(result.status,'unavailable');assert.equal(result.review,null);assert.equal(result.usageStatus,'settled');assert.equal(f.counts().requests,1);
});
test('invalid citations cannot become answers and absent usage never invents a refund',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  f.result({outcome:'completed',text:JSON.stringify({...f.candidate,sources:[{chunkId:f.candidate.sources[0].chunkId,quote:'invented evidence'}]}),metadata:{replyTest:{usageReported:false,usage:null,outputValid:true}}});
  const result=await m.executeReplyTest(f.env,f.actor,f.target,f.deps);
  assert.equal(result.outcome,'found');assert.equal(result.status,'unavailable');assert.equal(result.review,null);assert.equal(result.usageStatus,'held');
});
test('disabled execution, revoked callers and missing native authority cannot trigger new requests or reveal answers',async t=>{
  const m=await api(),f=await fixture();t.after(f.close);
  const disabled=await m.executeReplyTest({...f.env,REPLY_TEST_ENABLED:'false'},f.actor,f.target,f.deps);assert.equal(disabled.outcome,'found');assert.equal(disabled.status,'unavailable');assert.equal(f.counts().requests,0);
  await m.executeReplyTest(f.env,f.actor,f.target,f.deps);f.uid('replacement-native-uid');
  const replaced=await m.executeReplyTest(f.env,f.actor,f.target,f.deps);assert.equal(replaced.outcome,'found');assert.equal(replaced.status,'unconfirmed');assert.equal(replaced.review,null);assert.equal(f.counts().requests,1);
  f.sqlite.prepare('DELETE FROM session WHERE id=?').run(f.actor.sessionId);
  assert.deepEqual(await m.executeReplyTest(f.env,f.actor,f.target,f.deps),{outcome:'not_found'});
});
