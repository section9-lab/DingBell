import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { conversationControlFixture } from '../fixtures/conversation-control.ts';
import { ensureControlDirectory, projectControlEvents, readControlDirectory } from '../../src/modules/conversations/control-storage.ts';
import type { ControlAction, ControlEvent, ControlScope, LegacyControlState, WorkStatus } from '../../src/modules/conversations/control-types.ts';
import { claimSyncLease, commitSyncPage, getDueSyncCursor } from '../../src/modules/sync/storage.ts';

function command(action:Exclude<ControlAction,'set_work_status'|'transfer'|'add_note'|'send_reply'>='claim',expectedVersion=0){return {commandId:crypto.randomUUID(),action,expectedVersion};}
function workCommand(workStatus:WorkStatus,expectedVersion=0){return {commandId:crypto.randomUUID(),action:'set_work_status' as const,workStatus,expectedVersion};}
function transferCommand(targetMemberId='staff-member',expectedVersion=0,reason='请协助处理'){return {commandId:crypto.randomUUID(),action:'transfer' as const,targetMemberId,reason,expectedVersion};}
function noteCommand(body='内部备注',expectedVersion=0){return {commandId:crypto.randomUUID(),action:'add_note' as const,body,expectedVersion};}
async function until(check:()=>Promise<boolean>){const deadline=Date.now()+8_000;while(Date.now()<deadline){if(await check())return;await delay(25);}assert.fail('local durable control recovery did not complete');}
function legacyEvent(scope:ControlScope,action:'claim'|'resolve',sequence:number):ControlEvent {
  return {scope,receipt:{commandId:crypto.randomUUID(),expectedVersion:sequence-1,action,actorUserId:'owner',actorMemberId:'owner-member',appliedState:{
    schemaVersion:1,version:sequence,controlEpoch:sequence,sequence,lifecycle:action==='resolve'?'resolved':'open',
    reception:'human',assignedMemberId:'owner-member',updatedAt:sequence*100}}};
}
async function seedLegacy(f:Awaited<ReturnType<typeof conversationControlFixture>>,events:ControlEvent[],projectedCount:number) {
  await f.call('inject',{key:'scope',value:f.scope});
  const state=events.at(-1)!.receipt.appliedState;assert.equal(state.schemaVersion,1);
  await f.call('inject',{key:'state',value:state});
  for(const [index,event]of events.entries()) {
    const {receipt}=event;await f.call('inject',{key:`receipt:${receipt.commandId}`,value:receipt});
    if(index>=projectedCount)await f.call('inject',{key:`event:${String(receipt.appliedState.sequence).padStart(16,'0')}`,value:event});
    else await f.db.prepare('INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(f.scope.controllerId,f.scope.organizationId,f.scope.storeId,f.scope.conversationId,receipt.appliedState.sequence,receipt.commandId,receipt.actorUserId,receipt.actorMemberId,receipt.action,JSON.stringify(receipt),receipt.appliedState.updatedAt).run();
  }
  const projected=events[projectedCount-1]?.receipt.appliedState;
  if(projected)await f.db.prepare('UPDATE conversation_control SET version=?,control_epoch=?,sequence=?,lifecycle=?,reception=?,assigned_member_id=?,updated_at=? WHERE controller_id=?')
    .bind(projected.version,projected.controlEpoch,projected.sequence,projected.lifecycle,projected.reception,projected.assignedMemberId,projected.updatedAt,f.scope.controllerId).run();
}

test('native concurrent claims accept exactly one version and preserve the winning member', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const initial=await f.call('read');assert.equal(initial.body.outcome,'found');
  assert.deepEqual(initial.body.view.state,{schemaVersion:2,version:0,controlEpoch:0,sequence:0,lifecycle:'open',reception:'paused',assignedMemberId:null,updatedAt:0,workStatus:'needs_reply'});
  const results=await Promise.all(Array.from({length:8},(_,index)=>f.call('execute',{actor:f.actor(index%2?'staff':'owner'),command:command()})));
  const accepted=results.filter(result=>result.body.outcome==='accepted');assert.equal(accepted.length,1);
  assert.equal(results.filter(result=>result.body.outcome==='conflict'&&result.body.reason==='version').length,7);
  const state=(await f.call('read')).body.view.state;
  assert.equal(state.version,1);assert.equal(state.controlEpoch,1);assert.equal(state.sequence,1);assert.equal(state.reception,'human');
  assert.equal(state.assignedMemberId,accepted[0].body.receipt.actorMemberId);
});

test('lost receipts replay with current authority while altered actors, payloads and stale versions conflict', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const claim=command();
  const first=(await f.call('execute',{command:claim})).body;assert.equal(first.outcome,'accepted');
  const resolved=(await f.call('execute',{command:command('resolve',1)})).body;assert.equal(resolved.outcome,'accepted');
  await f.restart();
  const replay=(await f.call('execute',{command:claim})).body;
  assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.view.state.version,2);assert.equal(replay.view.state.lifecycle,'resolved');
  for(const extra of [{command:{...claim,action:'resolve'}},{command:{...claim,expectedVersion:2}},{command:claim,actor:f.actor('staff')}]){
    const result=(await f.call('execute',extra)).body;assert.equal(result.outcome,'conflict');assert.equal(result.reason,'command');
  }
  assert.equal((await f.call('execute',{command:command('takeover',0)})).body.reason,'version');
  assert.equal((await f.call('execute',{command:command('claim',2)})).body.reason,'state');
  await f.db.prepare("UPDATE conversation SET platform_status='Opened',last_message_at=999,imported_at=999 WHERE id='conv'").run();
  const state=(await f.call('read')).body.view.state;assert.equal(state.lifecycle,'resolved');assert.equal(state.controlEpoch,2);
});

test('fresh grants, sessions and member identity are checked before receipt replay', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const claim=command(),actor=f.actor('staff');
  assert.equal((await f.call('execute',{actor,command:claim})).body.outcome,'accepted');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.call('execute',{actor,command:claim})).body.outcome,'not_found');
  assert.equal((await f.call('read',{actor})).body.outcome,'not_found');
  await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
  await f.db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('new-member','org','staff','member',1)").run();
  await f.db.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('org','store','new-member',1)").run();
  assert.equal((await f.call('execute',{actor,command:claim})).body.reason,'command');
  await f.db.prepare("DELETE FROM session WHERE id='staff-session'").run();
  assert.equal((await f.call('execute',{actor,command:claim})).body.outcome,'not_found');
});

test('a controller cannot change scope, accept a wrong object route, or erase an unsupported schema', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('read');
  const second=await ensureControlDirectory(f.db,f.actor(),'second',Date.now());assert.ok(second);
  assert.equal((await f.call('read',{name:f.scope.controllerId},second.scope)).body.outcome,'not_found');
  assert.equal((await f.call('execute',{name:'wrong-object',command:command()})).body.outcome,'not_found');
  assert.equal((await f.call('read',{}, {...f.scope,organizationId:'other-org'})).body.outcome,'not_found');
  const original=(await f.call('read')).body.view.state;
  await f.call('inject',{key:'state',value:{...original,schemaVersion:99}});
  assert.equal((await f.call('read')).status,500);
  assert.equal((await f.call('inspect')).body.state.schemaVersion,99);
});

test('state, receipt, event and alarm roll back together when the local transaction fails', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('read');const claim=command();
  await f.call('faults',{value:{commit:true}});
  assert.equal((await f.call('execute',{command:claim})).status,500);
  const failed=(await f.call('inspect')).body;assert.equal(failed.state.version,0);assert.deepEqual(failed.receipts,[]);assert.deepEqual(failed.outbox,[]);assert.equal(failed.alarm,null);
  await f.call('faults',{value:{}});
  const retry=(await f.call('execute',{command:claim})).body;assert.equal(retry.outcome,'accepted');assert.equal(retry.receipt.appliedState.sequence,1);
});

test('D1 projection failure keeps accepted authority and native alarms recover after restart', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  const result=(await f.call('execute',{command:command()})).body;assert.equal(result.outcome,'accepted');assert.equal(result.view.projectionPending,true);
  assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,0);
  await f.restart();assert.equal((await f.call('read')).body.view.state.version,1);
  await f.call('faults',{value:{}});await f.call('retrySoon');
  await until(async()=> (await readControlDirectory(f.db,f.scope))?.state.version===1 && (await f.call('inspect')).body.outbox.length===0);
  assert.equal((await f.call('read')).body.view.projectionPending,false);
});

test('Cron repairs a lost alarm independently of a failing store-sync branch', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  assert.equal((await f.call('execute',{command:command('takeover')})).body.outcome,'accepted');
  await f.call('clearAlarm');await f.restart();await f.call('faults',{value:{}});
  // The fixture calls the production defer helper to make only this synthetic directory due.
  const {deferControlRepair}=await import('../../src/modules/conversations/control-storage.ts');await deferControlRepair(f.db,f.scope,0);
  assert.equal((await f.call('cron',{failSync:true})).status,200);
  await until(async()=> (await readControlDirectory(f.db,f.scope))?.state.version===1);
  assert.equal((await f.call('read')).body.view.state.assignedMemberId,null,'takeover preserves the unassigned member');
});

test('projection success followed by local acknowledgment failure replays safely without duplicate receipts', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const claim=command();await f.call('faults',{value:{ack:true}});
  const result=(await f.call('execute',{command:claim})).body;assert.equal(result.outcome,'accepted');assert.equal(result.view.projectionPending,true);
  assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,1);
  await f.restart();await f.call('faults',{value:{}});await f.call('repair');
  assert.deepEqual((await f.call('execute',{command:claim})).body.receipt,result.receipt);
  const inspect=(await f.call('inspect')).body;assert.equal(inspect.receipts.length,1);assert.equal(inspect.outbox.length,0);
  await f.call('clearAuthority');assert.equal((await f.call('read')).status,500,'a projected nonzero state cannot recreate lost DO authority');
});

test('acknowledging an older projection cannot delete a command committed during D1 I/O', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{hold:true,project:true}});
  const pending=f.call('execute',{command:command()});
  try {
    await until(async()=> (await f.call('inspect')).body.projectionHeld===true);
    const next=(await f.call('execute',{command:command('resolve',1)})).body;assert.equal(next.outcome,'accepted');assert.equal(next.view.projectionPending,true);
    await f.call('release');assert.equal((await pending).body.outcome,'accepted');
    const current=(await f.call('inspect')).body;assert.equal(current.state.version,2);assert.equal(current.outbox.length,1);
    assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,1);
    await f.call('faults',{value:{}});await f.call('repair');
    assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,2);assert.equal((await f.call('inspect')).body.outbox.length,0);
  } finally {await f.call('release');await pending;}
});

test('partial authority loss cannot reuse sequence one while an unprojected receipt still exists', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  assert.equal((await f.call('execute',{command:command()})).body.outcome,'accepted');
  assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,0);
  await f.call('clearAuthority');
  assert.equal((await f.call('read')).status,500);
  assert.equal((await f.call('execute',{command:command()})).status,500);
  const inspect=(await f.call('inspect')).body;assert.equal(inspect.receipts.length,1);assert.equal(inspect.outbox.length,1);assert.equal(inspect.state,undefined);
});

test('local authority behind the projected lower bound or inconsistent at the same version fails closed', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const initial=(await f.call('read')).body.view.state;
  const committed=(await f.call('execute',{command:command()})).body.receipt.appliedState;
  await f.call('inject',{key:'state',value:initial});assert.equal((await f.call('read')).status,500);
  await f.call('inject',{key:'state',value:{...committed,reception:'paused'}});assert.equal((await f.call('read')).status,500);
  await f.call('inject',{key:'state',value:committed});assert.equal((await f.call('read')).body.view.state.version,1);
});

test('persistent projection failures rearm bounded exponential alarms instead of exhausting native retries', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  await f.call('execute',{command:command()});
  for(let count=0;count<7;count++)await f.call('repair');
  const remaining=(await f.call('inspect')).body.alarm-Date.now();assert.ok(remaining>59_000&&remaining<=60_000,`expected capped one-minute retry, got ${remaining}`);
  await f.restart();const afterRestart=(await f.call('inspect')).body.alarm-Date.now();assert.ok(afterRestart>55_000);
});

test('Cron limits a repair batch to fifty and persistent deferral lets other directories progress after failures', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  for(let index=0;index<50;index++) {
    const id=`repair-${index}`;
    await f.db.prepare("INSERT INTO conversation (id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES (?,'org','store',?,'BUYER_SELLER','Opened',1,1)").bind(id,id).run();
    assert.ok(await ensureControlDirectory(f.db,f.actor(),id,0));
  }
  await f.db.prepare('UPDATE conversation_control SET repair_due_at=0').run();
  const first=(await f.call('cron',{failRepairs:true})).body;assert.equal(first.repairs.length,50);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control WHERE repair_due_at=0').first('n'),1);
  const next=(await f.call('cron',{failRepairs:true})).body;assert.equal(next.repairs.length,1);
  assert.equal(new Set([...first.repairs,...next.repairs]).size,51);
});

test('a failing control-directory query cannot prevent the independent store-sync Cron branch', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  await f.db.batch([
    f.db.prepare("UPDATE store SET status='verified' WHERE id='store'"),
    f.db.prepare("INSERT INTO store_coordinator (store_id,organization_id) VALUES ('store','org')"),
    f.db.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,1,1,0,1)"),
  ]);
  const result=await f.call('cron',{failControls:true,recordWakes:true});assert.equal(result.status,200);
  assert.deepEqual(result.body.wakes,[JSON.stringify(['org','store'])]);
});

for(const setup of ['paused-unassigned','human-unassigned','human-assigned'] as const) {
  test(`manual reopen preserves ${setup} across a process restart and increments each counter once`, {timeout:30_000},async t=>{
    const f=await conversationControlFixture();t.after(()=>f.close());let version=0;
    if(setup!=='paused-unassigned') {
      const start=setup==='human-assigned'?'claim':'takeover';
      assert.equal((await f.call('execute',{actor:f.actor('staff'),command:command(start)})).body.outcome,'accepted');version++;
    }
    const resolved=(await f.call('execute',{command:command('resolve',version)})).body;assert.equal(resolved.outcome,'accepted');
    const previous=resolved.view.state;await f.restart();
    const result=await f.call('execute',{command:command('reopen',previous.version)});assert.equal(result.status,200);assert.equal(result.body.outcome,'accepted');
    const state=result.body.view.state;assert.equal(state.schemaVersion,2);assert.equal(state.lifecycle,'open');
    assert.equal(state.reception,previous.reception);assert.equal(state.assignedMemberId,previous.assignedMemberId);
    assert.equal(state.version,previous.version+1);assert.equal(state.controlEpoch,previous.controlEpoch+1);assert.equal(state.sequence,previous.sequence+1);
    assert.ok(state.updatedAt>=previous.updatedAt);assert.equal(result.body.view.projectionPending,false);
    assert.deepEqual((await readControlDirectory(f.db,f.scope))?.state,state);
  });
}

test('concurrent manual reopen accepts one new command; open is a state conflict and original retries are idempotent', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const noChange=await f.call('execute',{command:command('reopen')});assert.equal(noChange.status,200);assert.equal(noChange.body.reason,'state');
  assert.equal((await f.call('read')).body.view.state.version,0);
  await f.call('execute',{command:command('resolve')});
  const inputs=Array.from({length:8},(_,index)=>({command:command('reopen',1),actor:f.actor(index%2?'staff':'owner')}));
  const attempts=await Promise.all(inputs.map(input=>f.call('execute',input)));
  const winner=attempts.findIndex(attempt=>attempt.body.outcome==='accepted');assert.notEqual(winner,-1);
  assert.equal(attempts.filter(attempt=>attempt.body.outcome==='accepted').length,1);
  assert.equal(attempts.filter(attempt=>attempt.body.reason==='version').length,7);
  await f.restart();const replay=(await f.call('execute',inputs[winner])).body;
  assert.deepEqual(replay.receipt,attempts[winner].body.receipt);assert.equal(replay.view.state.version,2);
  assert.equal((await f.call('execute',{command:command('reopen',2)})).body.reason,'state');
  assert.equal((await f.call('execute',{...inputs[winner],command:{...inputs[winner].command,action:'resolve'}})).body.reason,'command');
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM conversation_control_event WHERE action='reopen'").first('n'),1);
});

test('manual reopen retains old resolve receipts and revoked actors cannot replay the reopening', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const actor=f.actor('staff'),resolve=command('resolve'),reopen=command('reopen',1);
  const original=(await f.call('execute',{actor,command:resolve})).body;assert.equal(original.outcome,'accepted');
  const accepted=(await f.call('execute',{actor,command:reopen})).body;assert.equal(accepted.outcome,'accepted');
  const replay=(await f.call('execute',{actor,command:resolve})).body;
  assert.deepEqual(replay.receipt,original.receipt);assert.equal(replay.receipt.appliedState.lifecycle,'resolved');
  assert.equal(replay.view.state.lifecycle,'open');assert.equal(replay.view.state.version,2);
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.call('execute',{actor,command:reopen})).body.outcome,'not_found');
  assert.equal((await f.call('read')).body.view.state.version,2);
});

test('manual reopen after the 0010 upgrade preserves v1 receipts and pending outbox bytes and ignores late old projection', {timeout:30_000},async t=>{
  const f=await conversationControlFixture('0010');t.after(()=>f.close());
  const claimEvent=legacyEvent(f.scope,'claim',1),resolveEvent=legacyEvent(f.scope,'resolve',2);
  await seedLegacy(f,[claimEvent,resolveEvent],1);
  const projectedBefore=await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>();
  await f.call('faults',{value:{project:true}});
  const resolve={commandId:resolveEvent.receipt.commandId,action:'resolve' as const,expectedVersion:1};
  const before=(await f.call<{receipts:[string,string][];outbox:[string,string][]}>('serialized')).body;
  assert.equal(before.outbox.length,1);const oldEvent=JSON.parse(before.outbox[0][1]) as ControlEvent;
  await f.migrateAfter('0010');await f.restart();
  assert.deepEqual((await f.call('serialized')).body,before);
  assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>()).results,projectedBefore.results);
  const reopened=(await f.call('execute',{command:command('reopen',2)})).body;assert.equal(reopened.outcome,'accepted');assert.equal(reopened.view.projectionPending,true);
  const after=(await f.call<{receipts:[string,string][];outbox:[string,string][]}>('serialized')).body;
  const receipts=new Map(after.receipts),outbox=new Map(after.outbox);
  for(const [key,value]of before.receipts)assert.equal(receipts.get(key),value);
  for(const [key,value]of before.outbox)assert.equal(outbox.get(key),value);
  await f.call('faults',{value:{}});await f.call('repair');
  assert.equal((await readControlDirectory(f.db,f.scope))?.state.lifecycle,'open');
  await projectControlEvents(f.db,f.scope,[oldEvent],Date.now());
  assert.equal((await readControlDirectory(f.db,f.scope))?.state.version,3);assert.equal((await readControlDirectory(f.db,f.scope))?.state.lifecycle,'open');
  const oldAudit=await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=2').first('receipt');
  assert.equal(oldAudit,JSON.stringify(oldEvent.receipt));assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),3);
  assert.deepEqual((await f.call('execute',{command:resolve})).body.receipt,resolveEvent.receipt);
});

test('historical message synchronization never invokes manual reopen', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const resolved=(await f.call('execute',{command:command('resolve')})).body;assert.equal(resolved.outcome,'accepted');
  await f.db.batch([
    f.db.prepare("UPDATE store SET status='verified' WHERE id='store'"),
    f.db.prepare("INSERT INTO store_coordinator (store_id,organization_id) VALUES ('store','org')"),
    f.db.prepare("INSERT INTO store_sync_source (store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,1,1,0,1)"),
    f.db.prepare("INSERT INTO sync_cursor (store_id,organization_id,thread_id,conversation_id,stream,due_at) VALUES ('store','org','thread','conv','backfill',0)"),
  ]);
  const lease=await claimSyncLease(f.db,{orgId:'org',storeId:'store',source:'chat',token:crypto.randomUUID()});assert.ok(lease);
  const cursor=await getDueSyncCursor(f.db,lease);assert.ok(cursor);
  assert.ok(await commitSyncPage(f.db,lease,{cursor,nextCursor:null,nextDueAt:Date.now()+60_000,completed:true,
    messages:[{platformThreadId:'thread',platformMessageId:'historical-after-resolve',senderId:'buyer',senderType:'Customer',content:['Historical message'],isImage:false,isRead:true,orderNumber:null,sku:null,eventAt:100,direction:'inbound'}]}));
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM message').first('n'),1);
  assert.equal(await f.db.prepare('SELECT state FROM ingest_event').first('state'),'historical');
  assert.deepEqual((await f.call('read')).body.view.state,resolved.view.state);
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM conversation_control_event WHERE action='reopen'").first('n'),0);
});

test('work status changes only on open conversations and survives claim, takeover, resolution and reopen', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const initial=(await f.call('read')).body.view.state;assert.equal(initial.schemaVersion,2);assert.equal(initial.workStatus,'needs_reply');
  let version=0;
  for(const status of ['waiting_customer','waiting_internal','needs_reply'] as const) {
    const result=await f.call('execute',{command:workCommand(status,version)});assert.equal(result.status,200);assert.equal(result.body.outcome,'accepted');version++;
    const state=result.body.view.state;assert.equal(state.workStatus,status);assert.equal(state.reception,'paused');assert.equal(state.assignedMemberId,null);
    assert.equal(state.version,version);assert.equal(state.controlEpoch,version);assert.equal(state.sequence,version);
    assert.equal(result.body.receipt.workStatus,status);
  }
  assert.equal((await f.call('execute',{command:workCommand('needs_reply',version)})).body.reason,'state');
  await f.call('execute',{command:workCommand('waiting_customer',version++)});
  const claimed=(await f.call('execute',{command:command('claim',version++)})).body;
  assert.equal(claimed.view.state.workStatus,'waiting_customer');assert.equal(claimed.view.state.assignedMemberId,'owner-member');
  await f.restart();assert.equal((await f.call('read')).body.view.state.workStatus,'waiting_customer');
  const resolved=(await f.call('execute',{command:command('resolve',version++)})).body;assert.equal(resolved.view.state.workStatus,null);
  assert.equal((await f.call('execute',{command:workCommand('waiting_internal',version)})).body.reason,'state');
  const reopened=(await f.call('execute',{command:command('reopen',version)})).body;assert.equal(reopened.view.state.workStatus,'needs_reply');
  const second=await ensureControlDirectory(f.db,f.actor(),'second',Date.now());assert.ok(second);
  await f.call('execute',{command:workCommand('waiting_internal')},second.scope);
  assert.equal((await f.call('execute',{command:command('takeover',1)},second.scope)).body.view.state.workStatus,'waiting_internal');
});

test('strict RPC command union rejects old-action workStatus, unknown fields and invalid waiting targets without changes', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const invalid=[{...command(),workStatus:'waiting_customer'},{...command('resolve'),workStatus:null},{...command(),extra:true},
    {commandId:crypto.randomUUID(),action:'set_work_status',expectedVersion:0},
    {...workCommand('waiting_customer'),workStatus:null},{...workCommand('waiting_customer'),workStatus:'resolved'},
    {...workCommand('waiting_customer'),extra:true}];
  for(const input of invalid)assert.equal((await f.call('execute',{command:input})).status,500);
  assert.equal((await f.call('read')).body.view.state.version,0);
  assert.equal((await f.call('inspect')).body.receipts.length,0);
});

test('concurrent waiting changes have one winner and replay binds the requested workStatus and actor', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const inputs=Array.from({length:8},(_,index)=>({command:workCommand(index%2?'waiting_customer':'waiting_internal'),actor:f.actor('staff')}));
  const results=await Promise.all(inputs.map(input=>f.call('execute',input)));
  const winner=results.findIndex(result=>result.body.outcome==='accepted');assert.notEqual(winner,-1);
  assert.equal(results.filter(result=>result.body.outcome==='accepted').length,1);assert.equal(results.filter(result=>result.body.reason==='version').length,7);
  const nextStatus=inputs[winner].command.workStatus==='waiting_customer'?'waiting_internal':'waiting_customer';
  assert.equal((await f.call('execute',{command:workCommand(nextStatus,1)})).body.outcome,'accepted');
  const replay=(await f.call('execute',inputs[winner])).body;assert.deepEqual(replay.receipt,results[winner].body.receipt);assert.equal(replay.view.state.workStatus,nextStatus);
  assert.equal((await f.call('execute',{...inputs[winner],command:{...inputs[winner].command,workStatus:nextStatus}})).body.reason,'command');
  assert.equal((await f.call('execute',{...inputs[winner],actor:f.actor()})).body.reason,'command');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.call('execute',inputs[winner])).body.outcome,'not_found');
});

test('waiting status receipt and v2 authority survive failed projection and restart until alarm recovery', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  const input=workCommand('waiting_internal'),accepted=(await f.call('execute',{command:input})).body;
  assert.equal(accepted.outcome,'accepted');assert.equal(accepted.view.projectionPending,true);
  await f.restart();assert.equal((await f.call('read')).body.view.state.workStatus,'waiting_internal');
  await f.call('faults',{value:{}});await f.call('retrySoon');
  await until(async()=> (await readControlDirectory(f.db,f.scope))?.state.version===1&&(await f.call('inspect')).body.outbox.length===0);
  assert.deepEqual((await f.call('execute',{command:input})).body.receipt,accepted.receipt);
});

for(const lifecycle of ['open','resolved'] as const) {
  test(`v1 ${lifecycle} upgrades only local state while old receipt, outbox, counters, timestamp and alarm remain unchanged`, {timeout:30_000},async t=>{
    const f=await conversationControlFixture('0011');t.after(()=>f.close());
    const events=[legacyEvent(f.scope,'claim',1)];if(lifecycle==='resolved')events.push(legacyEvent(f.scope,'resolve',2));
    await seedLegacy(f,events,events.length);const last=events.at(-1)!;
    // The old D1 projection succeeded, but the previous process did not acknowledge its outbox.
    await f.call('inject',{key:`event:${String(last.receipt.appliedState.sequence).padStart(16,'0')}`,value:last});
    const alarm=Date.now()+60_000;await f.call('alarmAt',{value:alarm});
    const before=(await f.call('serialized')).body;
    const audit=(await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>()).results;
    await f.migrateAfter('0011');await f.restart();
    const response=(await f.call('read')).body;assert.equal(response.outcome,'found');
    assert.deepEqual(response.view.state,{...last.receipt.appliedState,schemaVersion:2,workStatus:lifecycle==='open'?'needs_reply':null});
    const persisted=(await f.call('inspect')).body;assert.deepEqual(persisted.state,response.view.state);assert.equal(persisted.alarm,alarm);
    assert.deepEqual((await f.call('serialized')).body,before);
    assert.equal(await f.db.prepare('SELECT schema_version FROM conversation_control').first('schema_version'),1);
    assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>()).results,audit);
    const receipt=last.receipt;const replay=(await f.call('execute',{command:{commandId:receipt.commandId,expectedVersion:receipt.expectedVersion,action:receipt.action}})).body;
    assert.equal(replay.outcome,'accepted');assert.deepEqual(replay.receipt,receipt);assert.equal(replay.receipt.appliedState.schemaVersion,1);
    assert.equal(replay.view.state.schemaVersion,2);assert.equal(replay.view.state.version,receipt.appliedState.version);assert.equal(replay.view.projectionPending,false);
    assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>()).results,audit);
  });
}

test('v1 state conversion rolls back with a failed business transaction instead of partially upgrading authority', {timeout:30_000},async t=>{
  const f=await conversationControlFixture('0011');t.after(()=>f.close());
  const oldState:LegacyControlState={schemaVersion:1,version:0,controlEpoch:0,sequence:0,lifecycle:'open',reception:'paused',assignedMemberId:null,updatedAt:0};
  await f.call('inject',{key:'scope',value:f.scope});await f.call('inject',{key:'state',value:oldState});
  await f.migrateAfter('0011');await f.call('faults',{value:{commit:true}});
  assert.equal((await f.call('execute',{command:workCommand('waiting_customer')})).status,500);
  const local=(await f.call('inspect')).body;assert.deepEqual(local.state,oldState);assert.deepEqual(local.receipts,[]);assert.deepEqual(local.outbox,[]);assert.equal(local.alarm,null);
});

test('manual transfer preserves work status and changes responsibility with one new control epoch', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  assert.equal((await f.call('execute',{command:workCommand('waiting_internal')})).body.outcome,'accepted');
  const transferred=(await f.call('execute',{command:transferCommand('staff-member',1,'  需要技术支持  ')})).body;
  assert.equal(transferred.outcome,'accepted');assert.equal(transferred.receipt.reason,'需要技术支持');
  assert.deepEqual({...transferred.view.state,updatedAt:0},{schemaVersion:2,version:2,controlEpoch:2,sequence:2,lifecycle:'open',reception:'human',assignedMemberId:'staff-member',updatedAt:0,workStatus:'waiting_internal'});
  assert.equal((await f.call('execute',{command:transferCommand('staff-member',2)})).body.reason,'state');
  const self=(await f.call('execute',{command:transferCommand('owner-member',2)})).body;assert.equal(self.outcome,'accepted');assert.equal(self.view.state.assignedMemberId,'owner-member');
  assert.equal((await f.call('execute',{command:command('resolve',3)})).body.outcome,'accepted');
  const closed=(await f.call('execute',{command:transferCommand('staff-member',4)})).body;assert.equal(closed.outcome,'conflict');assert.equal(closed.reason,'state');
  assert.equal(closed.view.state.version,4);assert.equal(await f.db.prepare("SELECT count(*) AS n FROM conversation_control_event WHERE action='transfer'").first('n'),2);
});

test('manual transfer target eligibility is independent of target sessions and never hides an authorized actor', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  for(const [id,org,role]of [['admin','org','admin'],['ungranted','org','member'],['foreign','other-org','owner'],['unverified','org','owner']])await f.db.batch([
    f.db.prepare('INSERT INTO user(id,name,email,email_verified) VALUES (?,?,?,1)').bind(id,id,`${id}@example.invalid`),
    f.db.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').bind(`${id}-member`,org,id,role),
  ]);
  await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='unverified'").run();
  for(const target of ['missing-member','ungranted-member','foreign-member','unverified-member']) {
    const result=(await f.call('execute',{command:transferCommand(target)})).body;
    assert.equal(result.outcome,'conflict');assert.equal(result.reason,'target');assert.equal(result.view.viewerMemberId,'owner-member');assert.equal(result.view.state.version,0);
  }
  assert.equal((await f.call('execute',{command:transferCommand('admin-member')})).body.outcome,'accepted');
  await f.db.prepare("DELETE FROM session WHERE user_id='staff'").run();
  assert.equal((await f.call('execute',{command:transferCommand('staff-member',1)})).body.outcome,'accepted');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  const deniedActor=(await f.call('execute',{actor:f.actor('staff'),command:transferCommand('missing-member',2)})).body;
  assert.equal(deniedActor.outcome,'not_found');
});

test('manual transfer replay survives target removal but binds reason, target and fresh actor identity', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const transfer=transferCommand('staff-member',0,' 协助售后 ');
  const first=(await f.call('execute',{command:transfer})).body;assert.equal(first.outcome,'accepted');
  assert.equal((await f.call('execute',{command:workCommand('waiting_customer',1)})).body.outcome,'accepted');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();await f.restart();
  const replay=(await f.call('execute',{command:{...transfer,reason:'协助售后'}})).body;
  assert.equal(replay.outcome,'accepted');assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.view.state.version,2);assert.equal(replay.view.state.workStatus,'waiting_customer');
  for(const next of [{...transfer,targetMemberId:'owner-member'},{...transfer,reason:'另一个原因'},{...transfer,expectedVersion:2}]) {
    const result=(await f.call('execute',{command:next})).body;assert.equal(result.outcome,'conflict');assert.equal(result.reason,'command');
  }
  const directory=await ensureControlDirectory(f.db,f.actor(),'second',Date.now());assert.ok(directory);
  assert.equal((await f.call('execute',{command:transferCommand('staff-member')},directory.scope)).body.reason,'target');
  await f.db.prepare("DELETE FROM session WHERE id='owner-session'").run();
  assert.equal((await f.call('execute',{command:transfer})).body.outcome,'not_found');
});

test('concurrent manual transfers have one winner and revoked caller grants reject receipt replay', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const attempts=Array.from({length:8},(_,i)=>({actor:f.actor(i%2?'staff':'owner'),command:transferCommand(i%2?'owner-member':'staff-member')}));
  const results=await Promise.all(attempts.map(attempt=>f.call('execute',attempt)));
  assert.equal(results.filter(r=>r.body.outcome==='accepted').length,1);assert.equal(results.filter(r=>r.body.reason==='version').length,7);
  const actor=f.actor('staff'),next=transferCommand((await f.call('read')).body.view.state.assignedMemberId==='owner-member'?'staff-member':'owner-member',1);
  const accepted=(await f.call('execute',{actor,command:next})).body;assert.equal(accepted.outcome,'accepted');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
  assert.equal((await f.call('execute',{actor,command:next})).body.outcome,'not_found');
  assert.equal((await f.call('read')).body.view.state.version,2);
});

test('manual transfer strict RPC union trims bounded reasons and rejects missing or extra payload fields', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const base=transferCommand();
  const invalid=[{...base,reason:undefined},{...base,reason:' \n\t '},{...base,reason:'x'.repeat(501)},{...base,reason:3},{...base,targetMemberId:undefined},{...base,targetMemberId:''},{...base,targetMemberId:'x'.repeat(257)},{...base,workStatus:'needs_reply'},{...command(),targetMemberId:'staff-member',reason:'extra'}];
  for(const input of invalid)assert.equal((await f.call('execute',{command:input})).status,500);
  const initial=(await f.call('read')).body.view.state;assert.equal(initial.version,0);
  assert.equal((await f.call('inspect')).body.receipts.length,0);
  const valid=(await f.call('execute',{command:{...base,reason:` ${'x'.repeat(500)} `}})).body;
  assert.equal(valid.outcome,'accepted');assert.equal(valid.receipt.reason,'x'.repeat(500));
});

test('manual transfer transaction rollback and projection restart preserve one durable receipt and reason', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const transfer=transferCommand();
  await f.call('faults',{value:{commit:true}});assert.equal((await f.call('execute',{command:transfer})).status,500);
  const rolledBack=(await f.call('inspect')).body;assert.equal(rolledBack.state,undefined);assert.equal(rolledBack.receipts.length,0);assert.equal(rolledBack.outbox.length,0);assert.equal(rolledBack.alarm,null);
  await f.call('faults',{value:{project:true}});const accepted=(await f.call('execute',{command:transfer})).body;
  assert.equal(accepted.outcome,'accepted');assert.equal(accepted.view.projectionPending,true);await f.restart();
  assert.deepEqual((await f.call('execute',{command:transfer})).body.receipt,accepted.receipt);
  await f.call('faults',{value:{}});await f.call('retrySoon');
  await until(async()=>await f.db.prepare("SELECT count(*) AS n FROM conversation_control_event WHERE action='transfer'").first('n')===1);
  assert.equal((await f.call('read')).body.view.projectionPending,false);
  const audit=JSON.parse(await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE action='transfer'").first('receipt') as string);
  assert.equal(audit.targetMemberId,'staff-member');assert.equal(audit.reason,transfer.reason);assert.deepEqual(audit.appliedState,accepted.view.state);
});

test('manual transfer after the 0012 upgrade retains old v2 receipts, pending events and work status', {timeout:30_000},async t=>{
  const f=await conversationControlFixture('0012');t.after(()=>f.close());
  const waiting=workCommand('waiting_internal'),first=(await f.call('execute',{command:waiting})).body;assert.equal(first.outcome,'accepted');
  await f.call('faults',{value:{project:true}});const claim=command('claim',1);assert.equal((await f.call('execute',{command:claim})).body.outcome,'accepted');
  const before=(await f.call<{receipts:[string,string][];outbox:[string,string][]}>('serialized')).body;
  const auditBefore=await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>();assert.equal(before.outbox.length,1);
  await f.migrateAfter('0012');await f.restart();assert.deepEqual((await f.call('serialized')).body,before);
  assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all<{receipt:string}>()).results,auditBefore.results);
  const transfer=(await f.call('execute',{command:transferCommand('staff-member',2)})).body;assert.equal(transfer.outcome,'accepted');assert.equal(transfer.view.state.workStatus,'waiting_internal');assert.equal(transfer.view.state.schemaVersion,2);
  const after=(await f.call<{receipts:[string,string][];outbox:[string,string][]}>('serialized')).body;
  for(const [key,value]of before.receipts)assert.equal(new Map(after.receipts).get(key),value);
  for(const [key,value]of before.outbox)assert.equal(new Map(after.outbox).get(key),value);
  await f.call('faults',{value:{}});await f.call('repair');
  const replay=(await f.call('execute',{command:waiting})).body;assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.view.state.version,3);assert.equal(replay.view.state.assignedMemberId,'staff-member');
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),3);
});

test('manual transfer refuses an inconsistent stored transfer receipt instead of accepting its retry', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const state=(await f.call('read')).body.view.state;
  for(const patch of [{schemaVersion:1,workStatus:undefined},{lifecycle:'resolved',workStatus:null},{reception:'paused'},{assignedMemberId:'owner-member'}]) {
    const transfer=transferCommand(),receipt={...transfer,actorUserId:'owner',actorMemberId:'owner-member',appliedState:{...state,version:1,controlEpoch:1,sequence:1,reception:'human',assignedMemberId:'staff-member',...patch}};
    await f.call('inject',{key:`receipt:${transfer.commandId}`,value:receipt});
    assert.equal((await f.call('execute',{command:transfer})).status,500);
  }
  assert.equal((await f.call('read')).body.view.state.version,0);
});

test('internal note preserves handling on open and resolved conversations while only version and sequence advance', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  const initial=(await f.call('read')).body.view.state;
  const first=(await f.call('execute',{command:noteCommand('  原文\n<script>仅文字</script>\t  ')})).body;
  assert.equal(first.outcome,'accepted');
  assert.deepEqual({...first.view.state,version:0,sequence:0,updatedAt:0},initial);
  assert.equal(first.view.state.version,1);assert.equal(first.view.state.sequence,1);assert.equal(first.receipt.authorName,'owner');
  assert.equal((await f.call('execute',{command:command('claim',1)})).body.outcome,'accepted');
  const waiting=(await f.call('execute',{command:workCommand('waiting_customer',2)})).body.view.state;
  const open=(await f.call('execute',{command:noteCommand('等待处理',3)})).body;assert.equal(open.outcome,'accepted');
  assert.deepEqual({...open.view.state,version:3,sequence:3,updatedAt:waiting.updatedAt},waiting);
  const resolved=(await f.call('execute',{command:command('resolve',4)})).body.view.state;
  const closed=(await f.call('execute',{command:noteCommand('解决后的记录',5)})).body;assert.equal(closed.outcome,'accepted');
  assert.deepEqual({...closed.view.state,version:5,sequence:5,updatedAt:resolved.updatedAt},resolved);
  const notes=(await f.call('notes')).body;
  assert.equal(notes.outcome,'found');assert.deepEqual(notes.notes.map((note:any)=>note.sequence),[6,4,1]);
  assert.equal(notes.notes[2].body,first.receipt.body);assert.equal(notes.notes[2].createdAt,first.receipt.appliedState.updatedAt);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM message').first('n'),0);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM ingest_event').first('n'),0);
});

test('internal note remains authoritative through failed projection, process restart, alarm recovery and lost-alarm Cron repair', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.call('faults',{value:{project:true}});
  const command=noteCommand(),first=(await f.call('execute',{command})).body;assert.equal(first.outcome,'accepted');assert.equal(first.view.projectionPending,true);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),0);
  const before=(await f.call('notes')).body;assert.equal(before.notes[0].body,command.body);
  await f.restart();assert.deepEqual((await f.call('notes')).body,before);
  await f.call('faults',{value:{}});await f.call('retrySoon');
  await until(async()=> (await f.call('inspect')).body.outbox.length===0);
  assert.deepEqual((await f.call('notes')).body,before);
  await f.call('faults',{value:{project:true}});assert.equal((await f.call('execute',{command:noteCommand('第二条',1)})).body.outcome,'accepted');
  await f.call('clearAlarm');await f.restart();await f.call('faults',{value:{}});
  const {deferControlRepair}=await import('../../src/modules/conversations/control-storage.ts');await deferControlRepair(f.db,f.scope,0);
  assert.equal((await f.call('cron',{failSync:true})).status,200);
  await until(async()=> (await f.call('inspect')).body.outbox.length===0);
  assert.equal((await f.call('notes')).body.notes.length,2);assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),2);
});

test('internal note acknowledgment failure and a later commit cannot erase either note index', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const firstCommand=noteCommand('first');
  await f.call('faults',{value:{ack:true}});const first=(await f.call('execute',{command:firstCommand})).body;assert.equal(first.outcome,'accepted');assert.equal(first.view.projectionPending,true);
  await f.restart();await f.call('faults',{value:{}});assert.deepEqual((await f.call('execute',{command:firstCommand})).body.receipt,first.receipt);
  await f.call('faults',{value:{hold:true,project:true}});const pending=f.call('execute',{command:noteCommand('second',1)});
  try{
    await until(async()=> (await f.call('inspect')).body.projectionHeld===true);
    assert.equal((await f.call('execute',{command:noteCommand('third',2)})).body.outcome,'accepted');
    await f.call('release');assert.equal((await pending).body.outcome,'accepted');
    const inspection=(await f.call('inspect')).body;assert.equal(inspection.notes.length,3);assert.equal(inspection.outbox.length,1);
    await f.call('faults',{value:{}});await f.call('repair');
    assert.equal((await f.call('notes')).body.notes.length,3);assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),3);
  }finally{await f.call('release');await pending;}
});

test('internal note transaction failure leaves no orphan index, receipt, audit or alarm', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const initial=(await f.call('read')).body.view.state,command=noteCommand();
  await f.call('faults',{value:{commit:true}});assert.equal((await f.call('execute',{command})).status,500);
  const failed=(await f.call('inspect')).body;assert.deepEqual(failed.state,initial);assert.deepEqual(failed.notes,[]);assert.deepEqual(failed.receipts,[]);assert.deepEqual(failed.outbox,[]);assert.equal(failed.alarm,null);
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),0);
  await f.call('faults',{value:{}});assert.equal((await f.call('execute',{command})).body.outcome,'accepted');assert.equal((await f.call('notes')).body.notes.length,1);
});

test('internal note idempotency compares exact body and actor while concurrent duplicate commands produce one note', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const command=noteCommand('  保留空白\r\n');
  const attempts=await Promise.all(Array.from({length:6},()=>f.call('execute',{command})));
  assert.ok(attempts.every(result=>result.body.outcome==='accepted'));
  for(const attempt of attempts)assert.deepEqual(attempt.body.receipt,attempts[0].body.receipt);
  assert.equal((await f.call('notes')).body.notes.length,1);assert.equal((await f.call('read')).body.view.state.version,1);
  for(const extra of [{command:{...command,body:command.body.trim()}},{command:{...command,expectedVersion:1}},{command,actor:f.actor('staff')}]) {
    const result=(await f.call('execute',extra)).body;assert.equal(result.outcome,'conflict');assert.equal(result.reason,'command');
  }
  assert.equal(await f.db.prepare('SELECT count(*) AS n FROM conversation_control_event').first('n'),1);
});

test('internal note and transfer sharing a version accept only one command and retain distinct epoch semantics', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const note=noteCommand(),transfer=transferCommand();
  const results=await Promise.all([f.call('execute',{command:note}),f.call('execute',{command:transfer})]);
  assert.equal(results.filter(result=>result.body.outcome==='accepted').length,1);assert.equal(results.filter(result=>result.body.reason==='version').length,1);
  const noteWon=results[0].body.outcome==='accepted',state=(await f.call('read')).body.view.state;
  assert.equal(state.controlEpoch,noteWon?0:1);assert.equal((await f.call('notes')).body.notes.length,noteWon?1:0);
  const retry=noteWon?{...transfer,commandId:crypto.randomUUID(),expectedVersion:1}:{...note,commandId:crypto.randomUUID(),expectedVersion:1};
  assert.equal((await f.call('execute',{command:retry})).body.outcome,'accepted');
  const final=(await f.call('read')).body.view.state;assert.equal(final.version,2);assert.equal(final.sequence,2);assert.equal(final.controlEpoch,1);assert.equal(final.assignedMemberId,'staff-member');
  assert.equal((await f.call('notes')).body.notes.length,1);
});

test('internal note author snapshots survive renaming and membership removal but replay needs the original member identity', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());await f.db.prepare("UPDATE user SET name='原作者' WHERE id='owner'").run();
  const command=noteCommand(),first=(await f.call('execute',{command})).body;assert.equal(first.outcome,'accepted');assert.equal(first.receipt.authorName,'原作者');
  await f.db.prepare("UPDATE user SET name='新姓名' WHERE id='owner'").run();assert.deepEqual((await f.call('execute',{command})).body.receipt,first.receipt);
  await f.db.batch([
    f.db.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('backup-owner','Backup owner','backup@example.test',1,1,1)"),
    f.db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('backup-owner-member','org','backup-owner','owner',1)"),
  ]);
  await f.db.prepare("DELETE FROM member WHERE id='owner-member'").run();
  assert.equal((await f.call('notes')).body.outcome,'not_found');assert.equal((await f.call('execute',{command})).body.outcome,'not_found');
  const history=(await f.call('notes',{actor:f.actor('staff')})).body;assert.equal(history.notes[0].authorName,'原作者');assert.equal(history.notes[0].authorMemberId,'owner-member');
  await f.db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('new-owner-member','org','owner','owner',2)").run();
  assert.equal((await f.call('execute',{command})).body.reason,'command');
  assert.equal((await f.call('execute',{command:noteCommand('再次加入',1)})).body.receipt.authorName,'新姓名');
  const notes=(await f.call('notes')).body.notes;assert.equal(notes[0].authorMemberId,'new-owner-member');assert.equal(notes[1].authorMemberId,'owner-member');
  await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.call('notes',{actor:f.actor('staff')})).body.outcome,'not_found');
});

test('internal note pagination uses exclusive sequence boundaries across gaps and concurrent appends', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());assert.deepEqual((await f.call('notes')).body,{outcome:'found',notes:[],nextBeforeSequence:null});
  for(const input of [noteCommand('one'),command('takeover',1),noteCommand('three',2),workCommand('waiting_internal',3),noteCommand('five',4)])assert.equal((await f.call('execute',{command:input})).body.outcome,'accepted');
  const first=(await f.call('notes',{limit:2})).body;assert.deepEqual(first.notes.map((note:any)=>note.sequence),[5,3]);assert.equal(first.nextBeforeSequence,3);
  assert.equal((await f.call('execute',{command:noteCommand('six',5)})).body.outcome,'accepted');
  const second=(await f.call('notes',{limit:2,beforeSequence:first.nextBeforeSequence})).body;assert.deepEqual(second.notes.map((note:any)=>note.sequence),[1]);assert.equal(second.nextBeforeSequence,null);
  assert.deepEqual((await f.call('notes',{beforeSequence:1})).body.notes,[]);
  assert.deepEqual((await f.call('notes',{limit:2})).body.notes.map((note:any)=>note.sequence),[6,5]);
  for(const input of [{limit:0},{limit:51},{limit:1.5},{limit:null},{beforeSequence:0},{beforeSequence:-1},{beforeSequence:1.5},{beforeSequence:Number.MAX_SAFE_INTEGER+1},{beforeSequence:'3'}])assert.equal((await f.call('notes',input)).status,500);
  assert.equal((await f.call('notes',{name:'wrong-object'})).body.outcome,'not_found');
  assert.equal((await f.call('notes',{}, {...f.scope,organizationId:'other-org'})).body.outcome,'not_found');
});

test('internal note rejects invalid or forged payloads and accepts exactly four thousand well-formed UTF-16 units', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());
  for(const body of ['', ' \r\n\t ', 'a'.repeat(4001), '\u0000', '\u0001', '\u007f', '\ud800', '\udc00', null, 3])assert.equal((await f.call('execute',{command:{...noteCommand(),body}})).status,500);
  for(const input of [{...noteCommand(),authorName:'forged'},{...noteCommand(),targetMemberId:'staff-member'},{...command(),body:'unexpected'}])assert.equal((await f.call('execute',{command:input})).status,500);
  const body='a'.repeat(3998)+'😀';assert.equal(body.length,4000);
  const accepted=(await f.call('execute',{command:noteCommand(body)})).body;assert.equal(accepted.outcome,'accepted');assert.equal(accepted.receipt.body,body);
  assert.equal((await f.call('execute',{command:noteCommand('a'.repeat(3999)+'😀',1)})).status,500);
  const whitespace='\t前\r\n后 ';assert.equal((await f.call('execute',{command:noteCommand(whitespace,1)})).body.receipt.body,whitespace);
  assert.equal((await f.call('notes')).body.notes.length,2);
});

test('internal note may keep an exhausted epoch but cannot overflow either counter it changes', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const initial=(await f.call('read')).body.view.state;
  await f.call('inject',{key:'state',value:{...initial,version:1,sequence:1,controlEpoch:Number.MAX_SAFE_INTEGER}});
  const note=(await f.call('execute',{command:noteCommand('保留 epoch',1)})).body;assert.equal(note.outcome,'accepted');assert.equal(note.view.state.controlEpoch,Number.MAX_SAFE_INTEGER);assert.equal(note.view.state.version,2);
  await f.call('inject',{key:'state',value:{...note.view.state,version:3,sequence:Number.MAX_SAFE_INTEGER}});
  assert.equal((await f.call('execute',{command:noteCommand('不能溢出',3)})).status,500);assert.equal((await f.call('inspect')).body.notes.length,1);
});

test('internal note index and receipt mismatches fail closed instead of hiding missing records', {timeout:30_000},async t=>{
  const f=await conversationControlFixture();t.after(()=>f.close());const input=noteCommand(),accepted=(await f.call('execute',{command:input})).body;assert.equal(accepted.outcome,'accepted');
  const key='note:0000000000000001';
  for(const target of ['missing-command',17]){await f.call('inject',{key,value:target});assert.equal((await f.call('notes')).status,500);}
  await f.call('inject',{key,value:input.commandId});
  for(const patch of [{body:'\u0000'},{authorName:null},{commandId:'wrong-command'},{action:'claim'},{appliedState:{...accepted.receipt.appliedState,sequence:2}}]) {
    await f.call('inject',{key:`receipt:${input.commandId}`,value:{...accepted.receipt,...patch}});assert.equal((await f.call('notes')).status,500);
  }
  await f.call('inject',{key:`receipt:${input.commandId}`,value:accepted.receipt});assert.equal((await f.call('notes')).body.notes.length,1);
});

test('internal note residue prevents reinitializing missing authority and the 0013 upgrade preserves older raw receipts', {timeout:30_000},async t=>{
  const f=await conversationControlFixture('0013');t.after(()=>f.close());
  const waiting=workCommand('waiting_internal');assert.equal((await f.call('execute',{command:waiting})).body.outcome,'accepted');
  await f.call('faults',{value:{project:true}});assert.equal((await f.call('execute',{command:transferCommand('staff-member',1)})).body.outcome,'accepted');
  const before=(await f.call('serialized')).body,audit=await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all();
  await f.migrateAfter('0013');await f.restart();assert.deepEqual((await f.call('serialized')).body,before);
  assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all()).results,audit.results);
  const accepted=(await f.call('execute',{command:noteCommand('升级之后',2)})).body;assert.equal(accepted.outcome,'accepted');assert.equal(accepted.view.state.workStatus,'waiting_internal');assert.equal(accepted.view.state.assignedMemberId,'staff-member');assert.equal(accepted.view.state.controlEpoch,2);
  const after=(await f.call('serialized')).body;for(const [key,value]of before.receipts)assert.equal(new Map(after.receipts).get(key),value);for(const [key,value]of before.outbox)assert.equal(new Map(after.outbox).get(key),value);
  await f.call('faults',{value:{}});await f.call('repair');assert.equal((await f.call('notes')).body.notes.length,1);
  const other=await ensureControlDirectory(f.db,f.actor(),'second',Date.now());assert.ok(other);
  await f.call('inject',{key:'note:0000000000000001',value:'orphan'},other.scope);
  assert.equal((await f.call('notes',{},other.scope)).status,500);assert.equal((await f.call('read',{},other.scope)).status,500);
  const lost=(await f.call('inspect',{},other.scope)).body;assert.equal(lost.state,undefined);assert.equal(lost.scope,undefined);assert.equal(lost.notes.length,1);
});
