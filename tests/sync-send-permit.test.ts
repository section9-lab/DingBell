import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';

const root = fileURLToPath(new URL('../', import.meta.url));
async function modules() {
  const result: { type: 'ESModule'; path: string; contents: string }[] = [], visited = new Set<string>();
  async function add(path: string) {
    if (visited.has(path)) return; visited.add(path);
    let contents = stripTypeScriptTypes(await readFile(path, 'utf8'), { mode: 'transform' });
    if (/from ['"]valibot['"]/.test(contents)) {
      const dependency = fileURLToPath(import.meta.resolve('valibot'));
      contents = contents.replace(/from ['"]valibot['"]/g, `from ${JSON.stringify('./' + relative(dirname(path), dependency))}`); await add(dependency);
    }
    result.push({ type: 'ESModule', path, contents });
    for (const match of contents.matchAll(/\bfrom\s*['"](\.[^'"]+)['"]/g)) await add(resolve(dirname(path), match[1]!));
  }
  await add(join(root, 'src/modules/sync/coordinator.ts'));
  return [{ type: 'ESModule' as const, path: join(root, 'tests/send-permit-fixture.mjs'), contents: `
    import { StoreCoordinator } from '../src/modules/sync/coordinator.ts';
    export class TestCoordinator extends StoreCoordinator {
      async reserveReadForTest() { return this.reserve('chat-history',Date.now()); }
      async rateForTest() { return this.ctx.storage.get('rate'); }
    }
    export default { async fetch(request, env) {
      const input=await request.json(),stub=env.STORE_COORDINATOR.getByName(input.route);
      try {
        const result=input.op==='rate'?await stub.rateForTest():input.op==='read'?await stub.reserveReadForTest():input.op==='feedback'?await stub.recordSendRateLimit(input.scope,input.until):await stub.reserveSend(input.scope,input.now);
        return Response.json({result});
      } catch { return Response.json({error:'rejected'}, {status:400}); }
    }};
  ` }, ...result];
}

test('send permits share the durable read budget and reject route, scope and cooldown bypasses', { timeout: 60000 }, async t => {
  const path=await mkdtemp(join(tmpdir(),'dingbell-send-permit-'));
  const options={modules:await modules(),modulesRoot:root,compatibilityDate:'2026-06-01',d1Databases:{DB:'send-permit'},d1Persist:join(path,'d1'),
    durableObjects:{STORE_COORDINATOR:{className:'TestCoordinator',useSQLite:true}},durableObjectsPersist:join(path,'do'),
    outboundService:()=>{throw new Error('Permit tests cannot make provider requests');}};
  let mf=new Miniflare(options),db=await mf.getD1Database('DB');
  t.after(async()=>{await mf.dispose();await rm(path,{recursive:true,force:true});});
  const folder=join(root,'migrations');
  for(const name of(await readdir(folder)).filter(name=>name.endsWith('.sql')).sort())
    for(const sql of(await readFile(join(folder,name),'utf8')).split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await db.prepare(sql).run();
  await db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('org','Org','org',1),('other','Other','other',1)").run();
  for(const id of ['budget','cooldown','feedback-failure','paused','disconnected','foreign'])await db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES (?,'org','Store',?,'verified',1,1)").bind(id,id).run();
  const scope=(storeId='budget')=>({orgId:'org',storeId});
  async function call(op:string,current=scope(),extra:Record<string,unknown>={}) {
    const result=await mf.dispatchFetch('https://fixture.invalid',{method:'POST',body:JSON.stringify({op,scope:current,route:JSON.stringify([current.orgId,current.storeId]),...extra})});
    return {status:result.status,...await result.json() as {result?:number}};
  }
  await t.test('one current permit wins and a read shares the send slot across restart',async()=>{
    const before=Date.now();
    const permits=await Promise.all(Array.from({length:8},()=>call('send')));
    assert.ok(permits.every(value=>value.status===200));
    const accepted=permits.map(value=>value.result!).filter(value=>value<=Date.now());
    assert.equal(accepted.length,1);assert.ok(accepted[0]!>=before);
    const waiting=Math.max(...permits.map(value=>value.result!));
    assert.equal(waiting,accepted[0]!+1000);
    assert.equal((await call('read')).result,waiting);
    assert.ok((await call('send',scope('foreign'))).result!<waiting);
    const persisted = (await call('rate')).result;
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    assert.deepEqual((await call('rate')).result,persisted,'the shared all and send bucket timestamps survive restart');
    // Seed a longer read permit to make restart persistence independent of startup duration.
    const limit=Date.now()+60000;
    await db.prepare("INSERT INTO store_coordinator(store_id,organization_id,blocked_until) VALUES ('budget','org',?)").bind(limit).run();
    assert.equal((await call('send')).result,limit);
  });
  await t.test('feedback persists a shared monotonic cooldown without requiring a sync source or disturbing leases',async()=>{
    const current=scope('cooldown'),until=Date.now()+60000;
    assert.equal((await call('feedback',current,{until})).status,200);
    assert.equal((await call('send',current,{now:until+1000000})).result,until,'caller time must not bypass the server cooldown');
    assert.equal((await call('read',current)).result,until,'send 429 also defers reads that already acquired their D1 lease');
    await db.prepare("UPDATE store_coordinator SET fence=7,lease_source='chat',lease_token='held',lease_until=? WHERE store_id='cooldown'").bind(until).run();
    assert.equal((await call('feedback',current,{until:until-1000})).status,200);
    const row=await db.prepare("SELECT blocked_until,fence,lease_source,lease_token,lease_until FROM store_coordinator WHERE store_id='cooldown'").first();
    assert.deepEqual(row,{blocked_until:until,fence:7,lease_source:'chat',lease_token:'held',lease_until:until});
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    assert.equal((await call('send',current)).result,until);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM store_sync_source WHERE store_id='cooldown'").first('n'),0);
  });
  await t.test('wrong object route, another company, absent stores and inactive stores cannot reserve',async()=>{
    assert.equal((await call('send',scope(),{route:'wrong-object'})).status,400);
    assert.equal((await call('send',{orgId:'other',storeId:'budget'})).status,400);
    assert.equal((await call('send',scope('absent'))).status,400);
    for(const status of ['paused','disconnected']) {
      await db.prepare('UPDATE store SET status=? WHERE id=?').bind(status,status).run();
      assert.equal((await call('send',scope(status))).status,400);
    }
    assert.equal((await call('feedback',{orgId:'other',storeId:'budget'},{until:Date.now()+600000})).status,400);
    for(const until of [-1,0.1,8640000000000001,'tomorrow',null])assert.equal((await call('feedback',scope('cooldown'),{until})).status,400);
  });
  await t.test('D1 feedback failure preserves the durable cooldown for later read and send permits',async()=>{
    const current=scope('feedback-failure'),until=Date.now()+60000;
    await db.prepare("CREATE TRIGGER reject_feedback BEFORE INSERT ON store_coordinator WHEN NEW.store_id='feedback-failure' BEGIN SELECT RAISE(ABORT,'TEST_FEEDBACK_FAILURE'); END").run();
    assert.equal((await call('feedback',current,{until})).status,400,'the failed D1 write must not be acknowledged');
    assert.equal(await db.prepare("SELECT count(*) AS n FROM store_coordinator WHERE store_id='feedback-failure'").first('n'),0);
    assert.equal((await call('send',current)).result,until,'D1 remains readable but cannot erase the DO cooldown');
    assert.equal((await call('read',current)).result,until);
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    assert.equal((await call('send',current)).result,until,'the unacknowledged cooldown survives a coordinator restart');
    await db.prepare('DROP TRIGGER reject_feedback').run();
    assert.equal((await call('feedback',current,{until})).status,200);
    assert.equal(await db.prepare("SELECT blocked_until FROM store_coordinator WHERE store_id='feedback-failure'").first('blocked_until'),until);
  });
});
