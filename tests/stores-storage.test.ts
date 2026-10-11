import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { beginStoreCheck, changeStoreGrant, changeStoreState, findStore, finishStoreCheck, insertStore, rotateStoreCredentials } from '../src/modules/stores/storage.ts';
import { unknownCapabilities } from '../src/modules/stores/ozon.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(name, folder), 'utf8'));
  db.exec("INSERT INTO organization (id,name,slug,created_at) VALUES ('a','A','a',1),('b','B','b',1); INSERT INTO user (id,name,email,email_verified) VALUES ('alice','Alice','a@example.invalid',1),('bob','Bob','b@example.invalid',1); INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('ma','a','alice','member',1),('mb','b','bob','member',1)");
  return db;
}

function store(db: DatabaseSync, id = 'sa', org = 'a', account = '123456') {
  db.prepare("INSERT INTO store (id,organization_id,name,platform,platform_store_id,status,created_at,updated_at) VALUES (?,?,?,'ozon',?,'unverified',1,1)").run(id, org, id, account);
}

test('store identity is unique within the tenant while separate companies can use the same platform identifier', () => {
  const db = fixture();
  try {
    store(db);
    assert.throws(() => store(db, 'duplicate'), /UNIQUE/);
    assert.doesNotThrow(() => store(db, 'sb', 'b'));
    assert.throws(() => store(db, 'missing', 'missing'), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('store credentials update as one coherent envelope and revisions are positive', () => {
  const db = fixture();
  try {
    store(db);
    assert.throws(() => db.exec("UPDATE store SET credential_key_version='v1' WHERE id='sa'"), /CHECK/);
    assert.doesNotThrow(() => db.exec("UPDATE store SET credential_key_version='v1',credential_nonce='synthetic-nonce',credential_ciphertext='synthetic-ciphertext' WHERE id='sa'"));
    for (const sql of ["UPDATE store SET revision=0", "UPDATE store SET credential_version=0", "UPDATE store SET status='made-up'", "UPDATE store SET platform='unsupported'", "UPDATE store SET capabilities='invalid json'"]) assert.throws(() => db.exec(sql), /CHECK/);
    assert.doesNotThrow(() => db.exec("UPDATE store SET status='paused',revision=revision+1 WHERE id='sa'"));
  } finally { db.close(); }
});

test('store grants bind same-company membership and do not survive removing and reinviting the same user', () => {
  const db = fixture();
  try {
    store(db); store(db, 'sb', 'b');
    db.exec("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('a','sa','ma',1)");
    assert.throws(() => db.exec("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('a','sa','mb',1)"), /FOREIGN KEY/);
    assert.throws(() => db.exec("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('b','sa','mb',1)"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE store_grant SET member_id='mb' WHERE member_id='ma'"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE store_grant SET store_id='sb' WHERE member_id='ma'"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE member SET organization_id='b' WHERE id='ma'"), /FOREIGN KEY/);
    assert.throws(() => db.exec("UPDATE store SET organization_id='b' WHERE id='sa'"), /FOREIGN KEY|UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('a','sa','ma',1)"), /UNIQUE/);
    db.exec("DELETE FROM member WHERE id='ma'; INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('ma-new','a','alice','member',2)");
    assert.equal(db.prepare('SELECT count(*) AS total FROM store_grant').get()!.total, 0);
  } finally { db.close(); }
});

test('store audit holds no credential material and survives membership removal', () => {
  const db = fixture();
  try {
    store(db);
    db.exec("INSERT INTO store_audit_event (id,request_id,organization_id,store_id,actor_user_id,action,outcome,target_member_id,from_revision,to_revision,created_at) VALUES ('event','request','a','sa','alice','store.grant','succeeded','ma',1,2,1)");
    db.exec("DELETE FROM member WHERE id='ma'");
    assert.equal(db.prepare('SELECT target_member_id FROM store_audit_event').get()!.target_member_id, 'ma');
    assert.deepEqual(db.prepare('PRAGMA table_info(store_audit_event)').all().map(row => row.name), ['id','request_id','organization_id','store_id','actor_user_id','action','outcome','target_member_id','from_revision','to_revision','created_at']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_list(store_audit_event)').all(), []);
  } finally { db.close(); }
});

test('real D1 applies store constraints and preserves a single winner for concurrent revision updates', { timeout: 30_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const folder = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(new URL(name, folder), 'utf8').split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.batch([
    db.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('a','A','a',1),('b','B','b',1)"),
    db.prepare("INSERT INTO user (id,name,email,email_verified) VALUES ('alice','Alice','a@example.invalid',1),('bob','Bob','b@example.invalid',1)"),
    db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('ma','a','alice','member',1),('mb','b','bob','member',1)"),
    db.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,created_at,updated_at) VALUES ('sa','a','A','123456',1,1)"),
  ]);
  await assert.rejects(db.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('a','sa','mb',1)").run(), /FOREIGN KEY/);
  await db.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('a','sa','ma',1)").run();
  await db.prepare("DELETE FROM member WHERE id='ma'").run();
  await db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('new-ma','a','alice','member',2)").run();
  assert.equal(await db.prepare('SELECT count(*) AS total FROM store_grant').first('total'), 0);
  const results = await Promise.all(['paused', 'attention'].map(status =>
    db.prepare('UPDATE store SET status=?,revision=revision+1 WHERE id=? AND revision=? RETURNING revision').bind(status, 'sa', 1).first()));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await db.prepare("SELECT revision FROM store WHERE id='sa'").first('revision'), 2);
  await assert.rejects(db.prepare("UPDATE store SET credential_key_version='v1' WHERE id='sa'").run(), /CHECK/);

  const database = db as unknown as D1Database;
  const envelope = { keyVersion: 'synthetic', nonce: 'synthetic-nonce', ciphertext: 'synthetic-ciphertext' };
  async function managedStore(suffix: string) {
    const orgId = `org-${suffix}`;
    const actorUserId = `actor-${suffix}`;
    const sessionId = `session-${suffix}`;
    const memberId = `member-${suffix}`;
    const id = `store-${suffix}`;
    await db.batch([
      db.prepare('INSERT INTO organization (id,name,slug,created_at) VALUES (?,?,?,1)').bind(orgId, orgId, orgId),
      db.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(actorUserId, actorUserId, `${actorUserId}@example.invalid`),
      db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,'admin',1)").bind(memberId, orgId, actorUserId),
      db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(sessionId, sessionId, actorUserId, Date.now() + 60_000),
    ]);
    const actor = { orgId, actorUserId, sessionId };
    assert.ok(await insertStore(database, actor, { id, name: id, clientId: '123456' }, envelope));
    return { id, actor, memberId };
  }

  for (const race of ['rotate', 'pause', 'disconnect', 'actor-demoted', 'session-revoked', 'email-unverified', 'lease-expired', 'new-check-token', 'credential-version'] as const) {
    await context.test(`late check cannot commit after ${race}`, async () => {
      const { id, actor, memberId } = await managedStore(race);
      const token = `check-${race}`;
      assert.ok(await beginStoreCheck(database, actor, id, 1, token));
      assert.equal(await beginStoreCheck(database, actor, id, 1, 'concurrent-check'), null);
      if (race === 'rotate') assert.ok(await rotateStoreCredentials(database, actor, id, 1, { ...envelope, ciphertext: 'new-synthetic-ciphertext' }));
      if (race === 'pause' || race === 'disconnect') assert.ok(await changeStoreState(database, actor, id, 1, race === 'pause' ? 'paused' : 'disconnected'));
      if (race === 'actor-demoted') await db.prepare("UPDATE member SET role='member' WHERE id=?").bind(memberId).run();
      if (race === 'session-revoked') await db.prepare('DELETE FROM session WHERE id=?').bind(actor.sessionId).run();
      if (race === 'email-unverified') await db.prepare('UPDATE user SET email_verified=0 WHERE id=?').bind(actor.actorUserId).run();
      if (race === 'lease-expired') await db.prepare('UPDATE store SET check_until=1 WHERE id=?').bind(id).run();
      if (race === 'new-check-token') {
        await db.prepare('UPDATE store SET check_until=1,next_check_at=1 WHERE id=?').bind(id).run();
        assert.ok(await beginStoreCheck(database, actor, id, 1, 'replacement-token'));
      }
      if (race === 'credential-version') await db.prepare('UPDATE store SET credential_version=credential_version+1 WHERE id=?').bind(id).run();
      assert.equal(await finishStoreCheck(database, actor, { id, revision: 1, credentialVersion: 1, token }, unknownCapabilities()), null);
      assert.equal(await db.prepare('SELECT capabilities FROM store WHERE id=?').bind(id).first('capabilities'), null);
      if (race === 'new-check-token') {
        assert.equal(await db.prepare('SELECT check_token FROM store WHERE id=?').bind(id).first('check_token'), 'replacement-token');
        assert.ok(await finishStoreCheck(database, actor, { id, revision: 1, credentialVersion: 1, token: 'replacement-token' }, unknownCapabilities()));
        assert.equal(await finishStoreCheck(database, actor, { id, revision: 1, credentialVersion: 1, token: 'replacement-token' }, unknownCapabilities()), null);
      }
    });
  }

  await context.test('grant CAS uses live manager and target roles and live sessions', async () => {
    const { id, actor, memberId } = await managedStore('grants');
    const target = 'grant-target';
    await db.batch([
      db.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(target, target, `${target}@example.invalid`),
      db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,'member',1)").bind(target, actor.orgId, target),
      db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind('target-session', 'target-session', target, Date.now() + 60_000),
    ]);
    const targetActor = { orgId: actor.orgId, actorUserId: target, sessionId: 'target-session' };
    const input = { storeId: id, memberId: target, expectedGranted: false, granted: true };
    assert.equal(await findStore(database, targetActor, id), null);
    await db.prepare("UPDATE member SET role='admin' WHERE id=?").bind(target).run();
    assert.equal(await changeStoreGrant(database, actor, input), null);
    await db.prepare("UPDATE member SET role='member' WHERE id=?").bind(target).run();
    await db.prepare("UPDATE member SET role='member' WHERE id=?").bind(memberId).run();
    assert.equal(await changeStoreGrant(database, actor, input), null);
    await db.prepare("UPDATE member SET role='admin' WHERE id=?").bind(memberId).run();
    const grants = await Promise.all([changeStoreGrant(database, actor, input), changeStoreGrant(database, actor, input)]);
    assert.equal(grants.filter(Boolean).length, 1);
    assert.ok(await findStore(database, targetActor, id));
    assert.equal(await findStore(database, targetActor, id, true), null);
    assert.equal(await changeStoreState(database, targetActor, id, 1, 'paused'), null);
    const revoke = { ...input, expectedGranted: true, granted: false };
    await db.prepare('UPDATE session SET expires_at=1 WHERE id=?').bind(actor.sessionId).run();
    assert.equal(await changeStoreGrant(database, actor, revoke), null);
    assert.ok(await findStore(database, targetActor, id));
    await db.prepare('UPDATE session SET expires_at=? WHERE id=?').bind(Date.now() + 60_000, actor.sessionId).run();
    assert.ok(await changeStoreGrant(database, actor, revoke));
    assert.equal(await findStore(database, targetActor, id), null);
    assert.equal(await db.prepare('SELECT revision FROM store WHERE id=?').bind(id).first('revision'), 1);
  });
});
