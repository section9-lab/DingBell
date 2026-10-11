import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../src/application.ts';
import { services } from '../src/modules/identity/services.ts';

const automatic = (name='售前接待', storeIds=['store-a']) => ({ kind:'automatic', name, storeIds, priority:50,
  stages:['presale'], mode:'suggest', language:'customer', tone:'concise', instructions:'先回答消费者的问题。' });
const notification = () => ({ kind:'notification', name:'发货通知', storeIds:['store-a'], priority:50,
  event:'dispatched', delayMinutes:0, expiresAfterMinutes:1440, quietHours:{start:'22:00',end:'08:00'},
  maxPerDay:1, content:'您的订单 {{order_number}} 已发货。' });
type Detail = {companyId:string;policy:{id:string;version:number;draftRevision:number;testedRevision:number|null;
  draftBaseRevision:number|null;draft:ReturnType<typeof automatic>;draftRollbackOf:number|null;enabled:boolean;
  published:null|{revision:number;config:ReturnType<typeof automatic>;rollbackOf:number|null;timeZone:string}};
  history:{versions:{revision:number}[];nextBefore:number|null}};

async function fixture() {
  const sqlite=new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  const folder=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(folder).filter(file=>file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file,folder),'utf8'));
  let beforeStatement:((sql:string)=>void)|undefined;
  function prepare(sql:string,parameters:SQLInputValue[]=[]) {
    const statement=()=>{beforeStatement?.(sql);return sqlite.prepare(sql);};
    return {bind:(...values:SQLInputValue[])=>prepare(sql,values),
      async all(){return {success:true,results:statement().all(...parameters),meta:{}};},
      async raw(){const query=statement();query.setReturnArrays(true);return query.all(...parameters);},
      async first(column?:string){const row=statement().get(...parameters);return row?column?row[column]:row:null;},
      async run(){const result=statement().run(...parameters);return {success:true,results:[],meta:{changes:Number(result.changes)}};}};
  }
  const password='synthetic-policy-test-password', hash=await hashPassword(password);
  sqlite.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1),('other','Other','other',1)");
  for(const [id,company,role] of [['owner','company','owner'],['admin','company','admin'],['staff','company','member'],['other','other','owner']]) {
    sqlite.prepare('INSERT INTO user(id,name,email,email_verified) VALUES(?,?,?,1)').run(id,id,`${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES(?,?,'credential',?,?,1)").run(id,id,id,hash);
    sqlite.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES(?,?,?,?,1)').run(id,company,id,role);
  }
  for(const [id,company] of [['store-a','company'],['store-b','company'],['store-other','other']])
    sqlite.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES(?,?,?,?,1,1)").run(id,company,id,id);
  const env={DB:{prepare} as unknown as D1Database,APP_BASE_URL:'https://policy.example.invalid',BETTER_AUTH_SECRET:'synthetic-policy-secret-at-least-thirty-two'};
  const app=createApp(),cookies:Record<string,string>={};
  for(const id of ['owner','admin','staff','other']) {
    const response=await services(env)!.auth.api.signInEmail({body:{email:`${id}@example.invalid`,password},asResponse:true});
    assert.equal(response.status,200);cookies[id]=response.headers.getSetCookie().map(cookie=>cookie.split(';',1)[0]).join('; ');
  }
  const request=(suffix='',body?:unknown,actor='owner',company='company',origin=env.APP_BASE_URL)=>app.request(`${env.APP_BASE_URL}/api/companies/${company}/reply-policies${suffix}`,{
    method:body===undefined?'GET':'POST',headers:{cookie:cookies[actor]??'',origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),
  },env);
  const create=async(config:unknown=automatic())=>{const id=crypto.randomUUID(),r=await request('',{id,config});assert.equal(r.status,200,await r.clone().text());return await r.json() as Detail;};
  const action=async(detail:Detail,name:string,extra={})=>{const r=await request(`/${detail.policy.id}/${name}`,{expectedVersion:detail.policy.version,...extra});assert.equal(r.status,200,await r.clone().text());return await r.json() as Detail;};
  const publish=async(detail:Detail)=>action(await action(detail,'test'),'publish');
  return {sqlite,request,create,action,publish,before:(value:typeof beforeStatement)=>{beforeStatement=value;},close:()=>sqlite.close()};
}

test('reply policies isolate companies and restrict configuration to owners and administrators',async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.request()).status,200);
  assert.equal((await f.request('?',undefined,'unknown')).status,401);
  assert.equal((await f.request('',undefined,'other')).status,404);
  assert.equal((await f.request('',undefined,'staff')).status,403);
  const detail=await f.create();
  assert.equal((await f.request(`/${detail.policy.id}`,undefined,'other','other')).status,404);
  for(const action of ['draft','test','publish','pause','restore']) {
    assert.equal((await f.request(`/${detail.policy.id}/${action}`,{expectedVersion:1,config:automatic(),revision:1},'staff')).status,403);
  }
  assert.equal((await f.request('',{id:crypto.randomUUID(),config:automatic()},'owner','company','https://evil.invalid')).status,403);
  assert.equal((await f.request('',{id:crypto.randomUUID(),config:automatic('跨公司',['store-other'])})).status,400);
  assert.equal((await f.request(`/${detail.policy.id}`)).headers.get('cache-control'),'no-store');
});

test('drafts and checks do not publish; publications are immutable and restoration creates a reviewed new version',async t=>{
  const f=await fixture();t.after(f.close);
  let detail=await f.create();const id=detail.policy.id;
  assert.equal(detail.policy.enabled,false);assert.equal(detail.policy.published,null);assert.equal(detail.policy.draftRevision,1);
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:1})).status,409);
  detail=await f.action(detail,'test');assert.equal(detail.policy.testedRevision,1);assert.equal(detail.policy.published,null);
  detail=await f.action(detail,'publish');assert.equal(detail.policy.published?.revision,1);assert.equal(detail.policy.enabled,true);
  assert.equal(detail.policy.published?.timeZone,'UTC');
  detail=await f.action(detail,'draft',{config:automatic('修改中的草稿')});
  assert.equal(detail.policy.published?.config.name,'售前接待');assert.equal(detail.policy.draft.name,'修改中的草稿');assert.equal(detail.policy.testedRevision,null);
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version})).status,409);
  detail=await f.publish(detail);assert.equal(detail.policy.published?.revision,2);assert.equal(detail.policy.published?.config.name,'修改中的草稿');
  detail=await f.action(detail,'pause');assert.equal(detail.policy.enabled,false);assert.equal(detail.policy.published?.revision,2);
  detail=await f.action(detail,'restore',{revision:1});assert.equal(detail.policy.draft.name,'售前接待');assert.equal(detail.policy.published?.revision,2);
  assert.equal(detail.policy.enabled,false);assert.equal(detail.policy.draftRollbackOf,1);
  detail=await f.publish(detail);assert.equal(detail.policy.published?.revision,3);assert.equal(detail.policy.published?.rollbackOf,1);
  assert.deepEqual(detail.history.versions.map(row=>row.revision),[3,2,1]);
  assert.throws(()=>f.sqlite.exec("UPDATE policy_version SET config='{}'"),/immutable/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM policy_version'),/immutable/);
  assert.throws(()=>f.sqlite.exec('INSERT OR REPLACE INTO policy_version SELECT * FROM policy_version'),/immutable/);
  const events=f.sqlite.prepare("SELECT action,outcome FROM reply_policy_audit_event WHERE policy_id=? ORDER BY rowid").all(id);
  assert.ok(events.some(row=>row.action==='publish'&&row.outcome==='rejected'));
  assert.equal(events.filter(row=>row.action==='publish'&&row.outcome==='succeeded').length,3);
});

test('automatic overlap is checked against published scope; notifications have independent versions',async t=>{
  const f=await fixture();t.after(f.close);
  let first=await f.publish(await f.create());
  const other=await f.create(automatic('相同范围'));
  assert.equal((await f.request(`/${other.policy.id}/test`,{expectedVersion:other.policy.version})).status,409);
  let independent=await f.create({...automatic('另一阶段'),stages:['aftersale']});independent=await f.publish(independent);
  const high=await f.publish(await f.create({...automatic('更高优先级'),priority:60}));assert.equal(high.policy.enabled,true);
  const notify=await f.publish(await f.create(notification()));assert.equal(notify.policy.published?.revision,1);
  first=await f.action(first,'draft',{config:automatic('未发布范围',['store-b'])});
  assert.equal((await f.request(`/${other.policy.id}/test`,{expectedVersion:other.policy.version})).status,409,'an unpublished scope cannot remove an active conflict');
  first=await f.action(first,'pause');await f.publish(other);
  assert.equal((await (await f.request(`/${notify.policy.id}`)).json() as Detail).policy.enabled,true);
});

test('stale editors and a competing publication cannot overwrite the reviewed draft',async t=>{
  const f=await fixture();t.after(f.close);
  let a=await f.create(),b=await f.create(automatic('竞争规则'));
  a=await f.action(a,'test');b=await f.action(b,'test');
  const stale=a;
  a=await f.action(a,'draft',{config:automatic('新草稿')});
  for(const action of ['test','publish','pause','restore','draft'])
    assert.equal((await f.request(`/${a.policy.id}/${action}`,{expectedVersion:stale.policy.version,...(action==='draft'?{config:automatic()}:action==='restore'?{revision:1}:{})},'admin')).status,409);
  await f.action(b,'publish');
  assert.equal((await f.request(`/${a.policy.id}/test`,{expectedVersion:a.policy.version})).status,409);
  const c=await f.action(await f.create({...automatic('另一店',['store-b']),priority:10}),'test');
  await f.publish(await f.create({...automatic('抢先发布',['store-b']),priority:10}));
  assert.equal((await f.request(`/${c.policy.id}/publish`,{expectedVersion:c.policy.version})).status,409,'publish rechecks a formerly passing test');
});

test('invalid conditions and template variables are rejected without creating policies',async t=>{
  const f=await fixture();t.after(f.close);
  assert.equal((await f.request()).status,200);
  for(const config of [
    {...automatic(),storeIds:[]},{...automatic(),storeIds:['store-a','store-a']},{...automatic(),stages:[]},
    {...automatic(),priority:1.5},{...automatic(),instructions:'x'.repeat(2001)},{...automatic(),runCode:'danger'},
    {...notification(),content:'{{unknown}}'},{...notification(),content:'{{ order_number'},
    {...notification(),quietHours:{start:'25:00',end:'08:00'}},{...notification(),quietHours:{start:'08:00',end:'08:00'}},
    {...notification(),delayMinutes:1440},{...notification(),maxPerDay:0},
  ]) assert.equal((await f.request('',{id:crypto.randomUUID(),config})).status,400);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM reply_policy').get()?.n,0);
  const detail=await f.create();
  for(const expectedVersion of [-1,0,0.5,'1',null,Number.MAX_SAFE_INTEGER])
    assert.equal((await f.request(`/${detail.policy.id}/test`,{expectedVersion})).status,400);
  assert.equal((await f.request(`/${detail.policy.id}/draft`,{expectedVersion:1,config:notification()})).status,400,'kind is immutable');
});

test('writes recheck authorization; audit or snapshot failure cannot leave a partial publication',async t=>{
  const f=await fixture();t.after(f.close);
  let detail=await f.create();detail=await f.action(detail,'test');const id=detail.policy.id;
  f.sqlite.exec("CREATE TRIGGER audit_offline BEFORE INSERT ON reply_policy_audit_event BEGIN SELECT RAISE(ABORT,'synthetic offline'); END");
  let r=await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version});assert.equal(r.status,503);
  assert.equal((await r.json() as {error:{code:string}}).error.code,'AUDIT_UNAVAILABLE');
  f.sqlite.exec('DROP TRIGGER audit_offline');
  f.sqlite.exec("CREATE TRIGGER snapshot_offline BEFORE INSERT ON policy_version BEGIN SELECT RAISE(ABORT,'synthetic offline'); END");
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version})).status,503);
  assert.equal(f.sqlite.prepare('SELECT published_revision FROM reply_policy WHERE id=?').get(id)?.published_revision,null);
  f.sqlite.exec('DROP TRIGGER snapshot_offline');
  f.before(sql=>{if(/^UPDATE reply_policy\s/.test(sql)){f.before(undefined);f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'");}});
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version},'admin')).status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM policy_version').get()?.n,0);
  f.sqlite.exec("CREATE TRIGGER outcome_offline BEFORE INSERT ON reply_policy_audit_event WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic offline'); END");
  r=await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version});assert.equal(r.status,503);
  assert.equal((await r.json() as {error:{code:string}}).error.code,'OPERATION_UNCONFIRMED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM policy_version').get()?.n,1);
  f.sqlite.exec('DROP TRIGGER outcome_offline');
  assert.equal((await f.request(`/${id}/publish`,{expectedVersion:detail.policy.version})).status,409,'an uncertain result is not blindly resent');
});

test('publication rejects a timezone changed after the rule check',async t=>{
  const f=await fixture();t.after(f.close);
  let detail=await f.action(await f.create(notification()),'test');
  f.sqlite.exec("INSERT INTO company_settings(organization_id,time_zone,version,updated_at) VALUES('company','Asia/Singapore',1,1)");
  const response=await f.request(`/${detail.policy.id}/publish`,{expectedVersion:detail.policy.version});
  assert.equal(response.status,409,'publishing must not silently change the reviewed quiet-hours timezone');
  assert.equal((await response.json() as {error:{code:string}}).error.code,'POLICY_TEST_REQUIRED');
  detail=await f.publish(detail);assert.equal(detail.policy.published?.timeZone,'Asia/Singapore');
});

test('publication and draft save recheck store and overlap constraints at the committing statement',async t=>{
  const f=await fixture();t.after(f.close);
  const first=await f.action(await f.create(),'test'),other=await f.action(await f.create(automatic('并发发布')),'test');
  f.before(sql=>{if(/^UPDATE reply_policy\s/.test(sql)){
    f.before(undefined);f.sqlite.prepare(`UPDATE reply_policy SET published_revision=1,enabled=1,version=version+1,
      published_by='owner',published_at=1,published_request_id='other-request',published_time_zone='UTC',draft_base_revision=1 WHERE id=?`).run(other.policy.id);
  }});
  assert.equal((await f.request(`/${first.policy.id}/publish`,{expectedVersion:first.policy.version})).status,409);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM policy_version').get()?.n,1);
  f.before(sql=>{if(/^UPDATE reply_policy\s/.test(sql)){f.before(undefined);f.sqlite.exec("DELETE FROM store WHERE id='store-b'");}});
  assert.equal((await f.request(`/${first.policy.id}/draft`,{expectedVersion:first.policy.version,config:automatic('消失的店铺',['store-b'])})).status,409);
  assert.equal((await (await f.request(`/${first.policy.id}`)).json() as Detail).policy.version,first.policy.version);
});

test('policy and history pagination are bounded and never include another company',async t=>{
  const f=await fixture();t.after(f.close);
  let detail=await f.create();
  for(let i=0;i<12;i++)detail=await f.publish(detail);
  assert.equal(detail.history.versions.length,10);assert.equal(detail.history.nextBefore,3);
  const response=await f.request(`/${detail.policy.id}/versions?before=3`);
  assert.deepEqual((await response.json() as {versions:{revision:number}[]}).versions.map(value=>value.revision),[2,1]);
  assert.equal((await f.request(`/${detail.policy.id}/versions?before=3`,undefined,'other','other')).status,404);
  for(const query of ['before=0','before=1&before=2','before=2&unused=1'])assert.equal((await f.request(`/${detail.policy.id}/versions?${query}`)).status,400);
  for(let i=0;i<21;i++)await f.create(notification());
  const first=await (await f.request('?kind=notification')).json() as {policies:{id:string}[];nextAfter:string};
  assert.equal(first.policies.length,20);assert.equal(first.nextAfter,first.policies.at(-1)?.id);
  const second=await (await f.request(`?kind=notification&after=${first.nextAfter}`)).json() as {policies:{id:string}[];nextAfter:null};
  assert.equal(second.policies.length,1);assert.equal(second.nextAfter,null);
  assert.ok(second.policies[0].id>first.nextAfter);
});
