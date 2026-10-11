import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { URL } from 'node:url';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const folder = new URL('../migrations/', import.meta.url);
  for (const file of readdirSync(folder).filter(file => file.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, folder), 'utf8'));
  db.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES
    ('recipient','Recipient','recipient@example.invalid',1,1,1),('other','Other','other@example.invalid',1,1,1);
    INSERT INTO organization (id,name,slug,created_at) VALUES ('org','Company','company',1);
    INSERT INTO invitation (id,organization_id,email,role,status,expires_at,created_at,inviter_id)
    VALUES ('invite','org','recipient@example.invalid','member','pending',4102444800000,1,'other');`);
  return db;
}

function claim(db: DatabaseSync) {
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invitation_flow'").get(), 'invitation acceptance requires a durable completion record');
  db.exec("INSERT INTO invitation_flow (invitation_id,organization_id,member_id,accepting_user_id,created_at) VALUES ('invite','org','fixed-member','recipient',1)");
}

const insertMember = "INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('fixed-member','org','recipient','member',1)";

test('the database prevents concurrent duplicate organization memberships and pending invitations', () => {
  const db = database();
  try {
    db.exec("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('first','org','recipient','member',1)");
    assert.throws(() => db.exec("INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('second','org','recipient','admin',1)"), /UNIQUE/);
    assert.throws(() => db.exec("INSERT INTO invitation (id,organization_id,email,role,status,expires_at,created_at,inviter_id) VALUES ('duplicate','org','recipient@example.invalid','admin','pending',4102444800000,1,'other')"), /UNIQUE/);
    db.exec("UPDATE invitation SET status='expired' WHERE id='invite'");
    assert.doesNotThrow(() => db.exec("INSERT INTO invitation (id,organization_id,email,role,status,expires_at,created_at,inviter_id) VALUES ('replacement','org','recipient@example.invalid','member','pending',4102444800000,1,'other')"));
  } finally { db.close(); }
});

test('member creation records completion atomically so an old invitation cannot restore a removed member', () => {
  const db = database();
  try {
    claim(db);
    db.exec("UPDATE invitation SET status='accepted' WHERE id='invite'");
    db.exec(insertMember);
    assert.notEqual(db.prepare("SELECT completed_at FROM invitation_flow WHERE invitation_id='invite'").get()!.completed_at, null);
    assert.throws(() => db.exec("UPDATE invitation SET status='pending' WHERE id='invite'"), /invitation_already_completed/);
    assert.throws(() => db.exec("UPDATE invitation SET status='canceled' WHERE id='invite'"), /invitation_already_completed/);
    db.exec("DELETE FROM member WHERE id='fixed-member'");
    assert.throws(() => db.exec(insertMember), /invitation_membership_not_authorized/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM member').get()!.count, 0);
  } finally { db.close(); }
});

test('accepted-before-member interruption remains recoverable without resetting the invitation', () => {
  const db = database();
  try {
    claim(db);
    db.exec("UPDATE invitation SET status='accepted' WHERE id='invite'");
    assert.equal(db.prepare("SELECT completed_at FROM invitation_flow WHERE invitation_id='invite'").get()!.completed_at, null);
    assert.doesNotThrow(() => db.exec(insertMember));
    assert.equal(db.prepare('SELECT count(*) AS count FROM member').get()!.count, 1);
  } finally { db.close(); }
});

test('the final member write rejects cancellation, expiry, wrong recipient, role escalation and unverified email', () => {
  for (const change of [
    "UPDATE invitation SET status='canceled' WHERE id='invite'",
    "UPDATE invitation SET expires_at=1 WHERE id='invite'",
    "UPDATE invitation SET email='other@example.invalid' WHERE id='invite'",
    "UPDATE invitation SET role='admin' WHERE id='invite'",
    "UPDATE user SET email_verified=0 WHERE id='recipient'",
  ]) {
    const db = database();
    try {
      claim(db);
      db.exec("UPDATE invitation SET status='accepted' WHERE id='invite'");
      db.exec(change);
      assert.throws(() => db.exec(insertMember), /invitation_membership_not_authorized/);
      assert.equal(db.prepare('SELECT count(*) AS count FROM member').get()!.count, 0);
    } finally { db.close(); }
  }
});
