import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { changeMember, type MemberChange } from '../src/modules/membership/storage.ts';

function database(secondOwner = false) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, folder), 'utf8'));
  db.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
    ('alice','Alice','alice@example.invalid',1,1,1),
    ('bob','Bob','bob@example.invalid',1,1,1),
    ('staff','Staff','staff@example.invalid',1,1,1);
    INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other','Other','other',1);
    INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES
    ('alice-owner','company','alice','owner',1),
    ('staff-member','company','staff','member',1),
    ('other-owner','other','bob','owner',1);`);
  if (secondOwner) db.exec("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('bob-owner','company','bob','owner',1)");
  return db;
}

function ownerCount(db: DatabaseSync) {
  return Number(db.prepare("SELECT count(*) AS count FROM member WHERE organization_id='company' AND instr(',' || replace(role, ' ', '') || ',', ',owner,') > 0").get()!.count);
}

test('the final owner cannot be deleted even when another company has an owner', () => {
  const db = database();
  try {
    assert.throws(() => db.exec("DELETE FROM member WHERE id='alice-owner'"), /last_owner_required/);
    assert.equal(ownerCount(db), 1);
    assert.equal(db.prepare("SELECT user_id FROM member WHERE id='alice-owner'").get()!.user_id, 'alice');
  } finally { db.close(); }
});

test('the final owner cannot be demoted to admin or member', () => {
  for (const role of ['admin', 'member']) {
    const db = database();
    try {
      assert.throws(() => db.prepare("UPDATE member SET role=? WHERE id='alice-owner'").run(role), /last_owner_required/);
      assert.equal(ownerCount(db), 1);
    } finally { db.close(); }
  }
});

test('owner guards recognize comma-separated roles but not owner-like names', () => {
  const db = database();
  try {
    db.exec("UPDATE member SET role='admin, owner' WHERE id='alice-owner'; UPDATE member SET role='coowner' WHERE id='staff-member'");
    assert.throws(() => db.exec("DELETE FROM member WHERE id='alice-owner'"), /last_owner_required/);
    assert.throws(() => db.exec("UPDATE member SET role='admin' WHERE id='alice-owner'"), /last_owner_required/);
    assert.doesNotThrow(() => db.exec("UPDATE member SET role='owner,member' WHERE id='alice-owner'"));
    assert.equal(ownerCount(db), 1);
  } finally { db.close(); }
});

test('the last owner cannot evade the guard by moving company or replacing its user', () => {
  const db = database();
  try {
    assert.throws(() => db.exec("UPDATE member SET organization_id='other' WHERE id='alice-owner'"), /last_owner_required/);
    assert.throws(() => db.exec("UPDATE member SET user_id='bob' WHERE id='alice-owner'"), /last_owner_required/);
    assert.equal(ownerCount(db), 1);
    assert.equal(db.prepare("SELECT user_id FROM member WHERE id='alice-owner'").get()!.user_id, 'alice');
  } finally { db.close(); }
});

test('two removals that both passed stale two-owner prechecks cannot delete both owners', () => {
  const db = database(true);
  try {
    // Both requests pass their application precheck before either writes.
    assert.equal(ownerCount(db), 2);
    assert.equal(ownerCount(db), 2);
    db.exec("DELETE FROM member WHERE id='bob-owner'");
    assert.throws(() => db.exec("DELETE FROM member WHERE id='alice-owner'"), /last_owner_required/);
    assert.equal(ownerCount(db), 1);
  } finally { db.close(); }
});

test('two demotions that both passed stale two-owner prechecks preserve one owner', () => {
  const db = database(true);
  try {
    assert.equal(ownerCount(db), 2);
    assert.equal(ownerCount(db), 2);
    db.exec("UPDATE member SET role='admin' WHERE id='bob-owner'");
    assert.throws(() => db.exec("UPDATE member SET role='member' WHERE id='alice-owner'"), /last_owner_required/);
    assert.equal(ownerCount(db), 1);
  } finally { db.close(); }
});

test('an owner may demote themselves when another owner remains', () => {
  const db = database(true);
  try {
    assert.doesNotThrow(() => db.exec("UPDATE member SET role='member' WHERE id='alice-owner'"));
    assert.equal(ownerCount(db), 1);
    assert.equal(db.prepare("SELECT role FROM member WHERE id='alice-owner'").get()!.role, 'member');
    assert.doesNotThrow(() => db.exec("UPDATE member SET role='owner' WHERE id='bob-owner'"));
  } finally { db.close(); }
});

test('removing an ordinary member preserves the completed invitation receipt', () => {
  const db = database();
  try {
    db.exec("INSERT INTO invitation_flow (invitation_id,organization_id,member_id,accepting_user_id,completed_at,created_at) VALUES ('completed-invite','company','staff-member','staff',1,1)");
    assert.doesNotThrow(() => db.exec("DELETE FROM member WHERE id='staff-member'"));
    assert.equal(db.prepare("SELECT completed_at FROM invitation_flow WHERE invitation_id='completed-invite'").get()!.completed_at, 1);
    assert.equal(ownerCount(db), 1);
  } finally { db.close(); }
});

test('membership audit fields are nullable for existing events and record the actual role change', () => {
  const db = database();
  try {
    db.exec("INSERT INTO identity_audit_event (id,request_id,action,outcome,created_at) VALUES ('old','old-request','auth.sign_in','succeeded',1)");
    const old = db.prepare('SELECT target_member_id,before_role,after_role FROM identity_audit_event WHERE id=?').get('old');
    assert.deepEqual({ ...old }, { target_member_id: null, before_role: null, after_role: null });
    db.exec("INSERT INTO identity_audit_event (id,request_id,action,outcome,created_at,target_member_id,before_role,after_role) VALUES ('change','change-request','member.role_change','succeeded',1,'staff-member','member','admin')");
    const event = db.prepare('SELECT target_member_id,before_role,after_role FROM identity_audit_event WHERE id=?').get('change');
    assert.deepEqual({ ...event }, { target_member_id: 'staff-member', before_role: 'member', after_role: 'admin' });
  } finally { db.close(); }
});

test('real D1 enforces owner and authorization guards at the final member write', { timeout: 30_000 }, async context => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  context.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(new URL(file, folder), 'utf8').split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const action of ['delete', 'demote']) {
    await context.test(action, async () => {
      await db.prepare('INSERT INTO organization (id,name,slug,created_at) VALUES (?,?,?,1)').bind(action, action, action).run();
      for (const name of ['alice', 'bob']) {
        const id = `${action}-${name}`;
        await db.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(id, name, `${id}@example.invalid`).run();
        await db.prepare("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,'owner',1)").bind(id, action, id).run();
      }
      const sql = action === 'delete' ? 'DELETE FROM member WHERE id=?' : "UPDATE member SET role='member' WHERE id=?";
      const results = await Promise.allSettled(['alice', 'bob'].map(name => db.prepare(sql).bind(`${action}-${name}`).run()));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter(result => result.status === 'rejected').length, 1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(rejected.reason), /last_owner_required/);
      assert.equal(await db.prepare("SELECT count(*) AS total FROM member WHERE organization_id=? AND role='owner'").bind(action).first('total'), 1);
    });
  }
  for (const action of ['remove', 'role'] as const) {
    for (const race of ['valid', 'actor-demoted', 'target-promoted', 'session-revoked', 'session-expired', 'email-unverified', 'expected-role-stale'] as const) {
      await context.test(`${action}: ${race}`, async () => {
        const company = `${action}-${race}`;
        await db.prepare('INSERT INTO organization (id,name,slug,created_at) VALUES (?,?,?,1)').bind(company, company, company).run();
        for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['target', 'member']]) {
          const id = `${company}-${name}`;
          await db.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(id, name, `${id}@example.invalid`).run();
          await db.prepare('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').bind(id, company, id, role).run();
        }
        const actor = `${company}-admin`;
        const target = `${company}-target`;
        const session = `${actor}-session`;
        await db.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,1,1)').bind(session, session, actor, Date.now() + 60_000).run();
        const input: MemberChange = { organizationId: company, memberId: target, actorUserId: actor, sessionId: session, expectedRole: 'member', role: action === 'remove' ? null : 'admin' };
        // The request has already read an admin actor and a member target.
        // Change the database before the single statement that grants access.
        if (race === 'actor-demoted') await db.prepare("UPDATE member SET role='member' WHERE id=?").bind(actor).run();
        if (race === 'target-promoted') await db.prepare("UPDATE member SET role='owner' WHERE id=?").bind(target).run();
        if (race === 'session-revoked') await db.prepare('DELETE FROM session WHERE id=?').bind(session).run();
        if (race === 'session-expired') await db.prepare('UPDATE session SET expires_at=1 WHERE id=?').bind(session).run();
        if (race === 'email-unverified') await db.prepare('UPDATE user SET email_verified=0 WHERE id=?').bind(actor).run();
        if (race === 'expected-role-stale') await db.prepare("UPDATE member SET role='admin' WHERE id=?").bind(target).run();
        const changed = await changeMember(db as unknown as D1Database, input);
        if (race === 'valid') {
          assert.deepEqual(changed, { memberId: target, role: input.role });
          assert.equal(await db.prepare('SELECT role FROM member WHERE id=?').bind(target).first('role'), input.role);
        } else {
          assert.equal(changed, null);
          const expected = race === 'target-promoted' ? 'owner' : race === 'expected-role-stale' ? 'admin' : 'member';
          assert.equal(await db.prepare('SELECT role FROM member WHERE id=?').bind(target).first('role'), expected);
          if (race === 'target-promoted') {
            assert.equal(await changeMember(db as unknown as D1Database, { ...input, expectedRole: 'owner' }), null, 'admin cannot operate on an owner even with a current expected role');
          }
        }
      });
    }
  }
});
