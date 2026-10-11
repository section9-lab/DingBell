import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, folder), 'utf8'));
  return db;
}

test('message synchronization persists its company-scoped entities and checkpoints', () => {
  const db = fixture();
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    for (const name of ['conversation', 'message', 'ingest_event', 'store_coordinator', 'store_sync_source', 'sync_cursor']) assert.ok(tables.includes(name), `${name} must be persisted`);
  } finally { db.close(); }
});

import { Miniflare } from 'miniflare';
import { getSyncSource, setSyncSourceEnabled, getStoreCoordinatorRuntime, releaseSyncLease, prepareSyncPageGate, syncPageCondition, prepareSyncPageFinish, claimSyncLease, commitSyncPage, finishSyncFailure, getDueSyncCursor, getStoreSync, getSyncRuntime, listDueSyncStores, setStoreSyncEnabled } from '../src/modules/sync/storage.ts';
import type { NormalizedMessage, SyncLease } from '../src/modules/sync/types.ts';

test('real D1 synchronization commits an immutable page and its checkpoint under live fences', { timeout: 60_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(new URL(name, folder), 'utf8').split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  const orgId = 'sync-org';
  const actor = { orgId, actorUserId: 'sync-admin', sessionId: 'sync-session' };
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('sync-org','Sync','sync',1),('other-org','Other','other',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('sync-admin','Admin','sync@example.invalid',1),('sync-member','Member','member@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('sync-admin-member','sync-org','sync-admin','admin',1),('sync-member-member','sync-org','sync-member','member',1)"),
    db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(actor.sessionId, actor.sessionId, actor.actorUserId, Date.now() + 3_600_000),
  ]);
  async function addStore(id: string) {
    await db.prepare(`INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,checked_at,expires_at,created_at,updated_at)
      VALUES (?,?,'Sync',?,'verified','synthetic','synthetic','synthetic',?,1,?,1,1)`).bind(id, orgId, id, JSON.stringify([{code:'auth',status:'available',reason:'read_verified'},{code:'chats_read',status:'available',reason:'read_verified'}]), Date.now() + 60_000).run();
    const state = await setStoreSyncEnabled(db, actor, id, 0, true);
    assert.equal(state?.enabled, true);
    return id;
  }
  async function lease(storeId: string) {
    await db.prepare('UPDATE store_sync_source SET due_at=1 WHERE store_id=?').bind(storeId).run();
    const claimed = await claimSyncLease(db, { orgId, storeId, token: crypto.randomUUID() });
    assert.ok(claimed);
    return claimed;
  }
  async function discover(storeId: string) {
    const claimed = await lease(storeId);
    const cursor = await getDueSyncCursor(db, claimed); assert.ok(cursor);
    assert.equal(cursor.stream, 'discovery');
    const committed = await commitSyncPage(db, claimed, { cursor, nextCursor: null, nextDueAt: Date.now() + 60_000, completed: false,
      chats: [{ platformThreadId: 'chat-1', type: 'buyer_seller', status: 'opened', createdAt: 100, lastMessageId: '18446744073709551615' }],
      seeds: [{ threadId:'chat-1',stream:'backfill',cursor:null,dueAt:1 },{ threadId:'chat-1',stream:'incremental',cursor:'18446744073709551615',dueAt:Date.now()+60_000 }] });
    assert.ok(committed); return committed;
  }
  const content = (id: string, text = 'Привет'): NormalizedMessage => ({ platformThreadId:'chat-1', platformMessageId:id,senderId:'9007199254740993',senderType:'Customer',direction:'inbound',content:[text],isRead:false,isImage:false,orderNumber:null,sku:null,eventAt:1000 });
  async function commitMessages(claimed: SyncLease, messages: NormalizedMessage[], nextCursor = 'next') {
    const cursor = await getDueSyncCursor(db, claimed); assert.ok(cursor);
    return commitSyncPage(db, claimed, { cursor,nextCursor,nextDueAt:1,completed:false,messages });
  }

  await context.test('only current managers enable, machine authorization persists after logout, and lease has one winner', async () => {
    const id = await addStore('permissions');
    assert.equal(await setStoreSyncEnabled(db, { ...actor, actorUserId:'sync-member' }, id, 1, false), null);
    assert.equal(await setStoreSyncEnabled(db, actor, id, 0, false), null);
    const claims = await Promise.all(['a','b'].map(token => claimSyncLease(db,{orgId,storeId:id,token})));
    assert.equal(claims.filter(Boolean).length,1);
    await db.prepare('UPDATE session SET expires_at=1 WHERE id=?').bind(actor.sessionId).run();
    assert.ok(await getSyncRuntime(db,{orgId,storeId:id}));
    assert.equal(await getStoreSync(db,actor,id),null);
    await db.prepare('UPDATE session SET expires_at=? WHERE id=?').bind(Date.now()+3_600_000,actor.sessionId).run();
    assert.equal((await getStoreSync(db,actor,id))?.enabled,true);
  });
  await context.test('history replay preserves exact IDs, immutable content, and one historical event', async () => {
    const id = await addStore('replay'); await discover(id);
    const before = await lease(id); const replayCursor = await getDueSyncCursor(db,before); assert.ok(replayCursor);
    const replayPage = {cursor:replayCursor,nextCursor:'next',nextDueAt:1,completed:false,messages:[content('18446744073709551615')]};
    assert.ok(await commitSyncPage(db,before,replayPage));
    assert.equal(await commitSyncPage(db,before,replayPage),null);
    assert.ok(await commitMessages(await lease(id),[{...content('18446744073709551615'),isRead:true,orderNumber:'now-associated'}]));
    const rows = await db.prepare('SELECT platform_message_id,sender_id,content FROM message WHERE store_id=?').bind(id).all();
    assert.equal(rows.results.length,1); assert.equal(rows.results[0].platform_message_id,'18446744073709551615');
    assert.equal(rows.results[0].sender_id,'9007199254740993'); assert.equal(rows.results[0].content,'["Привет"]');
    assert.equal(await db.prepare('SELECT state FROM ingest_event WHERE store_id=?').bind(id).first('state'),'historical');
    const cursors = await db.prepare('SELECT stream,cursor FROM sync_cursor WHERE store_id=? ORDER BY stream').bind(id).all();
    assert.equal(cursors.results.find(row=>row.stream==='incremental')?.cursor,'18446744073709551615');
  });
  await context.test('a conflicting duplicate rolls back new messages and cursor progress', async () => {
    const id = await addStore('conflict'); await discover(id);
    assert.ok(await commitMessages(await lease(id),[content('first')]));
    const claimed = await lease(id);
    await assert.rejects(commitMessages(claimed,[content('new'),content('first','changed')],'must-not-advance'),/MESSAGE_ID_CONFLICT/);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM message WHERE store_id=?').bind(id).first('count'),1);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='backfill'").bind(id).first('cursor'),'next');
    assert.equal(await db.prepare('SELECT count(*) AS count FROM ingest_event WHERE store_id=?').bind(id).first('count'),1);
  });
  await context.test('outbox failure rolls back all imported facts and cursor changes', async () => {
    const id = await addStore('outbox-failure'); await discover(id);
    await db.prepare("CREATE TRIGGER synthetic_outbox_failure BEFORE INSERT ON ingest_event WHEN NEW.store_id='outbox-failure' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FAILURE'); END").run();
    await assert.rejects(commitMessages(await lease(id),[content('new')]),/SYNTHETIC_FAILURE/);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM message WHERE store_id=?').bind(id).first('count'),0);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='backfill'").bind(id).first('cursor'),null);
  });
  for (const race of ['paused','disconnected','rotated','disabled','expired','replacement','revision'] as const) await context.test(`late page writes nothing after ${race}`, async () => {
    const id = await addStore(`race-${race}`); await discover(id); const claimed = await lease(id);
    const cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
    if (race==='paused' || race==='disconnected') await db.prepare('UPDATE store SET status=?,revision=revision+1 WHERE id=?').bind(race,id).run();
    if (race==='rotated') await db.prepare('UPDATE store SET credential_version=credential_version+1,revision=revision+1 WHERE id=?').bind(id).run();
    if (race==='revision') await db.prepare('UPDATE store SET revision=revision+1 WHERE id=?').bind(id).run();
    if (race==='disabled') assert.ok(await setStoreSyncEnabled(db,actor,id,1,false));
    if (race==='expired') await db.prepare('UPDATE store_coordinator SET lease_until=1 WHERE store_id=?').bind(id).run();
    if (race==='replacement') await db.prepare("UPDATE store_coordinator SET fence=fence+1,lease_token='new' WHERE store_id=?").bind(id).run();
    assert.equal(await commitSyncPage(db,claimed,{cursor,nextCursor:'bad',nextDueAt:1,completed:false,messages:[content('late')]}),null);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM message WHERE store_id=?').bind(id).first('count'),0);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='backfill'").bind(id).first('cursor'),null);
    assert.equal(await finishSyncFailure(db,claimed,{code:'late',nextDueAt:1}),false);
    if (['paused','disconnected','rotated'].includes(race)) assert.equal((await getStoreSync(db,actor,id))?.enabled,false);
  });
  await context.test('cross-company message and cursor associations fail database constraints', async () => {
    const id = await addStore('isolation'); await discover(id);
    await assert.rejects(db.prepare("UPDATE conversation SET organization_id='other-org' WHERE store_id=?").bind(id).run(),/FOREIGN KEY/);
    await assert.rejects(db.prepare("UPDATE sync_cursor SET organization_id='other-org' WHERE store_id=?").bind(id).run(),/FOREIGN KEY/);
  });
  await context.test('unmatched message threads cannot silently advance the committed cursor', async () => {
    const id = await addStore('thread-mismatch'); await discover(id); const claimed = await lease(id);
    await assert.rejects(commitMessages(claimed,[{...content('missing'),platformThreadId:'never-discovered'}]),/INVALID_SYNC_PAGE/);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='backfill'").bind(id).first('cursor'),null);
  });
  await context.test('database updates cannot overwrite the original message', async () => {
    const id = await addStore('immutable-update'); await discover(id);
    assert.ok(await commitMessages(await lease(id),[content('original')]));
    await assert.rejects(db.prepare("UPDATE message SET content='[\"modified\"]' WHERE store_id=?").bind(id).run(),/MESSAGE_IMMUTABLE/);
    assert.equal(await db.prepare('SELECT content FROM message WHERE store_id=?').bind(id).first('content'),'["Привет"]');
  });
  await context.test('enable receipt is the committed mutation snapshot despite a following background write', async () => {
    const id = await addStore('receipt-race');
    const racing = { prepare: db.prepare.bind(db), batch: async (statements: D1PreparedStatement[]) => {
      const result = await db.batch(statements);
      await db.prepare('UPDATE store_sync_source SET enabled=1,epoch=epoch+1 WHERE store_id=?').bind(id).run();
      return result;
    } } as unknown as D1Database;
    const receipt = await setStoreSyncEnabled(racing,actor,id,1,false);
    assert.equal(receipt?.epoch,2); assert.equal(receipt?.enabled,false);
    assert.equal((await getStoreSync(db,actor,id))?.epoch,3);
  });
  await context.test('provider cooldown survives manual reenable and credential lifecycle transitions', async () => {
    const id = await addStore('cooldown'); const claimed = await lease(id);
    const blockedUntil = Date.now()+120_000;
    assert.ok(await finishSyncFailure(db,claimed,{code:'rate_limited',nextDueAt:blockedUntil,blockedUntil}));
    const updated = await setStoreSyncEnabled(db,actor,id,1,true); assert.ok(updated);
    assert.equal(await claimSyncLease(db,{orgId,storeId:id,token:'premature'}),null);
    assert.equal(updated.blockedUntil,blockedUntil); assert.ok(updated.dueAt>=blockedUntil);
    await db.prepare("UPDATE store SET status='paused',revision=revision+1 WHERE id=?").bind(id).run();
    assert.equal((await getStoreSync(db,actor,id))?.blockedUntil,blockedUntil);
  });
  await context.test('only newly observed Forward input promotes a historical event, once, excluding its anchor', async () => {
    const id = await addStore('live-promotion'); await discover(id);
    const anchor='18446744073709551615', next='18446744073709551616';
    assert.ok(await commitMessages(await lease(id),[content(anchor),content(next)]));
    await db.prepare("UPDATE sync_cursor SET completed=1 WHERE store_id=? AND stream='backfill'").bind(id).run();
    await db.prepare("UPDATE sync_cursor SET due_at=0 WHERE store_id=? AND stream='incremental'").bind(id).run();
    const claimed = await lease(id); const cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor); assert.equal(cursor.stream,'incremental');
    assert.ok(await commitSyncPage(db,claimed,{cursor,nextCursor:next,nextDueAt:1,completed:false,messages:[{...content(anchor),liveObserved:true},{...content(next),liveObserved:true}]}));
    const events = await db.prepare('SELECT message.platform_message_id AS id,ingest_event.state,message.ingest_mode AS mode FROM ingest_event JOIN message ON message.id=ingest_event.message_id WHERE message.store_id=?').bind(id).all();
    assert.equal(events.results.find(event=>event.id===next)?.state,'pending');
    assert.ok(await db.prepare('SELECT live_observed_at FROM ingest_event WHERE message_id=(SELECT id FROM message WHERE store_id=? AND platform_message_id=?)').bind(id,next).first('live_observed_at'));
    assert.equal(events.results.find(event=>event.id===next)?.mode,'backfill');
    assert.equal(events.results.find(event=>event.id===anchor)?.state,'historical');
    assert.equal(await db.prepare('SELECT live_observed_at FROM ingest_event WHERE message_id=(SELECT id FROM message WHERE store_id=? AND platform_message_id=?)').bind(id,anchor).first('live_observed_at'),null);
    assert.equal(events.results.length,2);
  });
  await context.test('overdue discovery has an opportunity before a large historical backlog', async () => {
    const id = await addStore('fair-discovery'); await discover(id);
    await db.prepare("UPDATE sync_cursor SET due_at=2 WHERE store_id=? AND stream='discovery'").bind(id).run();
    assert.equal((await getDueSyncCursor(db,await lease(id)))?.stream,'discovery');
  });
  await context.test('recent cursor loops are rejected across independently claimed pages', async () => {
    const id = await addStore('cursor-loop');
    for (const nextCursor of ['A','B']) {
      const claimed = await lease(id), cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
      assert.ok(await commitSyncPage(db,claimed,{cursor,nextCursor,nextDueAt:1,completed:false,continuing:true}));
    }
    const claimed = await lease(id), cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
    await assert.rejects(commitSyncPage(db,claimed,{cursor:{...cursor,recentCursors:[]},nextCursor:'A',nextDueAt:1,completed:false,continuing:true}),/cursor_stalled/);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='discovery'").bind(id).first('cursor'),'B');
  });
  await context.test('an initially empty thread atomically establishes a historical baseline and resumes older pages', async () => {
    const id = await addStore('empty-baseline'); await discover(id);
    await db.prepare("UPDATE sync_cursor SET completed=1 WHERE store_id=? AND stream='backfill'").bind(id).run();
    await db.prepare("UPDATE sync_cursor SET cursor=NULL,due_at=0 WHERE store_id=? AND stream='incremental'").bind(id).run();
    const claimed = await lease(id), cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
    assert.ok(await commitSyncPage(db,claimed,{cursor,nextCursor:'newest',nextDueAt:Date.now()+30_000,completed:false,bootstrapSnapshot:true,
      messages:[content('newest'),content('oldest-on-page')],restartBackfill:{cursor:'oldest-on-page'}}));
    assert.equal(await db.prepare("SELECT count(*) AS count FROM ingest_event WHERE store_id=? AND state='historical'").bind(id).first('count'),2);
    assert.equal(await db.prepare("SELECT count(*) AS count FROM message WHERE store_id=? AND ingest_mode='backfill'").bind(id).first('count'),2);
    const resumed = await db.prepare("SELECT cursor,completed FROM sync_cursor WHERE store_id=? AND stream='backfill'").bind(id).first<{cursor:string;completed:number}>();
    assert.equal(resumed?.cursor,'oldest-on-page'); assert.equal(resumed?.completed,0);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='incremental'").bind(id).first('cursor'),'newest');
  });
  await context.test('invalid bootstrap evidence cannot promote messages or reopen an unrelated cursor', async () => {
    const id = await addStore('invalid-baseline'); await discover(id);
    const claimed = await lease(id), cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
    await assert.rejects(commitSyncPage(db,claimed,{cursor,nextCursor:'bad',nextDueAt:1,completed:false,bootstrapSnapshot:true,messages:[content('bad')]}),/INVALID_SYNC_PAGE/);
    await assert.rejects(commitSyncPage(db,claimed,{cursor,nextCursor:'bad',nextDueAt:1,completed:false,restartBackfill:{cursor:'bad'},messages:[content('bad')]}),/INVALID_SYNC_PAGE/);
  });
  await context.test('backfill restart failure rolls back the newly established baseline', async () => {
    const id = await addStore('baseline-rollback'); await discover(id);
    await db.prepare("UPDATE sync_cursor SET completed=1 WHERE store_id=? AND stream='backfill'").bind(id).run();
    await db.prepare("UPDATE sync_cursor SET cursor=NULL,due_at=0 WHERE store_id=? AND stream='incremental'").bind(id).run();
    await db.prepare("CREATE TRIGGER synthetic_restart_failure BEFORE UPDATE ON sync_cursor WHEN NEW.store_id='baseline-rollback' AND NEW.stream='backfill' BEGIN SELECT RAISE(ABORT,'RESTART_FAILURE'); END").run();
    const claimed = await lease(id), cursor = await getDueSyncCursor(db,claimed); assert.ok(cursor);
    await assert.rejects(commitSyncPage(db,claimed,{cursor,nextCursor:'newest',nextDueAt:1,completed:false,bootstrapSnapshot:true,
      messages:[content('newest'),content('oldest-on-page')],restartBackfill:{cursor:'oldest-on-page'}}),/RESTART_FAILURE/);
    assert.equal(await db.prepare('SELECT count(*) AS count FROM message WHERE store_id=?').bind(id).first('count'),0);
    assert.equal(await db.prepare("SELECT cursor FROM sync_cursor WHERE store_id=? AND stream='incremental'").bind(id).first('cursor'),null);
  });
  await context.test('bounded 100-message pages use JSON binds without exceeding D1 parameter limits', async () => {
    const id = await addStore('full-page'); await discover(id);
    const page = Array.from({length:100},(_,index)=>content(String(BigInt('9007199254740993')+BigInt(index))));
    assert.ok(await commitMessages(await lease(id),page));
    assert.equal((await getStoreSync(db,actor,id))?.messageCount,100);
    assert.ok((await listDueSyncStores(db)).some(item=>item.storeId===id));
  });
});

test('source permissions and outcomes remain isolated behind one store lease', {timeout:30_000}, async context => {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  context.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) for(const sql of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(part=>part.trim()).filter(Boolean)) await db.prepare(sql).run();
  const actor={orgId:'org',actorUserId:'admin',sessionId:'login'};
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Org','org',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('admin','Admin','admin@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('admin-member','org','admin','admin',1)"),
    db.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('login','token','admin',?,1,1)").bind(Date.now()+60_000),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES ('store','org','Store','1','partial','v1','nonce','ciphertext',?,?,1,1)").bind(JSON.stringify([{code:'auth',status:'available'},{code:'products_read',status:'available'},{code:'chats_read',status:'denied'}]),Date.now()+60_000),
  ]);
  const scope={orgId:'org',storeId:'store'};
  assert.ok(await setSyncSourceEnabled(db,actor,'store','products',0,true));
  assert.equal(await setStoreSyncEnabled(db,actor,'store',0,true),null);
  assert.equal((await getSyncSource(db,actor,'store','products'))?.enabled,true);
  await assert.rejects(db.prepare("UPDATE store_coordinator SET lease_token='partial',lease_until=1 WHERE store_id='store'").run(), /store_coordinator_lease_complete/);
  assert.ok(await getStoreCoordinatorRuntime(db,scope));
  assert.ok((await listDueSyncStores(db)).some(item=>item.storeId==='store'));
  const productLease=await claimSyncLease(db,{...scope,source:'products',token:'products-lease'}); assert.ok(productLease);
  assert.equal(productLease.source,'products');
  assert.ok(await setStoreSyncEnabled(db,actor,'store',0,false));
  assert.equal(await db.prepare("SELECT lease_token FROM store_coordinator WHERE store_id='store'").first('lease_token'),'products-lease');
  await db.prepare("UPDATE store_sync_source SET last_success_at=100,last_error='provider_unavailable',failures=2 WHERE source='products'").run();
  const token='product-page', condition=syncPageCondition(productLease,token);
  const result=await db.batch([prepareSyncPageGate(db,productLease,token),...prepareSyncPageFinish(db,productLease,token,{sql:'?',values:[Date.now()+60_000]},{success:false})]);
  assert.ok(result.at(-1)!.results.length); assert.ok(condition.sql.includes('commit_token'));
  assert.deepEqual(await db.prepare("SELECT last_success_at,last_error,failures FROM store_sync_source WHERE source='products'").first(),{last_success_at:100,last_error:'provider_unavailable',failures:2});
  await db.prepare("UPDATE store SET capabilities=? WHERE id='store'").bind(JSON.stringify([{code:'auth',status:'available'},{code:'products_read',status:'available'},{code:'chats_read',status:'available'}])).run();
  assert.ok(await setStoreSyncEnabled(db,actor,'store',1,true));
  await db.prepare("UPDATE store_sync_source SET due_at=1 WHERE store_id='store'").run();
  const winner=await claimSyncLease(db,{...scope,token:'first'}); assert.ok(winner); assert.equal(winner.source,'chat');
  assert.equal(await claimSyncLease(db,{...scope,source:'products',token:'second'}),null);
  assert.ok(await releaseSyncLease(db,winner,1));
  const next=await claimSyncLease(db,{...scope,token:'third'}); assert.ok(next); assert.equal(next.source,'products');
  assert.ok(await finishSyncFailure(db,next,{code:'permission_denied',nextDueAt:1,disable:true}));
  assert.equal((await getSyncSource(db,actor,'store','products'))?.enabled,false);
  assert.equal((await getStoreSync(db,actor,'store'))?.enabled,true);
  const chatLease=await claimSyncLease(db,{...scope,token:'chat-again'}); assert.ok(chatLease);
  assert.ok(await setSyncSourceEnabled(db,actor,'store','products',2,true));
  assert.equal(await db.prepare("SELECT lease_token FROM store_coordinator WHERE store_id='store'").first('lease_token'),'chat-again');
  assert.ok(await finishSyncFailure(db,chatLease,{code:'invalid_credentials',nextDueAt:1,disableAll:true}));
  assert.equal(await db.prepare("SELECT count(*) AS n FROM store_sync_source WHERE enabled=1").first('n'),0);
  assert.equal(await getStoreCoordinatorRuntime(db,scope),null);
  assert.equal(await finishSyncFailure(db,next,{code:'late',nextDueAt:1}),false);
  assert.equal(await setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true),null,'product or chat capabilities never authorize FBS');
  await db.prepare("UPDATE store SET capabilities=? WHERE id='store'").bind(JSON.stringify([{code:'auth',status:'denied'},{code:'orders_fbs_read',status:'available'}])).run();
  assert.equal(await setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true),null,'FBS read evidence also requires verified credentials');
  await db.prepare("UPDATE store SET capabilities=? WHERE id='store'").bind(JSON.stringify([{code:'auth',status:'available'},{code:'orders_fbs_read',status:'available'}])).run();
  await db.prepare("CREATE TRIGGER synthetic_fbs_seed BEFORE INSERT ON fbs_sync_window BEGIN SELECT RAISE(ABORT,'FBS_SEED_FAILURE'); END").run();
  await assert.rejects(setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true),/FBS_SEED_FAILURE/);
  assert.equal((await getSyncSource(db,actor,'store','fbs_postings'))?.epoch,0,'a failed seed must roll back source authorization');
  await db.prepare('DROP TRIGGER synthetic_fbs_seed').run();
  assert.equal((await setSyncSourceEnabled(db,actor,'store','fbs_postings',0,true))?.enabled,true);
  assert.equal(await db.prepare("SELECT epoch FROM fbs_sync_window WHERE store_id='store'").first('epoch'),1);
  const fbsLease=await claimSyncLease(db,{...scope,token:'fbs-lease'});assert.equal(fbsLease?.source,'fbs_postings');
  const chatState=await getStoreSync(db,actor,'store');assert.ok(chatState);
  assert.ok(await setStoreSyncEnabled(db,actor,'store',chatState.epoch,false));
  assert.equal(await db.prepare("SELECT lease_token FROM store_coordinator WHERE store_id='store'").first('lease_token'),'fbs-lease');
});
