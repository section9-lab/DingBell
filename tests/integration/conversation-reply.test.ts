import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as v from 'valibot';
import { controlCommandSchema } from '../../src/modules/conversations/control-state.ts';
import { encryptCredentials } from '../../src/modules/stores/credentials.ts';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { bindTranslationReceipt,createTranslationBudget,freezeTranslationOutput,reserveTranslation,setTranslationBudgetEnabled } from '../../src/modules/translations/storage.ts';

const send=(expectedVersion=1,body='Здравствуйте!')=>({commandId:crypto.randomUUID(),action:'send_reply' as const,expectedVersion,body});
test('manual reply command keeps exact plaintext, limits it to 1000 characters, and rejects extra fields',()=>{
  const body='  Спасибо!\n\t'+'a'.repeat(980);
  const parsed=v.safeParse(controlCommandSchema,send(1,body));assert.equal(parsed.success,true);if(parsed.success)assert.equal((parsed.output as {body:string}).body,body);
  assert.equal(v.safeParse(controlCommandSchema,send(1,'a'.repeat(1000))).success,true);
  for(const invalid of ['', ' \r\n', 'a'.repeat(1001), '\ud800', 'x\u0000', 'x\u007f'])assert.equal(v.safeParse(controlCommandSchema,send(1,invalid)).success,false);
  assert.equal(v.safeParse(controlCommandSchema,{...send(),intentId:'injected'}).success,false);
});

type Fixture=Awaited<ReturnType<typeof conversationControlFixture>>;
async function until(check:()=>Promise<boolean>,duration=10_000){const deadline=Date.now()+duration;while(Date.now()<deadline){if(await check())return;await delay(30);}assert.fail('synthetic durable reply did not reach the expected state');}
async function ready(f:Fixture){
  const key=await encryptCredentials(f.credentialEnv,{orgId:'org',storeId:'store',platformStoreId:'1',credentialVersion:1},{apiKey:'synthetic-api-key'});
  await f.db.prepare("UPDATE store SET status='verified',outbound_enabled=1,credential_key_version=?,credential_nonce=?,credential_ciphertext=?,capabilities=?,checked_at=?,expires_at=? WHERE id='store'")
    .bind(key.keyVersion,key.nonce,key.ciphertext,JSON.stringify([{code:'auth',status:'available'},{code:'reply',status:'available'}]),Date.now(),Date.now()+3600_000).run();
  const result=await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'claim',expectedVersion:0}});assert.equal(result.body.outcome,'accepted');
}
async function reply(f:Fixture,intentId:string){const result=await f.call('reply',{intentId});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.reply;}

const cancel=(targetIntentId:string,expectedVersion:number)=>({commandId:crypto.randomUUID(),action:'cancel_reply',expectedVersion,targetIntentId});
async function holdQueue(f:Fixture){await f.call('inject',{key:'replyRateLimit',value:{until:Date.now()+120_000,dueAt:Date.now()+120_000}});}
test('queued cancellation is atomic, audited, replayable and does not invalidate another queued reply',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await holdQueue(f);
  const first=send(),second=send(2);await f.call('execute',{command:first});await f.call('execute',{command:second});
  const before=(await f.call('read')).body.view.state,command=cancel(first.commandId,3);
  const results=await Promise.all([f.call('execute',{command}),f.call('execute',{command})]);
  for(const result of results)assert.equal(result.body.outcome,'accepted',JSON.stringify(result.body));
  assert.deepEqual(results[0]!.body.receipt,results[1]!.body.receipt);
  const saved=await reply(f,first.commandId);assert.equal(saved.status,'canceled');assert.equal(saved.body,first.body);assert.equal(saved.attempt,null);assert.equal(saved.reason,null);
  assert.equal((await reply(f,second.commandId)).status,'queued');assert.equal(f.providerRequests.length,0);
  const after=(await f.call('read')).body.view.state;assert.equal(after.version,before.version+1);assert.equal(after.sequence,before.sequence+1);assert.equal(after.controlEpoch,before.controlEpoch);
  assert.equal((await f.db.prepare('SELECT state FROM send_intent WHERE id=?').bind(first.commandId).first())?.state,'canceled');
  const audit=JSON.parse((await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE command_id=?').bind(command.commandId).first<{receipt:string}>())!.receipt);
  assert.equal(audit.actorMemberId,'owner-member');assert.equal(audit.targetIntentId,first.commandId);
  await f.restart();assert.deepEqual((await f.call('execute',{command})).body.receipt,results[0]!.body.receipt);
  assert.equal((await f.call('execute',{command:{...command,targetIntentId:second.commandId}})).body.reason,'command');
  assert.equal((await f.call('execute',{command:cancel(first.commandId,4)})).body.code,'REPLY_NOT_CANCELABLE');
  await f.call('repair');assert.equal((await reply(f,first.commandId)).status,'canceled');assert.equal(f.providerRequests.length,0);
});

test('cancellation loses to a started provider attempt and cannot relabel sent or unknown outcomes',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider('hold');
  const first=send();await f.call('execute',{command:first});await until(async()=>f.providerRequests.length===1);
  const result=await Promise.race([f.call('execute',{command:cancel(first.commandId,2)}),delay(2000).then(()=>{throw new Error('cancel waited for remote I/O');})]);
  assert.equal(result.body.code,'REPLY_NOT_CANCELABLE');assert.equal((await reply(f,first.commandId)).status,'sending');
  f.releaseProvider();await until(async()=>(await reply(f,first.commandId)).status==='sent');
  assert.equal((await f.call('execute',{command:cancel(first.commandId,2)})).body.code,'REPLY_NOT_CANCELABLE');
  f.provider('lost');const second=send(2);await f.call('execute',{command:second});await until(async()=>(await reply(f,second.commandId)).status==='unknown');
  assert.equal((await f.call('execute',{command:cancel(second.commandId,3)})).body.code,'REPLY_NOT_CANCELABLE');assert.equal(f.providerRequests.length,2);
  assert.equal((await f.call('read')).body.view.state.version,3);
});

test('cancellation rollback and fresh authorization leave the queued intent and audit unchanged',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await holdQueue(f);
  const first=send();await f.call('execute',{command:first});const command=cancel(first.commandId,2);
  await f.call('faults',{value:{commit:true}});assert.equal((await f.call('execute',{command})).status,500);
  assert.equal((await reply(f,first.commandId)).status,'queued');assert.equal((await f.call('read')).body.view.state.version,2);
  assert.equal((await f.call('inspect')).body.receipts.length,2);await f.call('faults',{value:{}});
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.call('execute',{actor:f.actor('staff'),command})).body.outcome,'not_found');
  assert.equal((await f.call('execute',{actor:{...f.actor(),expectedMemberId:'former-owner'},command})).body.outcome,'not_found');
  assert.equal((await f.call('execute',{command:cancel(crypto.randomUUID(),2)})).body.outcome,'not_found');
  assert.equal((await f.call('execute',{command:cancel(first.commandId,1)})).body.reason,'version');
  await f.db.prepare("UPDATE store SET outbound_enabled=0 WHERE id='store'").run();
  assert.equal((await f.call('execute',{command})).body.outcome,'accepted');
  assert.equal((await reply(f,first.commandId)).status,'canceled');assert.equal(f.providerRequests.length,0);
});

test('cancellation survives delayed projections and restart even after the conversation is resolved',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await holdQueue(f);
  const first=send();await f.call('execute',{command:first});await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'resolve',expectedVersion:2}});
  const before=(await f.call('read')).body.view.state;await f.call('faults',{value:{project:true,replyProject:true}});
  const command=cancel(first.commandId,3),accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted');assert.equal(accepted.body.view.projectionPending,true);
  assert.equal(accepted.body.view.state.lifecycle,'resolved');assert.equal(accepted.body.view.state.workStatus,null);assert.equal(accepted.body.view.state.controlEpoch,before.controlEpoch);
  assert.equal((await f.db.prepare('SELECT state FROM send_intent WHERE id=?').bind(first.commandId).first())?.state,'queued');
  await f.restart();assert.equal((await reply(f,first.commandId)).status,'canceled');await f.call('faults',{value:{}});await f.call('repair');
  assert.equal((await f.db.prepare('SELECT state FROM send_intent WHERE id=?').bind(first.commandId).first())?.state,'canceled');
  assert.deepEqual((await f.call('execute',{command})).body.receipt,accepted.body.receipt);assert.equal(f.providerRequests.length,0);
});

async function frozenPreview(f:Fixture,conversationId='conv',completed=true){
  if(!await f.db.prepare("SELECT id FROM translation_budget_bucket WHERE id='preview-budget'").first()){
    await createTranslationBudget(f.db,f.actor(),{id:'preview-budget',startsAt:Date.now()-1000,endsAt:Date.now()+3600_000,limitMicros:1_000_000});
    await setTranslationBudgetEnabled(f.db,f.actor(),'preview-budget',0,true);
  }
  const input={requestId:crypto.randomUUID(),storeId:'store',conversationId,expectedMemberId:'owner-member',source:'请核对三件商品的规格。',sourceRevision:7,budgetId:'preview-budget'};
  const reserved=await reserveTranslation(f.db,f.actor(),input,{provider:'nvidia',model:'synthetic-model',modelConfigVersion:'synthetic-v1',promptVersion:'synthetic-v1',maxInputTokens:10,maxOutputTokens:10,
    pricing:{version:'synthetic-price',currency:'USD',inputMicrosPerMillion:1,outputMicrosPerMillion:1,cacheReadMicrosPerMillion:1,cacheWriteMicrosPerMillion:1}});
  assert.ok('run'in reserved);const scope={organizationId:'org',storeId:'store',conversationId},receipt={submissionId:reserved.run.id,uid:crypto.randomUUID(),acceptedAt:new Date().toISOString()};
  await bindTranslationReceipt(f.db,scope,reserved.run.id,receipt);
  const output=completed?await freezeTranslationOutput(f.db,scope,reserved.run.id,receipt,'Проверьте три товара.'):null;
  return {run:reserved.run,output};
}
test('translated manual replies retain verified provenance and their exact edited final body across replay',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const preview=await frozenPreview(f),body='  Проверьте, пожалуйста, три товара.\nСпасибо!  ';
  const command={...send(1,body),previewRequestId:preview.run.requestId};
  const accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted',JSON.stringify(accepted.body));
  const evidence=accepted.body.receipt.translation;assert.equal(accepted.body.receipt.previewRequestId,preview.run.requestId);
  assert.equal(evidence.runId,preview.run.id);assert.equal(evidence.requestId,preview.run.requestId);assert.equal(evidence.sourceHash,preview.run.sourceHash);assert.equal(evidence.sourceRevision,7);assert.equal(evidence.outputHash,preview.output!.bodyHash);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');assert.equal(evidence.confirmedBodyHash,hash);assert.notEqual(hash,evidence.outputHash);
  await until(async()=>(await reply(f,command.commandId)).status==='sent');assert.equal((await reply(f,command.commandId)).previewRequestId,preview.run.requestId);
  assert.deepEqual(f.providerRequests,[{path:'/v1/chat/send/message',body:{chat_id:'thread',text:body}}]);
  const audit=await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE command_id=?').bind(command.commandId).first<string>('receipt');assert.ok(audit);assert.deepEqual(JSON.parse(audit).translation,evidence);
  await f.restart();assert.deepEqual((await f.call('execute',{command})).body.receipt,accepted.body.receipt);
  const {previewRequestId,...plain}=command;
  for(const changed of [plain,{...command,previewRequestId:crypto.randomUUID()},{...command,body:body.trim()}])assert.equal((await f.call('execute',{command:changed})).body.reason,'command');
  assert.equal(f.providerRequests.length,1);
});
test('translated replies require an original-member completed preview in the exact conversation',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const pending=await frozenPreview(f,'conv',false),foreign=await frozenPreview(f,'second'),owned=await frozenPreview(f);
  for(const [requestId,actor] of [[crypto.randomUUID(),f.actor()],[pending.run.requestId,f.actor()],[foreign.run.requestId,f.actor()],[owned.run.requestId,f.actor('staff')]] as const){
    const result=await f.call('execute',{actor,command:{...send(),previewRequestId:requestId}});assert.equal(result.body.outcome,'rejected',JSON.stringify(result.body));assert.equal(result.body.code,'PREVIEW_UNAVAILABLE');
  }
  const state=(await f.call('inspect')).body;assert.equal(state.state.version,1);assert.equal(state.replies.length,0);assert.equal(f.providerRequests.length,0);
});

test('manual reply gates reject without persisting intent and preserve original control behavior',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await ready(f);
  const rejected=await f.call('execute',{command:send()});assert.equal(rejected.body.outcome,'rejected');assert.equal(rejected.body.code,'OUTBOUND_DISABLED');
  const state=(await f.call('inspect')).body;assert.equal(state.state.version,1);assert.equal(state.replies.length,0);assert.equal(f.providerRequests.length,0);
});

test('manual reply is durable, alarm sends once, exact replay cannot create another attempt',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const command=send(1,'  Спасибо!\nПожалуйста.');const accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted');
  assert.equal(accepted.body.receipt.intentId,command.commandId);assert.equal(accepted.body.view.state.controlEpoch,1);assert.equal(accepted.body.view.state.version,2);assert.equal(accepted.body.view.state.workStatus,'needs_reply');
  await until(async()=>{const state=await reply(f,command.commandId);assert.notEqual(state.status,'unknown',JSON.stringify({state,errors:f.providerErrors,sendError:(await f.call('inspect')).body.sendError,requests:f.providerRequests.length}));return state.status==='sent';});
  assert.deepEqual(f.providerRequests,[{path:'/v1/chat/send/message',body:{chat_id:'thread',text:command.body}}]);
  const completed=await reply(f,command.commandId);assert.equal(completed.attempt.id,`${command.commandId}:1`);assert.equal(completed.attempt.httpStatus,200);assert.equal(completed.attempt.providerResult,'success');assert.equal(completed.reason,null);
  assert.equal('credentialVersion' in completed,false);assert.equal('actorUserId' in completed,false);assert.equal('platformThreadId' in completed,false);
  await f.restart();const replay=await f.call('execute',{command});assert.deepEqual(replay.body.receipt,accepted.body.receipt);
  await f.call('repair');assert.equal(f.providerRequests.length,1);assert.equal((await reply(f,command.commandId)).status,'sent');
  const changed=await f.call('execute',{command:{...command,body:'different'}});assert.equal(changed.body.reason,'command');
});

test('manual reply transaction rollback leaves no orphan intent or attempt',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await f.call('faults',{value:{commit:true}});
  const result=await f.call('execute',{command:send()});assert.equal(result.status,500);
  const inspected=(await f.call('inspect')).body;assert.equal(inspected.state.version,1);assert.equal(inspected.replies.length,0);assert.equal(inspected.replyOutbox.length,0);assert.equal(inspected.receipts.length,1);assert.equal(f.providerRequests.length,0);
});

for(const [label,sql,reason]of [
  ['revoked member',"DELETE FROM store_grant WHERE member_id='staff-member'",'ACCESS_REVOKED'],
  ['rotated credential',"UPDATE store SET credential_version=2 WHERE id='store'",'CREDENTIAL_CHANGED'],
  ['disabled store',"UPDATE store SET outbound_enabled=0 WHERE id='store'",'OUTBOUND_DISABLED'],
  ['expired capability',"UPDATE store SET expires_at=1 WHERE id='store'",'CAPABILITY_UNVERIFIED'],
] as const)test(`manual reply queued dispatch rechecks ${label} before any request`,{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const command=send();const accepted=await f.call('execute',{actor:f.actor('staff'),command});assert.equal(accepted.body.outcome,'accepted');
  await f.call('clearAlarm');await f.db.prepare(sql).run();await f.call('repair');
  await until(async()=>(await reply(f,command.commandId)).status==='skipped');
  assert.equal((await reply(f,command.commandId)).reason,reason);assert.equal(f.providerRequests.length,0);
});

test('manual reply queued intent is skipped after transfer but inflight transfer remains responsive',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const stale=send();await f.call('execute',{command:stale});await f.call('clearAlarm');
  const transfer={commandId:crypto.randomUUID(),action:'transfer',targetMemberId:'staff-member',reason:'handoff',expectedVersion:2};
  assert.equal((await f.call('execute',{command:transfer})).body.outcome,'accepted');await f.call('repair');
  await until(async()=>(await reply(f,stale.commandId)).status==='skipped');assert.equal(f.providerRequests.length,0);
  f.provider('hold');const active=send(3);await f.call('execute',{command:active});await f.call('repair');
  await until(async()=>f.providerRequests.length===1);
  const result=await Promise.race([f.call('execute',{command:{...transfer,commandId:crypto.randomUUID(),targetMemberId:'owner-member',expectedVersion:4}}),delay(2_000).then(()=>{throw new Error('network blocked a concurrent control command');})]);
  assert.equal(result.body.outcome,'accepted');assert.equal(result.body.view.state.version,5);
  const replay=await f.call('execute',{command:active});assert.equal(replay.body.receipt.appliedState.version,4);assert.equal(replay.body.view.state.version,5);
  f.releaseProvider();await until(async()=>(await reply(f,active.commandId)).status==='sent');
  assert.equal((await f.call('read')).body.view.state.version,5);assert.equal(f.providerRequests.length,1);
});

for(const [mode,status,code]of [['503','unknown','PROVIDER_UNAVAILABLE'],['malformed','unknown','INVALID_RESPONSE'],['429','failed','RATE_LIMITED']] as const)
test(`manual reply ${mode} is one attempt and stays ${status} after restart and repair`,{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider(mode);
  const command=send();await f.call('execute',{command});await until(async()=>(await reply(f,command.commandId)).status===status);
  const result=await reply(f,command.commandId);assert.equal(result.reason,code);assert.equal(result.attempt.errorCode,code);assert.equal(f.providerRequests.length,1);
  await f.restart();await f.call('repair');await f.call('execute',{command});assert.equal(f.providerRequests.length,1);assert.equal((await reply(f,command.commandId)).status,status);
  if(mode==='429'){
    const next=send(2);await f.call('execute',{command:next});await f.call('repair');assert.equal((await reply(f,next.commandId)).status,'queued');assert.equal(f.providerRequests.length,1);
  }
});

test('manual reply pending projection survives restart and reconstructs its mirror without another provider request',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await f.call('faults',{value:{replyProject:true}});
  const command=send();const accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted');assert.equal(accepted.body.view.projectionPending,true);
  await until(async()=>(await reply(f,command.commandId)).status==='sent');const before=await reply(f,command.commandId);assert.equal(f.providerRequests.length,1);
  assert.ok((await f.call('inspect')).body.replyOutbox.length>0);await f.restart();assert.deepEqual(await reply(f,command.commandId),before);
  await f.call('faults',{value:{}});await f.call('repair');assert.equal((await f.call('inspect')).body.replyOutbox.length,0);assert.equal(f.providerRequests.length,1);
});

test('manual reply background uses original member authorization without a browser session, and readonly lookup rejects lost access',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const command=send();await f.call('execute',{actor:f.actor('staff'),command});await f.call('clearAlarm');
  await f.db.prepare("DELETE FROM session WHERE user_id='staff'").run();await f.call('repair');await until(async()=>(await reply(f,command.commandId)).status==='sent');
  assert.equal((await f.call('reply',{actor:f.actor('staff'),intentId:command.commandId})).body.outcome,'not_found');
  assert.equal((await f.call('execute',{actor:f.actor('staff'),command})).body.outcome,'not_found');assert.equal(f.providerRequests.length,1);
});

test('manual reply missing state with reply residue fails closed instead of rebuilding authority',{timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('inject',{key:'reply:orphan',value:{}});
  const result=await f.call('read');assert.equal(result.status,500);assert.match(result.body.error,/CONTROL_AUTHORITY_MISSING/);assert.equal(f.providerRequests.length,0);
});

test('manual reply projection advances even when independent control projection fails',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await f.call('faults',{value:{project:true}});
  const command=send();const accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted');await f.call('clearAlarm');
  const projected=await f.db.prepare('SELECT state FROM send_intent WHERE controller_id=? AND id=?').bind(f.scope.controllerId,command.commandId).first();assert.ok(projected);
});

test('manual reply dispatch failure cannot starve already accepted control projection',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const command=send();await f.call('execute',{command});await f.call('faults',{value:{project:true}});
  await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'add_note',expectedVersion:2,body:'independent internal note'}});await f.call('clearAlarm');
  const snapshot=(await f.call('inspect')).body.replies[0][1];snapshot.intent.bodyHash='0'.repeat(64);await f.call('inject',{key:`reply:${command.commandId}`,value:snapshot});
  await f.call('faults',{value:{}});await delay(1_050);const repair=await f.call('repair');assert.equal(repair.status,500);
  const state=await f.db.prepare('SELECT version FROM conversation_control WHERE controller_id=?').bind(f.scope.controllerId).first<{version:number}>();assert.equal(state?.version,3);assert.equal(f.providerRequests.length,0);
});

test('manual reply same-command concurrency accepts once and distinct stale commands cannot add a second intent',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const command=send();
  const results=await Promise.all(Array.from({length:6},()=>f.call('execute',{command})));assert.ok(results.every(result=>result.body.outcome==='accepted'));assert.ok(results.every(result=>JSON.stringify(result.body.receipt)===JSON.stringify(results[0].body.receipt)));
  const distinct=await Promise.all(Array.from({length:4},()=>f.call('execute',{command:send()})));assert.ok(distinct.every(result=>result.body.reason==='version'));
  await until(async()=>(await reply(f,command.commandId)).status==='sent');assert.equal(f.providerRequests.length,1);assert.equal((await f.call('inspect')).body.replies.length,1);
});

test('manual reply accepted by the synthetic platform with a lost response remains unknown with no replay send',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider('lost');const command=send();await f.call('execute',{command});
  await until(async()=>(await reply(f,command.commandId)).status==='unknown');assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM test_provider_request WHERE accepted=1').first<{n:number}>())?.n,1);
  await f.restart();await f.call('execute',{command});await f.call('repair');assert.equal((await reply(f,command.commandId)).status,'unknown');assert.equal(f.providerRequests.length,1);
});

test('manual reply workerd restart while provider is inflight expires sending without issuing a second request',{timeout:35_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider('hold');const command=send();await f.call('execute',{command});
  await until(async()=>f.providerRequests.length===1);assert.equal((await reply(f,command.commandId)).status,'sending');
  await f.restart();f.releaseProvider();await until(async()=>(await reply(f,command.commandId)).status==='unknown',12_000);
  assert.equal(f.providerRequests.length,1);assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM test_provider_request').first<{n:number}>())?.n,1);await f.call('repair');assert.equal(f.providerRequests.length,1);
});

test('manual reply redirect is refused in workerd without following its Location',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider('redirect');const command=send();await f.call('execute',{command});
  await until(async()=>(await reply(f,command.commandId)).status==='unknown');assert.equal((await reply(f,command.commandId)).reason,'REDIRECT_REFUSED');assert.equal(f.providerRequests.length,1);assert.deepEqual(f.providerErrors,[]);
});

test('manual reply queued survives internal note and cleared control outbox with a durable dispatch alarm',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'set_work_status',expectedVersion:1,workStatus:'waiting_customer'}});
  const command=send(2);await f.call('execute',{command});const note=await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'add_note',expectedVersion:3,body:'Internal context'}});
  assert.equal(note.body.view.state.controlEpoch,2);assert.equal(note.body.view.state.workStatus,'waiting_customer');const before=(await f.call('inspect')).body;assert.equal(before.outbox.length,0);assert.ok(before.alarm);
  await until(async()=>(await reply(f,command.commandId)).status==='sent');assert.equal((await f.call('read')).body.view.state.version,4);assert.equal(f.providerRequests.length,1);
});

test('manual reply queued resolve cancels dispatch and removed then rejoined membership cannot inherit the intent',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const first=send();await f.call('execute',{command:first});await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'resolve',expectedVersion:2}});
  await until(async()=>(await reply(f,first.commandId)).status==='skipped');assert.equal((await reply(f,first.commandId)).reason,'CONTROL_CHANGED');
  await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'reopen',expectedVersion:3}});
  const second=send(4);await f.call('execute',{actor:f.actor('staff'),command:second});await f.call('clearAlarm');
  await f.db.batch([f.db.prepare("DELETE FROM member WHERE id='staff-member'"),f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('staff-new','org','staff','member',2)"),f.db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-new',2)")]);
  await f.call('repair');await until(async()=>(await reply(f,second.commandId)).status==='skipped');assert.equal((await reply(f,second.commandId)).reason,'ACCESS_REVOKED');assert.equal(f.providerRequests.length,0);
  assert.equal((await f.call('execute',{actor:f.actor('staff'),command:second})).body.reason,'command');
});

test('manual reply rejects unavailable capability and resolved state without confusing them with a version conflict',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  await f.db.prepare("UPDATE store SET expires_at=1 WHERE id='store'").run();assert.equal((await f.call('execute',{command:send()})).body.code,'CAPABILITY_UNVERIFIED');
  await f.db.prepare("UPDATE store SET expires_at=? WHERE id='store'").bind(Date.now()+3600_000).run();await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'resolve',expectedVersion:1}});
  assert.equal((await f.call('execute',{command:send(2)})).body.code,'REPLY_UNAVAILABLE');assert.equal((await f.call('inspect')).body.replies.length,0);assert.equal(f.providerRequests.length,0);
});

test('manual reply accepts at the maximum control epoch because it increments only version and sequence',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const state=(await f.call('read')).body.view.state;
  await f.call('inject',{key:'state',value:{...state,version:2,sequence:2,controlEpoch:Number.MAX_SAFE_INTEGER}});const command=send(2);const accepted=await f.call('execute',{command});assert.equal(accepted.body.outcome,'accepted');assert.equal(accepted.body.view.state.controlEpoch,Number.MAX_SAFE_INTEGER);
  await until(async()=>(await reply(f,command.commandId)).status==='sent');assert.equal(f.providerRequests.length,1);
});

test('manual reply rate feedback failure is durable and delays later intents until feedback recovers',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);f.provider('429');await f.call('faults',{value:{rateFeedback:true}});
  const first=send();await f.call('execute',{command:first});await until(async()=>(await reply(f,first.commandId)).status==='failed');
  const pending=(await f.call('inspect')).body.rateFeedback;assert.ok(pending.until>Date.now());const second=send(2);await f.call('execute',{command:second});
  await delay(1_100);await f.call('repair');assert.equal((await reply(f,second.commandId)).status,'queued');assert.equal(f.providerRequests.length,1);
  await f.restart();assert.equal((await f.call('inspect')).body.rateFeedback.until,pending.until);await f.call('faults',{value:{}});
  await f.call('inject',{key:'replyRateLimit',value:{...pending,dueAt:Date.now()}});await f.call('repair');assert.equal((await f.call('inspect')).body.rateFeedback,undefined);
  assert.equal((await f.db.prepare("SELECT blocked_until AS value FROM store_coordinator WHERE store_id='store'").first<{value:number}>())?.value,pending.until);assert.equal(f.providerRequests.length,1);
});


test('recent reply authority reads share server gates, never dispatch, and retain an accepted reply during projection failure',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  const available=await f.call('replies');assert.equal(available.status,200);assert.deepEqual(available.body.readiness,{allowed:true,code:null});assert.equal(available.body.viewerMemberId,'owner-member');assert.equal(available.body.controlVersion,1);assert.equal(available.body.historyReady,true);
  await f.call('faults',{value:{replyProject:true}});const command=send();await f.call('execute',{command});await f.call('clearAlarm');
  const before=(await f.call('serialized')).body;const current=await f.call('replies');assert.equal(current.body.replies.length,1);assert.equal(current.body.replies[0].intentId,command.commandId);assert.equal(current.body.controlVersion,2);
  assert.deepEqual((await f.call('serialized')).body,before);assert.equal((await f.call('inspect')).body.alarm,null);assert.equal(f.providerRequests.length,0);
  await f.db.prepare("UPDATE store SET outbound_enabled=0 WHERE id='store'").run();assert.deepEqual((await f.call('replies')).body.readiness,{allowed:false,code:'OUTBOUND_DISABLED'});
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.call('replies',{actor:f.actor('staff')})).body.outcome,'not_found');assert.equal(f.providerRequests.length,0);
});

async function seedLegacyReplies(f:Fixture,count:number){
  const initial=(await f.call('read')).body.view.state,time=Date.now(),values:{key:string;value:unknown}[]=[],ids:string[]=[];
  for(let index=1;index<=count;index++){
    const id=crypto.randomUUID(),body=`legacy ${index}`,sequence=initial.sequence+index;ids.push(id);
    const state={...initial,version:initial.version+index,sequence,updatedAt:time};
    const bodyHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(value=>value.toString(16).padStart(2,'0')).join('');
    values.push({key:`receipt:${id}`,value:{commandId:id,expectedVersion:state.version-1,action:'send_reply',body,actorUserId:'owner',actorMemberId:'owner-member',appliedState:state,intentId:id}},
      {key:`reply:${id}`,value:{intent:{schemaVersion:1,id,commandId:id,actorUserId:'owner',actorMemberId:'owner-member',body,bodyHash,platformThreadId:'thread',credentialVersion:1,controlEpoch:initial.controlEpoch,state:'unknown',revision:3,createdAt:time,updatedAt:time,dueAt:null,lastError:'NETWORK_ERROR'},
        attempt:{id:`${id}:1`,intentId:id,state:'unknown',startedAt:time,deadlineAt:time+10_000,finishedAt:time,httpStatus:null,providerResult:null,errorCode:'NETWORK_ERROR'}}});
  }
  values.push({key:'state',value:{...initial,version:initial.version+count,sequence:initial.sequence+count,updatedAt:time}});await f.call('injectMany',{values});return ids;
}

test('recent reply legacy recovery is bounded, ordered by acceptance sequence, and retains concurrent new acceptance',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const ids=await seedLegacyReplies(f,55);const before=(await f.call('serialized')).body;
  const first=await f.call('replies');assert.equal(first.status,200);assert.equal(first.body.historyReady,false);assert.deepEqual(first.body.readiness,{allowed:false,code:'REPLY_UNAVAILABLE'});assert.ok(first.body.replies.length<=20);
  const partial=(await f.call('inspect')).body.replyHistory;assert.equal(partial.complete,false);assert.ok(partial.after);assert.equal(partial.recent.length,20);
  const command=send(56);assert.equal((await f.call('execute',{command})).body.outcome,'accepted');await f.call('clearAlarm');
  const restored=(await f.call('replies')).body;assert.equal(restored.historyReady,true);assert.equal(restored.replies.length,20);assert.deepEqual(restored.replies.map((value:any)=>value.intentId),[command.commandId,...ids.slice(-19).reverse()]);
  const oldReceipts=(await f.call('serialized')).body.receipts.filter(([key]:[string])=>key!==`receipt:${command.commandId}`);assert.deepEqual(oldReceipts,before.receipts);assert.equal(f.providerRequests.length,0);
  await f.restart();const restarted=(await f.call('replies')).body;assert.deepEqual(restarted.replies.map((value:any)=>value.intentId),restored.replies.map((value:any)=>value.intentId));
});

test('recent reply index writes roll back with command acceptance and cannot reinitialize missing authority',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);await f.call('replies');const original=(await f.call('inspect')).body.replyHistory;
  await f.call('faults',{value:{commit:true}});assert.equal((await f.call('execute',{command:send()})).status,500);assert.deepEqual((await f.call('inspect')).body.replyHistory,original);
  const fresh=await conversationControlFixture();t.after(()=>fresh.close());await fresh.call('inject',{key:'replyHistory',value:{schemaVersion:1,observedSequence:0,complete:true,after:null,recent:[]}});assert.equal((await fresh.call('read')).status,500);
});

test('recent reply readiness disables exhausted changed counters but permits an unchanged maximum epoch',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const state=(await f.call('read')).body.view.state;
  await f.call('inject',{key:'state',value:{...state,version:2,sequence:2,controlEpoch:Number.MAX_SAFE_INTEGER}});assert.equal((await f.call('replies')).body.readiness.allowed,true);
  await f.call('inject',{key:'state',value:{...state,version:3,sequence:Number.MAX_SAFE_INTEGER}});assert.deepEqual((await f.call('replies')).body.readiness,{allowed:false,code:'REPLY_UNAVAILABLE'});
});

test('recent reply corrupt indices and missing referenced receipts fail closed rather than hiding old unknown sends',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);
  for(const value of [{schemaVersion:2,observedSequence:1,complete:true,after:null,recent:[]},{schemaVersion:1,observedSequence:2,complete:true,after:null,recent:[]},{schemaVersion:1,observedSequence:1,complete:true,after:null,recent:[{id:crypto.randomUUID(),sequence:1}]}]){
    await f.call('inject',{key:'replyHistory',value});assert.equal((await f.call('replies')).status,500);
  }
  assert.equal(f.providerRequests.length,0);
});


test('recent reply index automatically recovers sends accepted by an older worker even before another current command',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const initialIds=await seedLegacyReplies(f,22);assert.equal((await f.call('replies')).body.historyReady,true);
  const missed=await seedLegacyReplies(f,1);const note=await f.call('execute',{command:{commandId:crypto.randomUUID(),action:'add_note',expectedVersion:24,body:'after rollback upgrade'}});assert.equal(note.body.outcome,'accepted');
  const restored=(await f.call('replies')).body;assert.equal(restored.historyReady,true);assert.deepEqual(restored.replies.map((item:any)=>item.intentId),[missed[0],...initialIds.slice(-19).reverse()]);assert.equal((await f.call('inspect')).body.replyHistory.observedSequence,25);assert.equal(f.providerRequests.length,0);
});

test('manual reply frozen membership rejects a never-accepted old command after member deletion and rejoin',{timeout:30_000},async t=>{
  const f=await conversationControlFixture(undefined,{outboundEnabled:'true'});t.after(()=>f.close());await ready(f);const command=send();
  await f.db.batch([f.db.prepare("DELETE FROM member WHERE id='staff-member'"),f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('staff-new','org','staff','member',2)"),f.db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-new',2)")]);
  const rejected=await f.call('execute',{actor:{...f.actor('staff'),expectedMemberId:'staff-member'},command});assert.equal(rejected.body.outcome,'not_found');assert.equal((await f.call('inspect')).body.replies.length,0);assert.equal(f.providerRequests.length,0);
  const accepted=await f.call('execute',{actor:{...f.actor('staff'),expectedMemberId:'staff-new'},command});assert.equal(accepted.body.outcome,'accepted');assert.equal(accepted.body.receipt.actorMemberId,'staff-new');await f.call('clearAlarm');
  assert.equal((await f.call('execute',{actor:{...f.actor('staff'),expectedMemberId:'staff-member'},command})).body.outcome,'not_found');assert.equal(f.providerRequests.length,0);
});
