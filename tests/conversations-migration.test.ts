import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { listConversations } from '../src/modules/conversations/read.ts';
import { storeAccess } from '../src/modules/stores/storage.ts';

const migrations=new URL('../migrations/',import.meta.url);
async function apply(db:D1Database,name:string){for(const sql of readFileSync(new URL(name,migrations),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();}

test('conversation read indexes upgrade populated D1 without changing imported facts or authority', {timeout:30_000},async context=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const files=readdirSync(migrations).filter(name=>name.endsWith('.sql')).sort();
  for(const name of files.filter(name=>name<'0009'))await apply(db,name);
  const until=Date.now()+60_000;
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('owner','Owner','owner@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('owner-member','org','owner','owner',1)"),
    db.prepare("INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES ('session','session','owner',?,1,1)").bind(until),
    db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store','org','Store','1','verified',1,1)"),
    db.prepare("INSERT INTO store_coordinator(store_id,organization_id,fence,lease_source,lease_token,lease_until,blocked_until) VALUES ('store','org',9,'chat','unchanged-lease',?,?)").bind(until,until),
    db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES ('store','org','chat',1,7,1,100,100)"),
    db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_at,imported_at) VALUES ('conv','org','store','18446744073709551615','BUYER_SELLER','Opened',1,3,4)"),
    db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,order_number,event_at,received_at,ingest_mode) VALUES ('msg','org','store','conv','18446744073709551615','Customer','inbound','[\"Здравствуйте\"]',0,0,'order-1',3,4,'backfill')"),
    db.prepare("INSERT INTO ingest_event(id,organization_id,store_id,conversation_id,message_id,state,trace_id,created_at) VALUES ('event','org','store','conv','msg','historical','trace',4)"),
    db.prepare("INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at) VALUES ('org','store','18446744073709551615','backfill','conv','18446744073709551615',2,100)"),
  ]);
  const preserved=['conversation','message','ingest_event','store_coordinator','store_sync_source','sync_cursor'];
  const before=await Promise.all(preserved.map(table=>db.prepare(`SELECT * FROM ${table}`).all()));
  const actor={orgId:'org',actorUserId:'owner',sessionId:'session'};
  async function plan(search?:{field:'thread'|'order';value:string}){
    // Preserve the 4A query: the 0008/0009 schema predates the workflow projection.
    const conditions=['conversation.organization_id=?',storeAccess('store.organization_id',false)],values:unknown[]=[actor.orgId,actor.actorUserId,actor.sessionId];
    if(search?.field==='thread'){conditions.push('conversation.platform_thread_id=?');values.push(search.value);}
    if(search?.field==='order'){conditions.push('conversation.id IN (SELECT matched.conversation_id FROM message AS matched WHERE matched.organization_id=? AND matched.order_number=?)');values.push(actor.orgId,search.value);}
    const sql=`SELECT conversation.id FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
      WHERE ${conditions.join(' AND ')} ORDER BY conversation.last_message_at DESC,conversation.id DESC LIMIT 51`;
    assert.equal((await db.prepare(sql).bind(...values).all<{id:string}>()).results[0]?.id,'conv');
    return (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all<{detail:string}>()).results.map(row=>row.detail);
  }
  const oldPlans={all:await plan(),thread:await plan({field:'thread',value:'18446744073709551615'}),order:await plan({field:'order',value:'order-1'})};
  for(const name of files.filter(name=>name.startsWith('0009_')))await apply(db,name);
  const newPlans={all:await plan(),thread:await plan({field:'thread',value:'18446744073709551615'}),order:await plan({field:'order',value:'order-1'})};
  mkdirSync(new URL('../test-results/stage4a-2026-10-09/',import.meta.url),{recursive:true});
  writeFileSync(new URL('../test-results/stage4a-2026-10-09/conversation-index-plans.json',import.meta.url),JSON.stringify({oldPlans,newPlans},null,2));
  assert.ok(newPlans.all.some(line=>line.includes('conversation_org_time_idx')),'global conversation order must use the company/time index');
  assert.ok(!newPlans.all.some(line=>line.includes('USE TEMP B-TREE FOR ORDER BY')),'the global page must not sort the whole company');
  assert.ok(newPlans.thread.some(line=>line.includes('conversation_org_thread_idx')),'exact thread lookup must use its company/thread index');
  assert.ok(newPlans.order.some(line=>line.includes('message_org_order_idx')),'exact order lookup must locate messages by company/order first');
  for(let index=0;index<preserved.length;index++)assert.deepEqual((await db.prepare(`SELECT * FROM ${preserved[index]}`).all()).results,before[index]!.results,preserved[index]);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
  await assert.rejects(db.prepare("UPDATE message SET content='[\"changed\"]'").run(),/MESSAGE_IMMUTABLE/);
  await db.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id='store'").run();
  assert.equal(await db.prepare('SELECT enabled FROM store_sync_source').first('enabled'),0);
  assert.equal(await db.prepare('SELECT lease_token FROM store_coordinator').first('lease_token'),null);
  assert.equal(await db.prepare('SELECT blocked_until FROM store_coordinator').first('blocked_until'),until);
  for(const name of files.filter(name=>name>='0010'))await apply(db,name);
  const page=await listConversations(db,actor,{limit:50});assert.ok(page);
  assert.equal(page.items[0]?.id,'conv');assert.equal(page.items[0]?.latestMessage?.platformMessageId,'18446744073709551615');
  assert.deepEqual(page.items[0]?.workflow,{version:0,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:null,assigneeName:null});
  assert.deepEqual(page.counts,{all:1,mine:0,unassigned:1});assert.equal(page.viewerMemberId,'owner-member');
});
