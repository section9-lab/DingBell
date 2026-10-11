import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { seedReplyTest } from '../fixtures/reply-test.ts';
import { prepareReplyTest,retrieveReplyTestKnowledge,reviewReplyTest,replyTestModelInput,type ReplyTestControlReader } from '../../src/modules/reply-tests/service.ts';
import { withdrawKnowledge } from '../../src/modules/knowledge/storage.ts';

test('native control takeover rejects the old simulated answer despite failed projection and a runtime restart',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const seed=await seedReplyTest(f.db,f.actor(),'store','conv'),source=await seed.source();
  const control:ReplyTestControlReader=async(scope,actor)=>(await f.call('read',{actor},scope)).body;
  const context=await prepareReplyTest(f.db,control,f.actor(),seed.input);
  const evidence=await retrieveReplyTestKnowledge(f.db,seed.index,control,f.actor(),context,seed.embedding);
  const answer={kind:'answer',body:'Ширина — 26 см.',sources:[{chunkId:source.prepared.chunks[0].id,quote:'26 см.'}]};
  assert.equal((await reviewReplyTest(f.db,control,f.actor(),context,evidence,answer)).canSend,false);
  await f.call('faults',{value:{project:true}});
  const takeover=(await f.call('execute',{command:{action:'takeover',commandId:crypto.randomUUID(),expectedVersion:0}})).body;
  assert.equal(takeover.outcome,'accepted');assert.equal(takeover.view.state.controlEpoch,1);
  assert.equal((await f.db.prepare('SELECT version FROM conversation_control WHERE conversation_id=?').bind('conv').first<{version:number}>())!.version,0);
  await assert.rejects(()=>replyTestModelInput(context,evidence,{db:f.db,control,actor:f.actor()}),/REPLY_TEST_CHANGED/);
  await assert.rejects(()=>reviewReplyTest(f.db,control,f.actor(),context,evidence,answer),/REPLY_TEST_CHANGED/);
  await f.restart();
  await assert.rejects(()=>reviewReplyTest(f.db,control,f.actor(),context,evidence,answer),/REPLY_TEST_CHANGED/);
  assert.equal(context.controlEpoch,0);assert.equal(f.providerRequests.length,0);assert.equal(f.providerErrors.length,0);
  assert.equal((await f.db.prepare('SELECT count(*) AS n FROM send_intent').first<{n:number}>())!.n,0);
});

test('native D1 publication withdrawal invalidates captured knowledge and clarification remains a simulation',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const seed=await seedReplyTest(f.db,f.actor(),'store','conv'),source=await seed.source();
  const control:ReplyTestControlReader=async(scope,actor)=>(await f.call('read',{actor},scope)).body;
  const context=await prepareReplyTest(f.db,control,f.actor(),seed.input);
  const evidence=await retrieveReplyTestKnowledge(f.db,seed.index,control,f.actor(),context,seed.embedding);
  assert.ok(await withdrawKnowledge(f.db,f.actor(),source.id,2));
  await assert.rejects(()=>replyTestModelInput(context,evidence,{db:f.db,control,actor:f.actor()}),/REPLY_TEST_EVIDENCE_CHANGED/);
  await assert.rejects(()=>reviewReplyTest(f.db,control,f.actor(),context,evidence,{kind:'answer',body:'26 см.',sources:[{chunkId:source.prepared.chunks[0].id,quote:'26 см.'}]}),/REPLY_TEST_EVIDENCE_CHANGED/);
  const fresh=await retrieveReplyTestKnowledge(f.db,seed.index,control,f.actor(),context,seed.embedding);
  assert.equal(fresh.chunks.length,0);
  const result=await reviewReplyTest(f.db,control,f.actor(),context,fresh,{kind:'clarify',body:'Уточните модель.'});
  assert.equal(result.simulated,true);assert.equal(result.canSend,false);
  assert.equal(f.providerRequests.length,0);assert.equal(f.providerErrors.length,0);
});
