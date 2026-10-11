import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { findConversation, InvalidConversationCursor, listConversations as readList, listMessages, listMessageUpdates } from '../src/modules/conversations/read.ts';
import type { StoreActor } from '../src/modules/stores/storage.ts';

async function listConversations(...args:Parameters<typeof readList>){const result=await readList(...args);assert.ok(result,'the viewer must remain authorized');return result;}

test('conversation read models enforce current scope with real D1 and stable history cursors', {timeout:90_000}, async context=>{
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort())for(const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean))await db.prepare(sql).run();
  const admin:StoreActor={orgId:'read-a',actorUserId:'admin',sessionId:'session-admin'};
  const member:StoreActor={orgId:'read-a',actorUserId:'agent',sessionId:'session-agent'};
  const other:StoreActor={orgId:'read-b',actorUserId:'owner',sessionId:'session-owner'};
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('read-a','A','read-a',1),('read-b','B','read-b',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES ('admin','Admin','admin@example.invalid',1),('agent','Agent','agent@example.invalid',1),('owner','Owner','owner@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES ('member-admin','read-a','admin','admin',1),('member-agent','read-a','agent','member',1),('member-owner','read-b','owner','owner',1)"),
    ...[admin,member,other].map(actor=>db.prepare('INSERT INTO session(id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(actor.sessionId,`token-${actor.actorUserId}`,actor.actorUserId,Date.now()+3_600_000)),
    ...[['s1','read-a','paused'],['s2','read-a','verified'],['sx','read-b','verified']].map(([id,org,status])=>db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,created_at,updated_at) VALUES (?,?,?, ?,?,'SECRET_KEY','SECRET_NONCE','SECRET_CIPHERTEXT',1,1)").bind(id,org,`Store ${id}`,id,status)),
    db.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('read-a','s1','member-agent',1)"),
    db.prepare("INSERT INTO store_coordinator(store_id,organization_id) VALUES ('s1','read-a')"),
    db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,last_success_at,last_error,updated_at) VALUES ('s1','read-a','chat',0,1,1,777,'history_denied',1)"),
  ]);
  const chats=[['c-a','s1','read-a','thread-a',200],['c-b','s1','read-a','thread-b',200],['c-empty1','s1','read-a','empty-1',null],['c-empty2','s1','read-a','empty-2',null],['c-x','s2','read-a','thread-x',300],['c-other','sx','read-b','thread-a',400]] as const;
  for(const [id,store,org,thread,last] of chats)await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_id,imported_at,last_message_at) VALUES (?,?,?,?,'BUYER_SELLER','PLATFORM_UNKNOWN',10,'999999999999999999999',20,?)").bind(id,org,store,thread,last).run();
  const big='9000000000817031942';
  async function message(id:string,conversationId:string,storeId:string,orgId:string,eventAt:number,order='order-01',sender='Customer',image=false,content=[`raw-${id}`,'<script>alert(1)</script>','https://untrusted.invalid/image.png']){
    await db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,300,'backfill')")
      .bind(id,orgId,storeId,conversationId,big+(id.match(/[0-9]+/)?.[0]??'00'),big,sender,sender==='Customer'?'inbound':'unknown',JSON.stringify(content),image?1:0,1,order,big,eventAt).run();
  }
  for(const [id,time]of [['m-01',100],['m-02',200],['m-03',200]] as const)await message(id,'c-a','s1','read-a',time,'order-01',id==='m-03'?'FutureSender':'Customer',id==='m-03');
  await message('m-b','c-b','s1','read-a',200,'order_01');
  await message('m-x','c-x','s2','read-a',300,'order-01');
  await message('m-other','c-other','sx','read-b',400,'order-01');
  for(const [id,complete]of [['c-a',1],['c-b',0]] as const)await db.prepare("INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,conversation_id,due_at,completed) VALUES ('read-a','s1',?,'backfill',?,1,?)").bind(id==='c-a'?'thread-a':'thread-b',id,complete).run();
  const ids=(items:{id:string}[])=>items.map(item=>item.id);
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const decode=(value:string)=>JSON.parse(Buffer.from(value,'base64url').toString('utf8'));

  await context.test('list and exact lookup only reveal currently granted stores within the selected company',async()=>{
    assert.deepEqual(ids((await listConversations(db,admin,{limit:100})).items),['c-x','c-b','c-a','c-empty2','c-empty1']);
    assert.deepEqual(ids((await listConversations(db,member,{limit:100})).items),['c-b','c-a','c-empty2','c-empty1']);
    assert.deepEqual(ids((await listConversations(db,other,{limit:100})).items),['c-other']);
    assert.deepEqual((await listConversations(db,member,{storeId:'s2',limit:10})).items,[]);
    assert.deepEqual((await listConversations(db,admin,{storeId:'sx',limit:10})).items,[]);
    assert.equal(await findConversation(db,member,'c-x'),null);assert.equal(await findConversation(db,admin,'c-other'),null);
    assert.equal(await listMessages(db,member,'c-x',{limit:10}),null);assert.equal(await listMessages(db,admin,'missing',{limit:10}),null);
  });
  await context.test('summaries use the latest stored message and whitelist all returned fields',async()=>{
    const row=(await listConversations(db,member,{search:{field:'thread',value:'thread-a'},limit:10})).items[0];assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(),['id','importedAt','lastMessageAt','latestMessage','platformCreatedAt','platformStatus','platformThreadId','platformType','store','workflow']);
    assert.deepEqual(row.store,{id:'s1',name:'Store s1',status:'paused'});assert.equal(row.latestMessage?.id,'m-03');assert.equal(row.latestMessage?.platformMessageId,big+'03');
    assert.equal(row.latestMessage?.senderId,big);assert.equal(row.latestMessage?.senderType,'FutureSender');assert.equal(row.latestMessage?.direction,'unknown');assert.equal(row.latestMessage?.isImage,true);
    assert.deepEqual(row.latestMessage?.content,['raw-m-03']);assert.equal((row.latestMessage as any)?.previewTruncated,true);
    assert.equal(JSON.stringify(row).includes('SECRET'),false);assert.equal('lastMessageId' in row,false);assert.equal('isRead' in row.latestMessage!,false);
  });
  await context.test('list keysets handle equal times and null-time empty conversations without repeating rows',async()=>{
    let cursor:string|undefined;const seen:string[]=[];
    do{const page=await listConversations(db,admin,{limit:2,...(cursor?{cursor}:{})});seen.push(...ids(page.items));cursor=page.nextCursor??undefined;}while(cursor);
    assert.deepEqual(seen,['c-x','c-b','c-a','c-empty2','c-empty1']);
    const exact=await listConversations(db,member,{limit:4});assert.equal(exact.nextCursor,null);
  });
  await context.test('detail reports only stored source observations and preserves paused history',async()=>{
    const row=await findConversation(db,member,'c-a');assert.ok(row);assert.equal(row.store.status,'paused');
    assert.deepEqual(row.sync,{enabled:false,lastSuccessAt:777,lastError:'history_denied',backfillComplete:true});
    assert.equal((await findConversation(db,member,'c-b'))?.sync.backfillComplete,false);
    const empty=await findConversation(db,member,'c-empty1');assert.equal(empty?.latestMessage,null);assert.equal(empty?.sync.backfillComplete,null);
    assert.deepEqual((await findConversation(db,admin,'c-x'))?.sync,{enabled:false,lastSuccessAt:null,lastError:null,backfillComplete:null});
    assert.equal(JSON.stringify(row).includes('SECRET'),false);assert.equal('customer' in row,false);assert.equal('orders' in row,false);
  });
  await context.test('message pages read newest first but render oldest to newest and keep IDs precise',async()=>{
    const first=await listMessages(db,member,'c-a',{limit:2});assert.ok(first);assert.deepEqual(ids(first.items),['m-02','m-03']);assert.ok(first.nextCursor);
    const second=await listMessages(db,member,'c-a',{limit:2,cursor:first.nextCursor});assert.ok(second);assert.deepEqual(ids(second.items),['m-01']);assert.equal(second.nextCursor,null);
    assert.equal(first.items[1].sku,big);assert.equal(first.items[1].platformMessageId,big+'03');assert.equal(first.items[1].eventAt,200);assert.equal(first.items[1].receivedAt,300);assert.equal(first.items[1].ingestMode,'backfill');
    assert.equal(first.items[1].orderNumber,'order-01');assert.equal('isRead' in first.items[1],false);
    const empty=await listMessages(db,member,'c-empty1',{limit:2});assert.ok(empty);assert.deepEqual(empty.items,[]);assert.equal(empty.nextCursor,null);
    assert.equal(empty.viewerMemberId,'member-agent');assert.equal(typeof empty.pageCursor,'string');assert.equal(typeof empty.updatesCursor,'string');
  });
  await context.test('exact thread and order searches are scoped and treat wildcard-looking text literally',async()=>{
    assert.deepEqual(ids((await listConversations(db,member,{search:{field:'order',value:'order-01'},limit:10})).items),['c-a']);
    assert.deepEqual(ids((await listConversations(db,member,{search:{field:'order',value:'order_01'},limit:10})).items),['c-b']);
    for(const value of ['thread','%','order%','order-01\' OR 1=1 --'])assert.deepEqual((await listConversations(db,member,{search:{field:'thread',value},limit:10})).items,[]);
  });
  await context.test('cursors reject malformed encodings, versions, fields and sort values',async()=>{
    const first=await listConversations(db,admin,{limit:1});assert.ok(first.nextCursor);const value=decode(first.nextCursor);
    const invalid=['', '*', 'A', first.nextCursor+'=', 'a'.repeat(8193),encode(null),encode([]),encode({...value,v:1}),encode({...value,extra:true}),encode({...value,id:''}),encode({...value,at:-1}),encode({...value,at:0.5}),encode({...value,at:9007199254740992}),encode({...value,at:'300'})];
    for(const cursor of invalid)await assert.rejects(()=>listConversations(db,admin,{limit:1,cursor}),InvalidConversationCursor);
    const page=await listMessages(db,member,'c-a',{limit:1});assert.ok(page?.nextCursor);
    await assert.rejects(()=>listMessages(db,member,'c-a',{limit:1,cursor:encode({...decode(page.nextCursor!),at:null})}),InvalidConversationCursor);
  });
  await context.test('cursors bind company, filters, resource kind and conversation but never grant access',async()=>{
    const page=await listConversations(db,admin,{limit:1});assert.ok(page.nextCursor);
    for(const options of [{storeId:'s1'},{search:{field:'thread' as const,value:'thread-a'}}])await assert.rejects(()=>listConversations(db,admin,{...options,limit:1,cursor:page.nextCursor!}),InvalidConversationCursor);
    await assert.rejects(()=>listConversations(db,other,{limit:1,cursor:page.nextCursor!}),InvalidConversationCursor);
    await assert.rejects(()=>listMessages(db,admin,'c-a',{limit:1,cursor:page.nextCursor!}),InvalidConversationCursor);
    const messages=await listMessages(db,member,'c-a',{limit:1});assert.ok(messages?.nextCursor);
    await assert.rejects(()=>listMessages(db,member,'c-b',{limit:1,cursor:messages.nextCursor!}),InvalidConversationCursor);
    const forged=encode({...decode(page.nextCursor),viewerMemberId:'member-agent',at:null,id:'zzzz'});
    assert.equal((await listConversations(db,member,{limit:100,cursor:forged})).items.some(item=>item.store.id==='s2'),false);
  });
  await context.test('query budgets fail before touching D1',async()=>{
    const forbidden={prepare(){throw new Error('database must not be reached');}} as unknown as D1Database;
    for(const limit of [0,101,1.5,NaN])await assert.rejects(()=>listConversations(forbidden,admin,{limit}),RangeError);
    for(const search of [{field:'body',value:'x'},{field:'order',value:''},{field:'thread',value:'x'.repeat(257)}])await assert.rejects(()=>listConversations(forbidden,admin,{limit:1,search:search as any}),RangeError);
    await assert.rejects(()=>listMessages(forbidden,admin,'c-a',{limit:101}),RangeError);
    await assert.rejects(()=>listConversations(forbidden,admin,{limit:1,storeId:''}),RangeError);
  });
  await context.test('revoked grants, expired sessions and unverified accounts invalidate every fresh read',async()=>{
    const page=await listMessages(db,member,'c-a',{limit:1});assert.ok(page?.nextCursor);
    await db.prepare("DELETE FROM store_grant WHERE store_id='s1' AND member_id='member-agent'").run();
    assert.deepEqual((await listConversations(db,member,{limit:100})).items,[]);assert.equal(await findConversation(db,member,'c-a'),null);assert.equal(await listMessages(db,member,'c-a',{limit:1,cursor:page.nextCursor}),null);
    await db.prepare("INSERT INTO store_grant VALUES ('read-a','s1','member-agent',1)").run();
    await db.prepare("UPDATE session SET expires_at=1 WHERE id='session-agent'").run();
    assert.equal(await readList(db,member,{limit:100}),null);assert.equal(await findConversation(db,member,'c-a'),null);assert.equal(await listMessages(db,member,'c-a',{limit:1}),null);
    await db.prepare("UPDATE session SET expires_at=? WHERE id='session-agent'").bind(Date.now()+3_600_000).run();
    await db.prepare("UPDATE user SET email_verified=0 WHERE id='agent'").run();
    assert.equal(await readList(db,member,{limit:100}),null);assert.equal(await findConversation(db,member,'c-a'),null);assert.equal(await listMessages(db,member,'c-a',{limit:1}),null);
    await db.prepare("UPDATE user SET email_verified=1 WHERE id='agent'").run();
  });
  await context.test('summary previews bound content inside SQL and mark partial Unicode snippets',async()=>{
    await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at,last_message_at) VALUES ('c-long','read-a','s1','thread-long','BUYER_SELLER','OPEN',1,1,500)").run();
    await message('m-long','c-long','s1','read-a',500,'order-long','Customer',false,['🙂'.repeat(281),'more']);
    const queries:string[]=[];const readonly={prepare(sql:string){queries.push(sql);return db.prepare(sql);}} as unknown as D1Database;
    const row=(await listConversations(readonly,member,{search:{field:'thread',value:'thread-long'},limit:1})).items[0];assert.ok(row?.latestMessage);
    assert.deepEqual(row.latestMessage.content,['🙂'.repeat(280)]);assert.equal((row.latestMessage as any).previewTruncated,true);assert.ok(queries[0].includes('substr('));
    await message('m-empty9','c-long','s1','read-a',501,'order-long','Customer',false,[]);
    const empty=(await findConversation(db,member,'c-long'))?.latestMessage;assert.deepEqual(empty?.content,[]);assert.equal((empty as any)?.previewTruncated,false);
  });
  await context.test('SQL byte budgets preserve oversized messages and advance actual page boundaries without losing history',async()=>{
    await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at,last_message_at) VALUES ('c-budget','read-a','s1','thread-budget','BUYER_SELLER','OPEN',1,1,600)").run();
    const bodies=['Б'.repeat(300_000),'Б'.repeat(300_000),'x'.repeat(940*1024)];
    for(let index=0;index<3;index++)await message(`m-budget${index}`,'c-budget','s1','read-a',600+index,'order-budget','Customer',false,[bodies[index]]);
    const seen:string[]=[];let cursor:string|undefined;
    do{const page=await listMessages(db,member,'c-budget',{limit:50,...(cursor?{cursor}:{})});assert.ok(page);assert.equal(page.items.length,1);seen.push(page.items[0].id);
      assert.equal(page.items[0].content[0],bodies[Number(page.items[0].id.at(-1))]);cursor=page.nextCursor??undefined;assert.ok(seen.length<=3,'each oversized page must make progress');}while(cursor);
    assert.deepEqual(seen,['m-budget2','m-budget1','m-budget0']);
  });
  await context.test('all query paths are SELECT-only and retain scoped index query plans',async()=>{
    const statements:{sql:string;values:(string|number|null)[]}[]=[];
    const readonly={prepare(sql:string){return {bind(...values:(string|number|null)[]){statements.push({sql,values});return db.prepare(sql).bind(...values);}};}} as unknown as D1Database;
    const before=await db.prepare('SELECT id,content,is_read FROM message ORDER BY id').all();
    await listConversations(readonly,member,{storeId:'s1',limit:2});await findConversation(readonly,member,'c-a');const history=await listMessages(readonly,member,'c-a',{limit:2});assert.ok(history);
    await listConversations(readonly,admin,{limit:2});await listConversations(readonly,member,{search:{field:'order',value:'order-01'},limit:2});
    await listConversations(readonly,member,{search:{field:'thread',value:'thread-a'},limit:2});
    await listMessageUpdates(readonly,member,'c-a',{limit:2,cursor:history.updatesCursor});
    await listMessages(readonly,member,'c-a',{limit:2,cursor:history.pageCursor,anchorId:'m-02',direction:'from'});
    assert.ok(statements.length);assert.ok(statements.every(({sql})=>/^\s*(SELECT|WITH)\b/i.test(sql)));assert.ok(statements.every(({sql})=>sql.includes('store_grant')&&sql.includes('session')));
    assert.deepEqual((await db.prepare('SELECT id,content,is_read FROM message ORDER BY id').all()).results,before.results);
    const plans=await db.prepare("EXPLAIN QUERY PLAN SELECT id FROM message WHERE organization_id='read-a' AND conversation_id='c-a' ORDER BY event_at DESC,id DESC LIMIT 51").all();
    assert.ok(plans.results.some(row=>String(row.detail).includes('message_conversation_time_idx')));
    const output='test-results/conversations-read';mkdirSync(output,{recursive:true});writeFileSync(`${output}/conversations-message-query-plan.json`,JSON.stringify(plans.results,null,2));
    type QueryPlan={id:number;parent:number;detail:string};
    const actual:QueryPlan[][]=[];for(const statement of statements)actual.push((await db.prepare('EXPLAIN QUERY PLAN '+statement.sql).bind(...statement.values).all<QueryPlan>()).results);
    writeFileSync(`${output}/conversations-query-plans.json`,JSON.stringify({order:['store-list','detail','messages','all-store-list','exact-order-search','exact-thread-search','message-updates','history-anchor','history-from'],plans:actual},null,2));
    for(const [query,index]of [[2,'message_conversation_time_idx'],[6,'sqlite_autoindex_message_append_1'],[8,'message_conversation_time_idx']] as const){
      const candidate=actual[query].find(row=>row.detail==='MATERIALIZE candidates');assert.ok(candidate);
      const descendants=new Set([candidate.id]);for(const row of actual[query])if(descendants.has(row.parent))descendants.add(row.id);
      assert.ok(actual[query].some(row=>descendants.has(row.id)&&String(row.detail).includes(index)),'message candidates must seek the scoped ordering index');
      assert.equal(actual[query].some(row=>descendants.has(row.id)&&String(row.detail).includes('TEMP B-TREE')),false,'only the bounded page may be sorted');
      assert.equal(statements[query].values.at(-2),3);assert.equal(statements[query].values.at(-1),2);
      if(query!==6)assert.ok(actual[query].some(row=>row.detail.includes('SEARCH other USING')&&row.detail.includes('message_conversation_time_idx')),'opposite-direction availability must use the scoped time index');
    }
    const pageNode=actual[3].find(row=>row.detail==='MATERIALIZE page');assert.ok(pageNode);
    const descendants=new Set([pageNode.id]);for(const row of actual[3])if(descendants.has(row.parent))descendants.add(row.id);
    assert.ok(actual[3].some(row=>descendants.has(row.id)&&String(row.detail).includes('conversation_org_time_idx')),'the page must retain its ordered company index');
    assert.equal(actual[3].some(row=>descendants.has(row.id)&&String(row.detail).includes('TEMP B-TREE')),false,'the page must not sort the whole company');
    assert.equal(actual[3].filter(row=>String(row.detail).includes('TEMP B-TREE')).length,1,'only the bounded outer page output is sorted');
    assert.equal(statements[3].values.at(-1),3,'the outer sort has at most limit+1 page rows');
    const totalsNode=actual[3].find(row=>row.detail==='MATERIALIZE totals');assert.ok(totalsNode);
    descendants.add(totalsNode.id);for(const row of actual[3])if(descendants.has(row.parent))descendants.add(row.id);
    assert.equal(actual[3].some(row=>descendants.has(row.id)&&/SEARCH (recent|assignee|assignee_user) /.test(String(row.detail))),false,'counts and page IDs cannot expand message bodies or author names');
    assert.ok(actual[4].some(row=>String(row.detail).includes('order_number=?')),'order lookup must seek its exact order rather than scan each history');
    assert.ok(actual[5].some(row=>String(row.detail).includes('platform_thread_id=?')),'thread lookup must seek the exact platform thread');
  });
});
