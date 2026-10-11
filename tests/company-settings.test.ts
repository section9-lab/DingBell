import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../src/application.ts';
import { services } from '../src/modules/identity/services.ts';

async function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(file, folder), 'utf8'));
  let beforeStatement: ((sql: string) => void) | undefined;
  function prepare(sql: string, parameters: SQLInputValue[] = []) {
    const statement = () => { beforeStatement?.(sql); return sqlite.prepare(sql); };
    return {
      bind: (...values: SQLInputValue[]) => prepare(sql, values),
      async all() { return { success: true, results: statement().all(...parameters), meta: {} }; },
      async raw() { const query = statement(); query.setReturnArrays(true); return query.all(...parameters); },
      async first(column?: string) { const row = statement().get(...parameters); return row ? column ? row[column] : row : null; },
      async run() { const result = statement().run(...parameters); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
    };
  }
  const password = 'synthetic-timezone-test-password', hash = await hashPassword(password);
  sqlite.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1),('other','Other','other',1)");
  for (const [id, company, role] of [['owner','company','owner'], ['admin','company','admin'], ['staff','company','member'], ['other','other','owner']]) {
    sqlite.prepare('INSERT INTO user(id,name,email,email_verified) VALUES(?,?,?,1)').run(id,id,`${id}@example.invalid`);
    sqlite.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES(?,?,'credential',?,?,1)").run(id,id,id,hash);
    sqlite.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES(?,?,?,?,1)').run(id,company,id,role);
  }
  const env = { DB: { prepare } as unknown as D1Database, APP_BASE_URL: 'https://settings.example.invalid', BETTER_AUTH_SECRET: 'synthetic-settings-secret-at-least-thirty-two' };
  const app = createApp(), cookies: Record<string,string> = {};
  for (const id of ['owner','admin','staff','other']) {
    const response = await services(env)!.auth.api.signInEmail({ body: { email: `${id}@example.invalid`, password }, asResponse: true });
    assert.equal(response.status,200);
    cookies[id] = response.headers.getSetCookie().map(cookie => cookie.split(';',1)[0]).join('; ');
  }
  const request = (body?: unknown, actor='owner', company='company', origin=env.APP_BASE_URL) => app.request(`${env.APP_BASE_URL}/api/companies/${company}/settings`, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies[actor] ?? '', origin, 'content-type': 'application/json' },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }, env);
  return { sqlite, request, before: (value: typeof beforeStatement) => { beforeStatement=value; }, close:()=>sqlite.close() };
}

test('company settings have an explicit default and authorized versioned updates', async t => {
  const f=await fixture(); t.after(f.close);
  const response=await f.request(); assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{companyId:'company',timeZone:'UTC',version:0,updatedAt:null,canManage:true});
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM company_settings').get()?.n,0,'reads do not create configuration');
  const staff=await f.request(undefined,'staff'); assert.equal(staff.status,200); assert.equal((await staff.json() as {canManage:boolean}).canManage,false);
  for(const actor of ['other','unknown']) assert.equal((await f.request(undefined,actor)).status,actor==='unknown'?401:404);
  assert.equal((await f.request({timeZone:'Asia/Singapore',expectedVersion:0},'staff')).status,403);
  assert.equal((await f.request({timeZone:'Asia/Singapore',expectedVersion:0},'owner','company','https://evil.invalid')).status,403);
  const saved=await f.request({timeZone:'asia/singapore',expectedVersion:0}); assert.equal(saved.status,200);
  const settings=await saved.json() as {timeZone:string;version:number;updatedAt:string};
  assert.equal(settings.timeZone,'Asia/Singapore'); assert.equal(settings.version,1); assert.ok(Number.isFinite(Date.parse(settings.updatedAt)));
  assert.equal((await f.request({timeZone:'Europe/Moscow',expectedVersion:0},'admin')).status,409);
  const updated=await f.request({timeZone:'Europe/Moscow',expectedVersion:1},'admin'); assert.equal(updated.status,200);
  assert.equal((await updated.json() as {version:number}).version,2);
  assert.equal((await (await f.request(undefined,'other','other')).json() as {timeZone:string}).timeZone,'UTC');
  const events=f.sqlite.prepare("SELECT outcome,from_version,to_version,before_time_zone,requested_time_zone FROM company_settings_audit_event WHERE outcome='succeeded' ORDER BY from_version").all();
  assert.deepEqual(events.map(row=>({...row})),[
    {outcome:'succeeded',from_version:0,to_version:1,before_time_zone:'UTC',requested_time_zone:'Asia/Singapore'},
    {outcome:'succeeded',from_version:1,to_version:2,before_time_zone:'Asia/Singapore',requested_time_zone:'Europe/Moscow'},
  ]);
});

test('company settings reject invalid zones and versions without writing', async t => {
  const f=await fixture(); t.after(f.close);
  assert.equal((await f.request()).status,200);
  for(const timeZone of ['','Mars/Olympus','+08:00','UTC+8','Asia/Shanghai\n','a'.repeat(101),null,8]) {
    assert.equal((await f.request({timeZone,expectedVersion:0})).status,400,String(timeZone));
  }
  for(const expectedVersion of [-1,0.5,'0',null,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]) {
    assert.equal((await f.request({timeZone:'UTC',expectedVersion})).status,400,String(expectedVersion));
  }
  assert.equal((await f.request({timeZone:'UTC',expectedVersion:0,companyId:'other'})).status,400);
  assert.equal((await f.request({timeZone:'x'.repeat(17000),expectedVersion:0})).status,413);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM company_settings').get()?.n,0);
});

test('company settings recheck role and session at the final write and fail closed on audit loss', async t => {
  const f=await fixture(); t.after(f.close);
  assert.equal((await f.request()).status,200);
  f.sqlite.exec("CREATE TRIGGER audit_offline BEFORE INSERT ON company_settings_audit_event BEGIN SELECT RAISE(ABORT,'synthetic offline'); END");
  let response=await f.request({timeZone:'Asia/Shanghai',expectedVersion:0}); assert.equal(response.status,503);
  assert.equal((await response.json() as {error:{code:string}}).error.code,'AUDIT_UNAVAILABLE');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM company_settings').get()?.n,0);
  f.sqlite.exec('DROP TRIGGER audit_offline');
  f.before(sql=>{if(/^INSERT INTO company_settings\s*\(/.test(sql)) { f.before(undefined); f.sqlite.exec("UPDATE member SET role='member' WHERE id='admin'"); }});
  response=await f.request({timeZone:'Asia/Shanghai',expectedVersion:0},'admin'); assert.equal(response.status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM company_settings').get()?.n,0);
  assert.equal((await f.request({timeZone:'Asia/Shanghai',expectedVersion:0})).status,200);
  f.before(sql=>{if(/^UPDATE company_settings\s/.test(sql)) { f.before(undefined); f.sqlite.exec("UPDATE session SET expires_at=0 WHERE user_id='owner'"); }});
  assert.equal((await f.request({timeZone:'UTC',expectedVersion:1})).status,404);
  assert.equal(f.sqlite.prepare('SELECT time_zone FROM company_settings').get()?.time_zone,'Asia/Shanghai');
  f.sqlite.exec("UPDATE session SET expires_at=unixepoch()*1000+600000 WHERE user_id='owner'; CREATE TRIGGER audit_result_offline BEFORE INSERT ON company_settings_audit_event WHEN NEW.outcome='succeeded' BEGIN SELECT RAISE(ABORT,'synthetic offline'); END");
  response=await f.request({timeZone:'UTC',expectedVersion:1}); assert.equal(response.status,503);
  assert.equal((await response.json() as {error:{code:string}}).error.code,'OPERATION_UNCONFIRMED');
  assert.equal((await (await f.request()).json() as {version:number}).version,2,'an uncertain outcome is reconciled by reading');
  assert.equal((await f.request({timeZone:'UTC',expectedVersion:1})).status,409,'the old version cannot apply twice');
});

test('a saved setting is not reported as rejected if access disappears before the confirmation read', async t => {
  const f=await fixture(); t.after(f.close);
  assert.equal((await f.request()).status,200);
  let wrote=false;
  f.before(sql=>{
    if (/^INSERT INTO company_settings\s*\(/.test(sql)) wrote=true;
    else if (wrote && /^SELECT org.id AS companyId/.test(sql)) {
      f.before(undefined); f.sqlite.exec("DELETE FROM member WHERE id='admin'");
    }
  });
  const response=await f.request({timeZone:'Europe/Moscow',expectedVersion:0},'admin');
  assert.equal(response.status,503);
  assert.equal((await response.json() as {error:{code:string}}).error.code,'OPERATION_UNCONFIRMED');
  assert.equal(f.sqlite.prepare('SELECT version FROM company_settings').get()?.version,1);
  assert.deepEqual(f.sqlite.prepare('SELECT outcome FROM company_settings_audit_event ORDER BY created_at,rowid').all().map(row=>row.outcome),['started','unknown']);
});
