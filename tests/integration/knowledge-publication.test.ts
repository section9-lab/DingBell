import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { prepareKnowledge } from '../../src/modules/knowledge/content.ts';
import { publishKnowledge, readKnowledge, writeKnowledge } from '../../src/modules/knowledge/storage.ts';

test('native D1 upgrade keeps existing publication and requires separate evidence on subsequent publishes', { timeout: 60_000 }, async t => {
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response(null,{status:404})}}',
    compatibilityDate: '2026-06-01', d1Databases: { DB: crypto.randomUUID() } });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  const folder = new URL('../../migrations/', import.meta.url);
  const apply = async (file: string) => {
    const statements = (await readFile(new URL(file, folder), 'utf8')).split('--> statement-breakpoint').map(sql => sql.trim()).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
  };
  for (const file of (await readdir(folder)).filter(file => file.endsWith('.sql') && file < '0026').sort()) await apply(file);
  await db.batch([
    db.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Synthetic','synthetic',1)"),
    db.prepare("INSERT INTO user(id,name,email,email_verified) VALUES('owner','Owner','owner@example.invalid',1)"),
    db.prepare("INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member','company','owner','owner',1)"),
    db.prepare("INSERT INTO session(id,token,user_id,expires_at,updated_at) VALUES('login','synthetic-token','owner',unixepoch()*1000+3600000,1)"),
  ]);
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId: 'login' }, id = crypto.randomUUID();
  const scope = { kind: 'guide' as const, storeId: null, productRef: null, language: 'en' as const };
  const draft = await prepareKnowledge('company', id, 1, scope, { title: 'Synthetic', source: { format: 'text', content: 'Original content.' } });
  assert.equal(await writeKnowledge(db, actor, id, scope, draft, 0, crypto.randomUUID()), true);
  // Pre-upgrade legacy state, not verified by the new publication pipeline.
  await db.prepare("UPDATE knowledge_revision SET status='ready',tested_at=1,index_profile='synthetic',mutation_id='legacy' WHERE document_id=?").bind(id).run();
  await db.prepare('UPDATE knowledge_document SET active_revision=1,version=2 WHERE id=?').bind(id).run();
  await apply('0026_knowledge_publication.sql');
  // Current readers include durable review operations; finish the existing schema upgrade before using them.
  await apply('0027_knowledge_reviews.sql');
  const legacy = await readKnowledge(db, actor, id);
  assert.equal(legacy?.document.activeRevision, 1); assert.equal(legacy?.active?.source.format, 'text');
  assert.equal(legacy?.active?.publicationReady, false, 'the migration does not manufacture missing proof');
  await assert.rejects(() => db.prepare('UPDATE knowledge_document SET active_revision=1,version=3 WHERE id=?').bind(id).run(), /publication requires/);
  assert.equal(await publishKnowledge(db, actor, id, 2), null);
  await db.prepare("UPDATE knowledge_revision SET published_profile='synthetic',published_mutation_id='verified-copy',published_at=2 WHERE document_id=?").bind(id).run();
  assert.ok(await publishKnowledge(db, actor, id, 2));
  assert.equal((await readKnowledge(db, actor, id))?.document.version, 3);
  assert.equal(await publishKnowledge(db, actor, id, 2), null, 'an old document version cannot be reused');
});
