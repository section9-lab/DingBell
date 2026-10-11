import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { InvalidConversationCursor, listConversations } from '../src/modules/conversations/read.ts';
import type { ConversationListOptions, ConversationListResult, ConversationStateFilter } from '../src/modules/conversations/read-types.ts';
import type { StoreActor } from '../src/modules/stores/storage.ts';

const staff:StoreActor={orgId:'org',actorUserId:'staff-user',sessionId:'staff-session'};
const owner:StoreActor={orgId:'org',actorUserId:'owner-user',sessionId:'owner-session'};
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const decode=(value:string)=>JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
const ids=(page:ConversationListResult)=>page.items.map(item=>item.id);

test('workflow queues, counters and identity share a freshly authorized D1 snapshot',{timeout:90_000},async t=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("queue fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database,folder=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('foreign','Foreign','foreign',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner-user','Owner','owner@example.invalid',1),('staff-user','Staff','staff@example.invalid',1),('target-user','Target','target@example.invalid',1),('foreign-user','Private name','foreign@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner-user','owner',1),('staff-member','org','staff-user','member',1),('target-member','org','target-user','member',1),('foreign-member','foreign','foreign-user','owner',1)"),
    ...[staff,owner].map(actor=>db.prepare('INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(actor.sessionId,actor.sessionId,actor.actorUserId,Date.now()+3_600_000)),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','paused',1,1),('hidden','org','Hidden','2','verified',1,1),('foreign-store','foreign','Foreign','3','verified',1,1)"),
    db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-member',1)"),
  ]);
  const entries=[
    ['empty',null,null,null],['legacy-open',1,null,'staff-member'],['needs',2,'needs_reply','target-member'],
    ['customer',2,'waiting_customer','staff-member'],['internal',2,'waiting_internal',null],
    ['resolved',2,'resolved','staff-member'],['legacy-resolved',1,'resolved','target-member'],
    ['removed',2,'needs_reply','removed-member'],['foreign-assignee',2,'needs_reply','foreign-member'],
    ['hidden-conv',2,'needs_reply','staff-member'],['foreign-conv',2,'needs_reply','foreign-member'],
  ] as const;
  for(const [index,[id,schema,status,assigned]]of entries.entries()){
    const org=id==='foreign-conv'?'foreign':'org',store=id==='foreign-conv'?'foreign-store':id==='hidden-conv'?'hidden':'store';
    await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at,last_message_at) VALUES (?,?,?,?,'BUYER_SELLER','Opened',1,1,?)").bind(id,org,store,`thread-${id}`,100-index).run();
    if(schema!==null)await db.prepare("INSERT INTO conversation_control(conversation_id,organization_id,store_id,controller_id,schema_version,version,control_epoch,sequence,lifecycle,reception,assigned_member_id,updated_at,work_status,repair_due_at) VALUES (?,?,?,?,?,3,3,3,?,'human',?,1,?,1)")
      .bind(id,org,store,`controller-${id}`,schema,status==='resolved'?'resolved':'open',assigned,schema===1||status==='resolved'?null:status).run();
    if(['empty','customer','hidden-conv','foreign-conv'].includes(id))await db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,order_number,event_at,received_at,ingest_mode) VALUES (?,?,?,?,?,'Customer','inbound','[\"正文\"]',0,0,'order-shared',1,1,'backfill')")
      .bind(`message-${id}`,org,store,id,id).run();
  }
  async function read(options:Partial<ConversationListOptions>={},actor=staff){const result=await listConversations(db,actor,{limit:100,...options}) as ConversationListResult|null;assert.ok(result);return result;}

  await t.test('defaults normalize missing and v1 projections without creating directories or exposing foreign names',async()=>{
    const before=(await db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results;
    const page=await read();assert.equal(page.viewerMemberId,'staff-member');assert.deepEqual(page.counts,{all:9,mine:3,unassigned:2});
    assert.deepEqual(ids(page),entries.slice(0,9).map(row=>row[0]));
    const workflow=(id:string)=>page.items.find(item=>item.id===id)!.workflow;
    assert.deepEqual(workflow('empty'),{version:0,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:null,assigneeName:null});
    assert.deepEqual(workflow('legacy-open'),{version:3,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:'staff-member',assigneeName:'Staff'});
    assert.equal(workflow('legacy-resolved').workStatus,null);assert.equal(workflow('legacy-resolved').lifecycle,'resolved');
    for(const id of ['removed','foreign-assignee'])assert.equal(workflow(id).assigneeName,null);
    assert.equal(workflow('needs').assigneeName,'Target','a removed grant is not a removed membership');
    assert.deepEqual((await db.prepare('SELECT * FROM conversation_control ORDER BY conversation_id').all()).results,before);
  });
  await t.test('all queue and workflow combinations filter items while counts ignore the selected queue',async()=>{
    const groups:Record<ConversationStateFilter,string[]>={all:entries.slice(0,9).map(row=>row[0]),needs_reply:['empty','legacy-open','needs','removed','foreign-assignee'],waiting_customer:['customer'],waiting_internal:['internal'],resolved:['resolved','legacy-resolved']};
    const mine=['legacy-open','customer','resolved'],unassigned=['empty','internal'];
    for(const [state,expected]of Object.entries(groups))for(const queue of ['all','mine','unassigned'] as const){
      const page=await read({queue,state:state as ConversationStateFilter});
      assert.deepEqual(ids(page),queue==='all'?expected:expected.filter(id=>(queue==='mine'?mine:unassigned).includes(id)),`${queue}/${state}`);
      assert.deepEqual(page.counts,{all:expected.length,mine:expected.filter(id=>mine.includes(id)).length,unassigned:expected.filter(id=>unassigned.includes(id)).length});
    }
  });
  await t.test('counts respect store and exact searches but survive page boundaries and an empty later page',async()=>{
    const first=await read({limit:2});assert.ok(first.nextCursor);
    const second=await read({limit:2,cursor:first.nextCursor});assert.deepEqual(second.counts,first.counts);assert.notDeepEqual(ids(second),ids(first));
    const empty=await read({cursor:encode({...decode(first.nextCursor),at:0,id:'!'})});assert.deepEqual(empty.items,[]);assert.deepEqual(empty.counts,first.counts);
    assert.deepEqual((await read({search:{field:'order',value:'order-shared'}})).counts,{all:2,mine:1,unassigned:1});
    assert.deepEqual((await read({search:{field:'thread',value:'thread-needs'}})).counts,{all:1,mine:0,unassigned:0});
    const none=await read({search:{field:'thread',value:'not-present'}});assert.deepEqual(none.counts,{all:0,mine:0,unassigned:0});assert.equal(none.viewerMemberId,'staff-member');
    assert.deepEqual((await read({storeId:'hidden'},owner)).counts,{all:1,mine:0,unassigned:0});
    assert.deepEqual((await read({storeId:'hidden'})).counts,{all:0,mine:0,unassigned:0});
  });
  await t.test('v2 cursors bind queue, state, viewer, store and search while v1 cursors fail explicitly',async()=>{
    const page=await read({limit:1});assert.ok(page.nextCursor);const cursor=decode(page.nextCursor);
    assert.equal(cursor.v,2);assert.equal(cursor.viewerMemberId,'staff-member');assert.equal(cursor.queue,'all');assert.equal(cursor.state,'all');
    for(const options of [{queue:'mine'},{state:'needs_reply'},{storeId:'store'},{search:{field:'thread',value:'thread-empty'}}])await assert.rejects(listConversations(db,staff,{limit:1,cursor:page.nextCursor,...options} as ConversationListOptions),InvalidConversationCursor);
    for(const changes of [{v:1},{viewerMemberId:'owner-member'},{queue:'unknown'},{state:'open'},{orgId:'foreign'}])await assert.rejects(listConversations(db,staff,{limit:1,cursor:encode({...cursor,...changes})}),InvalidConversationCursor);
    await assert.rejects(listConversations(db,owner,{limit:1,cursor:page.nextCursor}),InvalidConversationCursor);
    const bad={prepare(){throw new Error('query should not run');}} as unknown as D1Database;
    for(const option of [{queue:''},{queue:null},{queue:'other'},{state:'open'},{state:null}])await assert.rejects(listConversations(bad,staff,{limit:1,...option} as ConversationListOptions),RangeError);
  });
  await t.test('each list is one SELECT, page-only message and author expansion retains useful scoped query plans',async()=>{
    const calls:{sql:string;values:unknown[]}[]=[];
    const observed={prepare(sql:string){return {bind(...values:unknown[]){calls.push({sql,values});return db.prepare(sql).bind(...values);}};}} as unknown as D1Database;
    for(const options of [{limit:2},{limit:2,queue:'mine'},{limit:2,search:{field:'thread',value:'thread-empty'}},{limit:2,search:{field:'order',value:'order-shared'}}] as ConversationListOptions[])await listConversations(observed,staff,options);
    assert.equal(calls.length,4);assert.ok(calls.every(({sql})=>/^\s*(WITH|SELECT)\b/i.test(sql)&&sql.includes('store_grant')&&sql.includes('session')));
    const plans=[];for(const call of calls)plans.push((await db.prepare('EXPLAIN QUERY PLAN '+call.sql).bind(...call.values).all()).results);
    const folder='test-results/stage4b6-2026-10-09';mkdirSync(folder,{recursive:true});writeFileSync(`${folder}/queues-query-plans.json`,JSON.stringify({queries:calls.map(call=>call.sql),plans},null,2));
    assert.ok(plans[0].some(row=>String(row.detail).includes('conversation_org_time_idx')));
    assert.ok(plans[2].some(row=>String(row.detail).includes('platform_thread_id=?')));
    assert.ok(plans[3].some(row=>String(row.detail).includes('order_number=?')));
  });
  await t.test('names change independently of projection version and rejoining never replaces a historic assignee identity',async()=>{
    await db.prepare("UPDATE user SET name='Renamed' WHERE id='target-user'").run();
    assert.equal((await read()).items.find(item=>item.id==='needs')!.workflow.assigneeName,'Renamed');
    await db.prepare("DELETE FROM member WHERE id='target-member'").run();
    await db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('target-rejoined','org','target-user','admin',2)").run();
    const item=(await read()).items.find(item=>item.id==='needs')!;assert.equal(item.workflow.assignedMemberId,'target-member');assert.equal(item.workflow.assigneeName,null);assert.equal(item.workflow.version,3);
    const page=await read({limit:1});assert.ok(page.nextCursor);
    await db.prepare("DELETE FROM member WHERE id='staff-member'").run();
    assert.equal(await listConversations(db,staff,{limit:1}),null);
    await db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('staff-rejoined','org','staff-user','admin',2)").run();
    const rejoined=await read({queue:'mine'});assert.equal(rejoined.viewerMemberId,'staff-rejoined');assert.deepEqual(rejoined.items,[]);assert.equal(rejoined.counts.mine,0);
    await assert.rejects(listConversations(db,staff,{limit:1,cursor:page.nextCursor}),InvalidConversationCursor);
  });
  await t.test('fresh grants, verified identity and session restrict both counters and rows, including empty pages',async()=>{
    await db.prepare("UPDATE member SET role='member' WHERE id='staff-rejoined'").run();
    assert.deepEqual((await read()).counts,{all:0,mine:0,unassigned:0});
    await db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('org','store','staff-rejoined',3)").run();
    assert.equal((await read()).counts.all,9);
    assert.equal(await listConversations(db,{...staff,orgId:'foreign'},{limit:1}),null);
    assert.equal(await listConversations(db,{...staff,sessionId:'owner-session'},{limit:1}),null);
    await db.prepare("UPDATE user SET email_verified=0 WHERE id='staff-user'").run();assert.equal(await listConversations(db,staff,{limit:1}),null);
    await db.prepare("UPDATE user SET email_verified=1 WHERE id='staff-user'").run();
    await db.prepare("UPDATE session SET expires_at=1 WHERE id='staff-session'").run();assert.equal(await listConversations(db,staff,{limit:1}),null);
  });
});
