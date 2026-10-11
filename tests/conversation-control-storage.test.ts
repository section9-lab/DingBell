import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { deferControlRepair, ensureControlDirectory, listControlTransferTargets, listDueControlDirectories, projectControlEvents, readControlAccess, readControlAssignee, readControlDirectory } from '../src/modules/conversations/control-storage.ts';
import { normalizeControlState } from '../src/modules/conversations/control-state.ts';
import type { ControlActor, ControlEvent, ControlScope } from '../src/modules/conversations/control-types.ts';

const owner:ControlActor={orgId:'org',actorUserId:'owner-user',sessionId:'owner-session'};
const staff:ControlActor={orgId:'org',actorUserId:'staff-user',sessionId:'staff-session'};
async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("control fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const db=await mf.getD1Database('DB') as unknown as D1Database;
    const folder=new URL('../migrations/',import.meta.url);
    for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
    await db.batch([
      db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('other','Other','other',1)"),
      db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner-user','Owner','owner@example.invalid',1),('staff-user','Staff','staff@example.invalid',1)"),
      db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner-user','owner',1),('staff-member','org','staff-user','member',1)"),
      db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('owner-session','owner-session','owner-user',?,1,1),('staff-session','staff-session','staff-user',?,1,1)").bind(Date.now()+120_000,Date.now()+120_000),
      db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1),('hidden','org','Hidden','2','verified',1,1),('foreign','other','Foreign','3','verified',1,1)"),
      db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)"),
      db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES ('conv','org','store','chat','BUYER_SELLER','Opened',1,1),('conv-2','org','store','chat-2','BUYER_SELLER','Opened',1,1),('hidden-conv','org','hidden','hidden','BUYER_SELLER','Opened',1,1),('foreign-conv','other','foreign','foreign','BUYER_SELLER','Opened',1,1)"),
    ]);
    return {db,close:()=>mf.dispose()};
  }catch(error){
    await mf.dispose().catch(()=>{});
    throw error;
  }
}
function event(scope:ControlScope,sequence:number,action:Exclude<ControlEvent['receipt']['action'],'set_work_status'|'transfer'|'add_note'|'send_reply'|'cancel_reply'>='claim'):ControlEvent{
  return {scope,receipt:{commandId:`command-${sequence}`,expectedVersion:sequence-1,action,actorUserId:'staff-user',actorMemberId:'staff-member',appliedState:{schemaVersion:1,version:sequence,controlEpoch:sequence,sequence,lifecycle:action==='resolve'?'resolved':'open',reception:'human',assignedMemberId:'staff-member',updatedAt:sequence*100}}};
}
function workEvent(scope:ControlScope,sequence:number):ControlEvent{
  return {scope,receipt:{...event(scope,sequence).receipt,action:'set_work_status',workStatus:'waiting_customer',appliedState:{...normalizeControlState(event(scope,sequence).receipt.appliedState),lifecycle:'open',workStatus:'waiting_customer'}}};
}
function transferEvent(scope:ControlScope,sequence:number):ControlEvent{
  return {scope,receipt:{...event(scope,sequence).receipt,action:'transfer',targetMemberId:'owner-member',reason:'请继续处理',appliedState:{...normalizeControlState(event(scope,sequence).receipt.appliedState),lifecycle:'open',workStatus:'waiting_internal',assignedMemberId:'owner-member'}}};
}
function noteEvent(scope:ControlScope,sequence:number):ControlEvent{
  return {scope,receipt:{commandId:`note-${sequence}`,expectedVersion:sequence-1,action:'add_note',body:'  内部备注\r\n\t请继续跟进  ',actorUserId:'staff-user',actorMemberId:'staff-member',authorName:'Staff',appliedState:{schemaVersion:2,version:sequence,controlEpoch:1,sequence,lifecycle:'resolved',reception:'human',assignedMemberId:'staff-member',workStatus:null,updatedAt:sequence*100}}};
}

test('note authorization captures the current member name with the same fresh access snapshot',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.equal((await readControlAccess(f.db,staff,'conv'))?.memberName,'Staff');
    await f.db.prepare("UPDATE user SET name='新名称' WHERE id='staff-user'").run();
    const access=await readControlAccess(f.db,staff,'conv');assert.equal(access?.memberName,'新名称');assert.equal(access?.memberId,'staff-member');
    assert.equal(await readControlAccess(f.db,staff,'hidden-conv'),null);
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal(await readControlAccess(f.db,staff,'conv'),null);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('note projection preserves exact body and author snapshots without reopening resolved work or advancing the control epoch',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const resolved=event(dir.scope,1,'resolve'),note=noteEvent(dir.scope,2);
    await projectControlEvents(f.db,dir.scope,[resolved,note],1_001);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,note.receipt.appliedState);
    const raw=await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE command_id='note-2'").first<string>('receipt');assert.ok(raw);
    const receipt=JSON.parse(raw);assert.equal(receipt.body,'  内部备注\r\n\t请继续跟进  ');assert.equal(receipt.authorName,'Staff');
    await f.db.prepare("UPDATE user SET name='Changed' WHERE id='staff-user'").run();
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await projectControlEvents(f.db,dir.scope,[note,resolved],1_002);
    assert.equal(await f.db.prepare("SELECT receipt FROM conversation_control_event WHERE command_id='note-2'").first('receipt'),raw);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),2);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,note.receipt.appliedState);
  }finally{await f.close();}
});

test('note projection keeps prior canonical receipt bytes and prevents late resolve from replacing a newer open note',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const resolved=event(dir.scope,1,'resolve'),reopened=event(dir.scope,2,'reopen'),note=noteEvent(dir.scope,3);
    note.receipt.appliedState={...normalizeControlState(reopened.receipt.appliedState),version:3,sequence:3,updatedAt:300};
    await projectControlEvents(f.db,dir.scope,[resolved,reopened],1_001);
    const before=(await f.db.prepare('SELECT receipt FROM conversation_control_event ORDER BY sequence').all()).results;
    await projectControlEvents(f.db,dir.scope,[note,resolved,reopened,note],1_002);
    assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence<3 ORDER BY sequence').all()).results,before);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,note.receipt.appliedState);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),3);
  }finally{await f.close();}
});

test('note projection rejects invalid body, metadata and legacy note states before any batch write',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const note=noteEvent(dir.scope,1);const {authorName,...withoutAuthor}=note.receipt as Extract<ControlEvent['receipt'],{action:'add_note'}>;
    const invalid=[withoutAuthor,{...note.receipt,authorName:1},{...note.receipt,authorName:null},{...note.receipt,body:'\u0001'},
      {...note.receipt,appliedState:event(dir.scope,1).receipt.appliedState},
      {...note.receipt,expectedVersion:1},{...event(dir.scope,1).receipt,authorName:'Injected'}];
    for(const receipt of invalid)await assert.rejects(projectControlEvents(f.db,dir.scope,[{scope:dir.scope,receipt:receipt as ControlEvent['receipt']}],1_001),/INVALID_CONTROL_EVENT/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.equal((await readControlDirectory(f.db,dir.scope))?.state.version,0);
  }finally{await f.close();}
});

test('note projection conflict rolls back preceding note audit and state updates atomically',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const first=noteEvent(dir.scope,1);await projectControlEvents(f.db,dir.scope,[first],1_001);
    const conflict={...first,receipt:{...first.receipt,authorName:'Changed snapshot'}} as ControlEvent;
    await assert.rejects(projectControlEvents(f.db,dir.scope,[noteEvent(dir.scope,2),conflict],1_002),/CONTROL_EVENT_CONFLICT/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),1);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,first.receipt.appliedState);
  }finally{await f.close();}
});

test('control storage fixture cleanup preserves the initialization error even when disposal rejects',{timeout:30_000},async t=>{
  const failure=Object.assign(new Error('synthetic initialization failure'),{code:'EADDRNOTAVAIL'});
  const originalDispose=Miniflare.prototype.dispose;let instance:Miniflare|undefined,closed=false;
  t.mock.method(Miniflare.prototype,'getD1Database',async function(this:Miniflare){instance=this;throw failure;});
  const disposal=t.mock.method(Miniflare.prototype,'dispose',async function(this:Miniflare){
    await originalDispose.call(this);closed=true;throw new Error('synthetic cleanup failure');
  });
  try{
    await assert.rejects(fixture,error=>error===failure);
    assert.equal(disposal.mock.calls.length,1);assert.equal(closed,true);
  }finally{if(instance&&!closed)await originalDispose.call(instance);}
});

test('assignee metadata uses the exact authoritative ID without needing a directory or modifying its projection',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.deepEqual(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'),{assignee:{memberId:'owner-member',name:'Owner',status:'eligible'}});
    assert.deepEqual(await readControlAssignee(f.db,staff,'conv',null,'staff-member'),{assignee:null});
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    await projectControlEvents(f.db,dir.scope,[event(dir.scope,1)],1_001);
    const before=await readControlDirectory(f.db,dir.scope),audit=(await f.db.prepare('SELECT * FROM conversation_control_event').all()).results;
    assert.equal(before?.state.assignedMemberId,'staff-member');
    assert.deepEqual(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'),{assignee:{memberId:'owner-member',name:'Owner',status:'eligible'}},'the DO assignee can be ahead of D1');
    await f.db.prepare("UPDATE user SET name='Owner renamed' WHERE id='owner-user'").run();
    assert.deepEqual(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'),{assignee:{memberId:'owner-member',name:'Owner renamed',status:'eligible'}});
    assert.deepEqual(await readControlDirectory(f.db,dir.scope),before);
    assert.deepEqual((await f.db.prepare('SELECT * FROM conversation_control_event').all()).results,audit);
  }finally{await f.close();}
});

test('assignee metadata preserves a current name across target grant, role and verification changes without requiring their session',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.prepare("DELETE FROM session WHERE id='staff-session'").run();
    const read=()=>readControlAssignee(f.db,owner,'conv','staff-member','owner-member');
    assert.deepEqual(await read(),{assignee:{memberId:'staff-member',name:'Staff',status:'eligible'}});
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.deepEqual(await read(),{assignee:{memberId:'staff-member',name:'Staff',status:'ineligible'}});
    await f.db.prepare("UPDATE member SET role='admin' WHERE id='staff-member'").run();
    assert.deepEqual(await read(),{assignee:{memberId:'staff-member',name:'Staff',status:'eligible'}});
    await f.db.prepare("UPDATE user SET email_verified=0,name='Staff renamed' WHERE id='staff-user'").run();
    assert.deepEqual(await read(),{assignee:{memberId:'staff-member',name:'Staff renamed',status:'ineligible'}});
    await f.db.prepare("UPDATE user SET email_verified=1 WHERE id='staff-user'").run();
    assert.deepEqual(await read(),{assignee:{memberId:'staff-member',name:'Staff renamed',status:'eligible'}});
  }finally{await f.close();}
});

test('assignee metadata never substitutes a removed member with a rejoined user or leaks a foreign member name',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    await f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('staff-rejoined','org','staff-user','admin',2),('foreign-member','other','owner-user','owner',2)").run();
    for(const id of ['staff-member','foreign-member','missing'])assert.deepEqual(await readControlAssignee(f.db,owner,'conv',id,'owner-member'),{assignee:{memberId:id,name:null,status:'removed'}});
    assert.deepEqual(await readControlAssignee(f.db,owner,'conv','staff-rejoined','owner-member'),{assignee:{memberId:'staff-rejoined',name:'Staff',status:'eligible'}});
    assert.equal(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'),null,'old DO viewer identity cannot be replaced by a new membership');
    assert.deepEqual(await readControlAssignee(f.db,staff,'conv','owner-member','staff-rejoined'),{assignee:{memberId:'owner-member',name:'Owner',status:'eligible'}});
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
  }finally{await f.close();}
});

test('assignee metadata finally authorizes tenant, store, exact viewer membership and session even for an unassigned conversation',{timeout:30_000},async()=>{
  const f=await fixture();try{
    for(const assigned of [null,'owner-member']){
      assert.equal(await readControlAssignee(f.db,staff,'hidden-conv',assigned,'staff-member'),null);
      assert.equal(await readControlAssignee(f.db,owner,'foreign-conv',assigned,'owner-member'),null);
      assert.equal(await readControlAssignee(f.db,{...staff,orgId:'other'},'conv',assigned,'staff-member'),null);
      assert.equal(await readControlAssignee(f.db,staff,'conv',assigned,'owner-member'),null);
      assert.equal(await readControlAssignee(f.db,{...staff,sessionId:'owner-session'},'conv',assigned,'staff-member'),null);
    }
    assert.ok(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'));
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal(await readControlAssignee(f.db,staff,'conv','owner-member','staff-member'),null);
    assert.equal(await readControlAssignee(f.db,staff,'conv',null,'staff-member'),null);
    await f.db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',2)").run();
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff-user'").run();
    assert.equal(await readControlAssignee(f.db,staff,'conv',null,'staff-member'),null);
    await f.db.prepare("UPDATE user SET email_verified=1 WHERE id='staff-user'").run();
    await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='staff-session'").run();
    assert.equal(await readControlAssignee(f.db,staff,'conv',null,'staff-member'),null);
  }finally{await f.close();}
});

test('assignee metadata rejects malformed scoped and authority identifiers',{timeout:30_000},async()=>{
  const f=await fixture();try{
    for(const invalid of ['', 'a'.repeat(257), undefined, 1]){
      await assert.rejects(readControlAssignee(f.db,owner,'conv',invalid as string,'owner-member'),RangeError);
      await assert.rejects(readControlAssignee(f.db,owner,'conv',null,invalid as string),RangeError);
      await assert.rejects(readControlAssignee(f.db,owner,invalid as string,null,'owner-member'),RangeError);
    }
    for(const key of ['orgId','actorUserId','sessionId'])await assert.rejects(readControlAssignee(f.db,{...owner,[key]:''},'conv',null,'owner-member'),RangeError);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('transfer authorization checks actor and verified target membership in one query, without requiring a target session',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.batch([
      f.db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('admin-user','Admin','admin@example.invalid',1),('pending-user','Pending','pending@example.invalid',0)"),
      f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('admin-member','org','admin-user','admin',2),('pending-member','org','pending-user','admin',2),('foreign-member','other','owner-user','owner',2)"),
      f.db.prepare("DELETE FROM session WHERE id='owner-session'"),
    ]);
    for(const id of ['owner-member','admin-member','staff-member'])assert.equal((await readControlAccess(f.db,staff,'conv',id))?.targetEligible,true,id);
    for(const id of ['pending-member','foreign-member','owner-user','missing'])assert.equal((await readControlAccess(f.db,staff,'conv',id))?.targetEligible,false,id);
    assert.equal((await readControlAccess(f.db,staff,'conv'))?.targetEligible,false);
    assert.equal(await readControlAccess(f.db,staff,'hidden-conv','admin-member'),null);
    assert.equal(await readControlAccess(f.db,staff,'foreign-conv','foreign-member'),null);
    await f.db.prepare("UPDATE member SET role='member' WHERE id='admin-member'").run();
    assert.equal((await readControlAccess(f.db,staff,'conv','admin-member'))?.targetEligible,false);
    await f.db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','admin-member',2)").run();
    assert.equal((await readControlAccess(f.db,staff,'conv','admin-member'))?.targetEligible,true);
    await f.db.prepare("DELETE FROM member WHERE id='admin-member'").run();
    assert.equal((await readControlAccess(f.db,staff,'conv','admin-member'))?.targetEligible,false);
    await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='staff-session'").run();
    assert.equal(await readControlAccess(f.db,staff,'conv','owner-member'),null);
    await assert.rejects(readControlAccess(f.db,staff,'conv',''),RangeError);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('transfer target pages distinguish denied and empty access, filter grants and verification, and preserve member identity',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const page=await listControlTransferTargets(f.db,staff,'conv',0);assert.ok(page);
    assert.deepEqual(page,{targets:[{memberId:'owner-member',name:'Owner',email:'owner@example.invalid',role:'owner'},{memberId:'staff-member',name:'Staff',email:'staff@example.invalid',role:'member'}],nextOffset:null});
    assert.deepEqual(await listControlTransferTargets(f.db,staff,'conv',100),{targets:[],nextOffset:null});
    assert.equal(await listControlTransferTargets(f.db,staff,'hidden-conv',0),null);
    assert.equal(await listControlTransferTargets(f.db,owner,'foreign-conv',0),null);
    assert.deepEqual((await listControlTransferTargets(f.db,owner,'hidden-conv',0))?.targets.map(item=>item.memberId),['owner-member']);
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff-user'").run();
    assert.deepEqual((await listControlTransferTargets(f.db,owner,'conv',0))?.targets.map(item=>item.memberId),['owner-member']);
    assert.equal(await listControlTransferTargets(f.db,staff,'conv',0),null);
    for(const offset of [-1,0.5,10_001,NaN])await assert.rejects(listControlTransferTargets(f.db,owner,'conv',offset),RangeError);
    await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='owner-session'").run();
    assert.equal(await listControlTransferTargets(f.db,owner,'conv',0),null);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('transfer target paging returns at most 100 deterministic entries and refreshes authorization on every page',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.batch(Array.from({length:101},(_,i)=>[
      f.db.prepare('INSERT INTO user(id,name,email,email_verified) VALUES (?,?,?,1)').bind(`target-user-${i}`,'Same name',`target-${i}@example.invalid`),
      f.db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES (?,'org',?,'admin',?)").bind(`target-member-${i}`,`target-user-${i}`,i+2),
    ]).flat());
    const first=await listControlTransferTargets(f.db,staff,'conv',0);assert.ok(first);assert.equal(first.targets.length,100);assert.equal(first.nextOffset,100);
    const second=await listControlTransferTargets(f.db,staff,'conv',first.nextOffset!);assert.ok(second);assert.equal(second.targets.length,3);assert.equal(second.nextOffset,null);
    assert.equal(new Set([...first.targets,...second.targets].map(item=>item.memberId)).size,103);
    assert.deepEqual(await listControlTransferTargets(f.db,staff,'conv',10_000),{targets:[],nextOffset:null});
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal(await listControlTransferTargets(f.db,staff,'conv',100),null);
  }finally{await f.close();}
});

test('transfer projections retain accepted target and reason after member removal, deduplicate and ignore older owners',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);const legacy=event(dir.scope,1),transfer=transferEvent(dir.scope,3);
    await projectControlEvents(f.db,dir.scope,[legacy],2_000);
    const oldRaw=await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=1').first('receipt');
    await f.db.prepare("UPDATE member SET role='owner' WHERE id='staff-member'").run();
    await f.db.prepare("DELETE FROM member WHERE id='owner-member'").run();
    await projectControlEvents(f.db,dir.scope,[transfer],2_001);
    const transferRaw=await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=3').first<string>('receipt');assert.ok(transferRaw);
    assert.deepEqual(JSON.parse(transferRaw),transfer.receipt);
    await projectControlEvents(f.db,dir.scope,[event(dir.scope,2,'resolve'),transfer,legacy],2_002);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,transfer.receipt.appliedState);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),3);
    assert.equal(await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=1').first('receipt'),oldRaw);
    assert.equal(await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=3').first('receipt'),transferRaw);
    const changed={...transfer,receipt:{...transfer.receipt,reason:'不同原因'}} as ControlEvent;
    await assert.rejects(projectControlEvents(f.db,dir.scope,[changed],2_003),/CONTROL_EVENT_CONFLICT/);
  }finally{await f.close();}
});

test('transfer receipt validation rejects legacy, closed, paused, mismatched assignee and malformed command payloads',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,owner,'conv',1_000);assert.ok(dir);const valid=transferEvent(dir.scope,1);
    const invalid=[
      {...valid.receipt,appliedState:event(dir.scope,1).receipt.appliedState},
      {...valid.receipt,appliedState:{...valid.receipt.appliedState,lifecycle:'resolved',workStatus:null}},
      {...valid.receipt,appliedState:{...valid.receipt.appliedState,reception:'paused'}},
      {...valid.receipt,appliedState:{...valid.receipt.appliedState,assignedMemberId:'staff-member'}},
      {...valid.receipt,reason:'   '},{...valid.receipt,reason:'a'.repeat(501)},
      {...valid.receipt,targetMemberId:''},{...valid.receipt,unexpected:true},
    ];
    for(const receipt of invalid)await assert.rejects(projectControlEvents(f.db,dir.scope,[{scope:dir.scope,receipt} as ControlEvent],2_000),/INVALID_CONTROL_EVENT/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,dir.state);
    await f.db.prepare("CREATE TRIGGER synthetic_transfer_failure BEFORE UPDATE ON conversation_control WHEN NEW.assigned_member_id='owner-member' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_TRANSFER_FAILURE'); END").run();
    await assert.rejects(projectControlEvents(f.db,dir.scope,[event(dir.scope,1),transferEvent(dir.scope,2)],2_001),/SYNTHETIC_TRANSFER_FAILURE/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,dir.state);
  }finally{await f.close();}
});

test('work-state projections preserve historical receipt bytes and late v1 events cannot overwrite v2 work status',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const legacy=event(dir.scope,1),raw=JSON.stringify(legacy.receipt),waiting=workEvent(dir.scope,4);
    await f.db.prepare("INSERT INTO conversation_control_event(controller_id,organization_id,store_id,conversation_id,sequence,command_id,actor_user_id,actor_member_id,action,receipt,projected_at) VALUES (?,'org','store','conv',1,'command-1','staff-user','staff-member','claim',?,100)").bind(dir.scope.controllerId,raw).run();
    await projectControlEvents(f.db,dir.scope,[waiting],2_000);
    await projectControlEvents(f.db,dir.scope,[legacy,event(dir.scope,2,'resolve'),event(dir.scope,3,'reopen'),waiting],2_001);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,waiting.receipt.appliedState);
    assert.equal(await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence=1').first('receipt'),raw);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),4);
    assert.equal(await f.db.prepare('SELECT schema_version FROM conversation_control').first('schema_version'),2);
  }finally{await f.close();}
});

test('set_work_status receipts reject legacy, resolved, mismatched or extra payloads before any projection',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,owner,'conv',1_000);assert.ok(dir);const valid=workEvent(dir.scope,1);
    const invalid=[
      {...valid,receipt:{...valid.receipt,appliedState:event(dir.scope,1).receipt.appliedState}},
      {...valid,receipt:{...valid.receipt,appliedState:{...valid.receipt.appliedState,lifecycle:'resolved',workStatus:null}}},
      {...valid,receipt:{...valid.receipt,appliedState:{...valid.receipt.appliedState,workStatus:'waiting_internal'}}},
      {...event(dir.scope,1),receipt:{...event(dir.scope,1).receipt,workStatus:'waiting_customer'}},
    ];
    for(const value of invalid)await assert.rejects(projectControlEvents(f.db,dir.scope,[value as ControlEvent],2_000),/INVALID_CONTROL_EVENT/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,dir.state);
    await projectControlEvents(f.db,dir.scope,[valid],2_001);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,valid.receipt.appliedState);
  }finally{await f.close();}
});

test('a failed work-status projection rolls back its audit and legacy-to-v2 conversion together',{timeout:30_000},async()=>{
  const f=await fixture();try{
    await f.db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,repair_due_at) VALUES ('conv','org','store','legacy-controller',1)").run();
    const scope={organizationId:'org',storeId:'store',conversationId:'conv',controllerId:'legacy-controller'};
    const initial=await readControlDirectory(f.db,scope);assert.equal(initial?.state.schemaVersion,1);
    await f.db.prepare("CREATE TRIGGER synthetic_work_failure BEFORE UPDATE ON conversation_control WHEN NEW.work_status='waiting_customer' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_WORK_FAILURE'); END").run();
    await assert.rejects(projectControlEvents(f.db,scope,[event(scope,1),workEvent(scope,2)],2_000),/SYNTHETIC_WORK_FAILURE/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);
    assert.deepEqual(await readControlDirectory(f.db,scope),initial);
  }finally{await f.close();}
});

test('control access reads the current store grant and member ID, with no directory mutation on GET',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.deepEqual(await readControlAccess(f.db,staff,'conv'),{organizationId:'org',storeId:'store',conversationId:'conv',memberId:'staff-member',memberName:'Staff',targetEligible:false,directory:null});
    assert.equal(await readControlAccess(f.db,staff,'hidden-conv'),null);assert.equal(await readControlAccess(f.db,owner,'foreign-conv'),null);
    assert.equal(await readControlAccess(f.db,{...staff,sessionId:'owner-session'},'conv'),null);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
    const created=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(created);
    assert.equal((await readControlAccess(f.db,staff,'conv'))?.directory?.scope.controllerId,created.scope.controllerId);
    assert.deepEqual(created.state,{schemaVersion:2,version:0,controlEpoch:0,sequence:0,lifecycle:'open',reception:'paused',assignedMemberId:null,updatedAt:0,workStatus:'needs_reply'});
    await f.db.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();
    assert.equal(await readControlAccess(f.db,staff,'conv'),null);assert.equal(await ensureControlDirectory(f.db,staff,'conv',2_000),null);
    assert.equal((await readControlDirectory(f.db,created.scope))?.repairDueAt,1_000,'denied calls cannot change the repair schedule');
  }finally{await f.close();}
});

test('a reopened projection stays open when an older resolve arrives and replay never duplicates its audit',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);
    const claim=event(dir.scope,1),resolved=event(dir.scope,2,'resolve'),reopened=event(dir.scope,3,'reopen');
    await projectControlEvents(f.db,dir.scope,[claim,reopened],2_000);
    const before=(await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence IN (1,3) ORDER BY sequence').all()).results;
    await projectControlEvents(f.db,dir.scope,[resolved,reopened,claim,resolved],2_001);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,normalizeControlState(reopened.receipt.appliedState));
    assert.deepEqual((await f.db.prepare('SELECT receipt FROM conversation_control_event WHERE sequence IN (1,3) ORDER BY sequence').all()).results,before);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),3);
    assert.equal(await f.db.prepare('SELECT action FROM conversation_control_event WHERE sequence=3').first('action'),'reopen');
  }finally{await f.close();}
});

test('directory writes recheck verification, membership and session expiration without trusting a preflight',{timeout:30_000},async()=>{
  const f=await fixture();try{
    assert.ok(await readControlAccess(f.db,staff,'conv'));
    await f.db.prepare("UPDATE user SET email_verified=0 WHERE id='staff-user'").run();
    assert.equal(await ensureControlDirectory(f.db,staff,'conv',1),null);
    await f.db.prepare("UPDATE user SET email_verified=1 WHERE id='staff-user'").run();
    await f.db.prepare("UPDATE session SET expires_at=1 WHERE id='staff-session'").run();
    assert.equal(await ensureControlDirectory(f.db,staff,'conv',1),null);
    await f.db.prepare("UPDATE session SET expires_at=? WHERE id='staff-session'").bind(Date.now()+60_000).run();
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    assert.equal(await ensureControlDirectory(f.db,staff,'conv',1),null);
    assert.equal(await ensureControlDirectory(f.db,owner,'foreign-conv',1),null);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control').first('n'),0);
  }finally{await f.close();}
});

test('racing first commands select one immutable directory and repair rotation cannot starve the next object',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const results=await Promise.all(Array.from({length:8},()=>ensureControlDirectory(f.db,owner,'conv',1_000)));
    assert.ok(results.every(Boolean));assert.equal(new Set(results.map(result=>result!.scope.controllerId)).size,1);
    const a=results[0]!;const b=await ensureControlDirectory(f.db,owner,'conv-2',1_001);assert.ok(b);
    assert.deepEqual(await listDueControlDirectories(f.db,1_001,1),[a.scope]);
    await deferControlRepair(f.db,a.scope,2_000);
    assert.deepEqual(await listDueControlDirectories(f.db,1_001,1),[b.scope]);
    await deferControlRepair(f.db,{...b.scope,controllerId:a.scope.controllerId},9_000);
    assert.equal((await readControlDirectory(f.db,b.scope))?.repairDueAt,1_001);
    assert.equal(await readControlDirectory(f.db,{...a.scope,storeId:'hidden'}),null);
    assert.equal(await readControlDirectory(f.db,{...a.scope,organizationId:'other'}),null);
    assert.equal(await readControlDirectory(f.db,{...a.scope,conversationId:'conv-2'}),null);
    const again=await ensureControlDirectory(f.db,staff,'conv',1_500);assert.equal(again?.scope.controllerId,a.scope.controllerId);assert.equal(again?.state.updatedAt,0);assert.equal(again?.repairDueAt,1_500);
    await assert.rejects(listDueControlDirectories(f.db,1_000,0),RangeError);await assert.rejects(listDueControlDirectories(f.db,1_000,101),RangeError);
  }finally{await f.close();}
});

test('out-of-order projections retain every immutable audit receipt and never downgrade accepted state',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,staff,'conv',1_000);assert.ok(dir);const scope=dir.scope;
    const first=event(scope,1),second=event(scope,2,'resolve');
    await projectControlEvents(f.db,scope,[second],2_000);
    await projectControlEvents(f.db,scope,[first,second,first],2_001);
    assert.deepEqual((await readControlDirectory(f.db,scope))?.state,normalizeControlState(second.receipt.appliedState));
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),2);
    await f.db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    assert.equal((await readControlDirectory(f.db,scope))?.state.assignedMemberId,'staff-member');
    await projectControlEvents(f.db,scope,[second],2_002);
    assert.equal(await f.db.prepare("SELECT actor_member_id FROM conversation_control_event WHERE sequence=1").first('actor_member_id'),'staff-member');
    await assert.rejects(f.db.prepare("UPDATE conversation_control_event SET action='takeover'").run(),/CONTROL_EVENT_IMMUTABLE/);
  }finally{await f.close();}
});

test('a failed audit or projection statement rolls back the entire D1 batch',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,owner,'conv',1_000);assert.ok(dir);
    await f.db.prepare("CREATE TRIGGER synthetic_control_projection_failure BEFORE UPDATE ON conversation_control WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_PROJECTION_FAILURE'); END").run();
    await assert.rejects(projectControlEvents(f.db,dir.scope,[event(dir.scope,1),event(dir.scope,2,'resolve')],2_000),/SYNTHETIC_PROJECTION_FAILURE/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,dir.state);
    await f.db.prepare('DROP TRIGGER synthetic_control_projection_failure').run();
    await f.db.prepare("CREATE TRIGGER synthetic_control_audit_failure BEFORE INSERT ON conversation_control_event WHEN NEW.sequence=2 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAILURE'); END").run();
    await assert.rejects(projectControlEvents(f.db,dir.scope,[event(dir.scope,1),event(dir.scope,2)],2_001),/SYNTHETIC_AUDIT_FAILURE/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),0);assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,dir.state);
  }finally{await f.close();}
});

test('scope changes and mismatched command or sequence receipts are rejected instead of silently deduplicated',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,owner,'conv',1_000);assert.ok(dir);const accepted=event(dir.scope,1);
    for(const wrong of [{...dir.scope,organizationId:'other'},{...dir.scope,storeId:'hidden'},{...dir.scope,conversationId:'conv-2'},{...dir.scope,controllerId:crypto.randomUUID()}]){
      await assert.rejects(projectControlEvents(f.db,dir.scope,[event(wrong,1)],2_000),/CONTROL_SCOPE/);
      await assert.rejects(projectControlEvents(f.db,wrong,[event(wrong,1)],2_000));
    }
    await projectControlEvents(f.db,dir.scope,[accepted],2_001);
    await assert.rejects(projectControlEvents(f.db,{...dir.scope,organizationId:'other'},[{...accepted,scope:{...dir.scope,organizationId:'other'}}],2_002),/CONTROL_SCOPE/);
    await assert.rejects(projectControlEvents(f.db,dir.scope,[{...accepted,receipt:{...accepted.receipt,actorUserId:'different-user'}}],2_002),/CONTROL_EVENT_CONFLICT/);
    await assert.rejects(projectControlEvents(f.db,dir.scope,[{...event(dir.scope,2),receipt:{...event(dir.scope,2).receipt,commandId:accepted.receipt.commandId}}],2_002),/CONTROL_EVENT_CONFLICT/);
    assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),1);
    assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,normalizeControlState(accepted.receipt.appliedState));
  }finally{await f.close();}
});

test('a newer projection cannot reduce control version or epoch, and directory identity never changes',{timeout:30_000},async()=>{
  const f=await fixture();try{
    const dir=await ensureControlDirectory(f.db,owner,'conv',1_000);assert.ok(dir);
    const current=event(dir.scope,2);await projectControlEvents(f.db,dir.scope,[current],2_000);
    for(const field of ['version','controlEpoch'] as const){
      const next=event(dir.scope,3);next.receipt.appliedState[field]=1;
      await assert.rejects(projectControlEvents(f.db,dir.scope,[next],2_001),/CONTROL_STATE_REGRESSION/);
      assert.deepEqual((await readControlDirectory(f.db,dir.scope))?.state,normalizeControlState(current.receipt.appliedState));
      assert.equal(await f.db.prepare('SELECT COUNT(*) AS n FROM conversation_control_event').first('n'),1);
    }
    await assert.rejects(f.db.prepare("UPDATE conversation_control SET controller_id='changed'").run(),/CONTROL_SCOPE_IMMUTABLE/);
    await assert.rejects(f.db.prepare("UPDATE conversation_control SET conversation_id='conv-2'").run(),/CONTROL_SCOPE_IMMUTABLE/);
  }finally{await f.close();}
});
