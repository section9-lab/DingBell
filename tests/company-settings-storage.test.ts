import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { readCompanySettings, saveCompanyTimeZone } from '../src/modules/company-settings/storage.ts';

test('real D1 settings use a single CAS winner, retain audit history and never create rows on read', { timeout: 60_000 }, async t => {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  t.after(()=>mf.dispose()); const db=await mf.getD1Database('DB') as unknown as D1Database;
  const folder=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) for(const statement of readFileSync(new URL(name,folder),'utf8').split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1)").run();
  await db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('user','User','user@example.invalid',1)").run();
  await db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member','company','user','admin',1)").run();
  await db.prepare("INSERT INTO session(id,user_id,token,expires_at,updated_at) VALUES('session','user','synthetic-settings-session',unixepoch()*1000+600000,1)").run();
  const actor={orgId:'company',actorUserId:'user',sessionId:'session'};
  assert.equal((await readCompanySettings(db,actor))?.timeZone,'UTC');
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM company_settings').first('n'),0);
  for(const expected of [0,1]) {
    const results=await Promise.all(['Asia/Singapore','America/New_York'].map(zone=>saveCompanyTimeZone(db,actor,zone,expected)));
    assert.equal(results.filter(Boolean).length,1); assert.equal((await readCompanySettings(db,actor))?.version,expected+1);
  }
  await db.prepare("UPDATE member SET role='member' WHERE id='member'").run();
  assert.equal(await saveCompanyTimeZone(db,actor,'UTC',2),null);
  await assert.rejects(db.prepare('UPDATE company_settings SET version=0').run(),/CHECK/);
  await assert.rejects(db.prepare('UPDATE company_settings SET version=1.5').run(),/CHECK/);
  await db.prepare('UPDATE company_settings SET version=9007199254740991').run();
  await db.prepare("UPDATE member SET role='admin' WHERE id='member'").run();
  assert.equal(await saveCompanyTimeZone(db,actor,'UTC',Number.MAX_SAFE_INTEGER),null);
  await db.prepare("UPDATE user SET email_verified=0 WHERE id='user'").run();
  assert.equal(await readCompanySettings(db,actor),null);
  await db.prepare("INSERT INTO company_settings_audit_event(id,request_id,organization_id,actor_user_id,outcome,from_version,to_version,before_time_zone,requested_time_zone,created_at) VALUES('audit','request','company','user','succeeded',0,1,'UTC','Asia/Singapore',1)").run();
  await db.prepare("DELETE FROM organization WHERE id='company'").run();
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM company_settings').first('n'),0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM company_settings_audit_event').first('n'),1);
});
