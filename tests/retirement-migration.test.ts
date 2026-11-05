import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SqliteDatabase, migrateSqlite } from '../src/platform/node/database.ts';
import { Miniflare } from 'miniflare';
import { retirementArchivePlan, assertRetirementArchives, retiringTables } from '../src/platform/database/retirement.ts';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dingbell-retirement-'));
  const migrations = join(directory, 'migrations');
  await mkdir(migrations);
  for (const name of (await readdir(resolve('migrations'))).filter(name => name.endsWith('.sql') && name < '0069_')) {
    await copyFile(resolve('migrations', name), join(migrations, name));
  }
  const db = new SqliteDatabase(join(directory, 'business.sqlite'));
  await migrateSqlite(db, migrations);
  db.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('legacy-org','Legacy','legacy',1);
    INSERT INTO reply_test_budget(id,organization_id,starts_at,ends_at,limit_micros,max_runs,spent_micros,admitted_runs)
    VALUES('legacy-budget','legacy-org',0,1000,100,10,20,1);`);
  return { db, migrations, close: async () => { db.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('retiring a subsystem archives its original financial rows before applying the unchanged destructive migration', async t => {
  const f = await fixture();
  t.after(f.close);
  await copyFile(resolve('migrations/0069_drop_vector_and_reply_test.sql'), join(f.migrations, '0069_drop_vector_and_reply_test.sql'));
  await migrateSqlite(f.db, f.migrations);
  assert.deepEqual({ ...f.db.sqlite.prepare(`SELECT id,spent_micros,admitted_runs FROM dingbell_retired_reply_test_budget`).get() },
    { id: 'legacy-budget', spent_micros: 20, admitted_runs: 1 });
  await assert.rejects(f.db.prepare('DELETE FROM dingbell_retired_reply_test_budget').run(), /RETIRED_ARCHIVE_IMMUTABLE/);
  await migrateSqlite(f.db, f.migrations);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM dingbell_retired_reply_test_budget').get()!.n, 1);
});

test('the shared archive plan freezes and verifies D1 rows without rewriting historical SQL', async t => {
  const worker = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response(null) } }',
    compatibilityDate: '2026-06-01', d1Databases: { DB: 'archive-fixture' } });
  t.after(() => worker.dispose());
  const db = await worker.getD1Database('DB');
  await db.prepare('CREATE TABLE reply_test_budget(id TEXT PRIMARY KEY,spent_micros INTEGER NOT NULL,receipt TEXT)').run();
  await db.prepare("INSERT INTO reply_test_budget VALUES('original',20,'{\"uid\":\"legacy-original\"}')").run();
  const plan = retirementArchivePlan('reply_test_budget');
  const results = await db.batch<Record<string, unknown>>([...plan.statements, plan.verify].map(sql => db.prepare(sql)));
  assertRetirementArchives(results.flatMap(result => result.results), ['reply_test_budget']);
  await assert.rejects(db.prepare('UPDATE reply_test_budget SET spent_micros=0').run(), /RETIRED_SOURCE_FROZEN/);
  await db.prepare('DROP TABLE reply_test_budget').run();
  assert.deepEqual(await db.prepare('SELECT * FROM dingbell_retired_reply_test_budget').first(),
    { id: 'original', spent_micros: 20, receipt: '{"uid":"legacy-original"}' });
  await assert.rejects(db.prepare('DELETE FROM dingbell_retired_reply_test_budget').run(), /RETIRED_ARCHIVE_IMMUTABLE/);
  assert.throws(() => assertRetirementArchives([{ sourceTable: 'reply_test_budget', verified: 0 }], ['reply_test_budget']), /RETIRED_ARCHIVE_UNCONFIRMED/);
  assert.throws(() => assertRetirementArchives([], ['reply_test_budget']), /RETIRED_ARCHIVE_UNCONFIRMED/);
  assert.deepEqual(retiringTables('DROP TABLE reply_test_budget;\nDROP TABLE unrelated;\nDROP TABLE "ai_answer";'), ['ai_answer', 'reply_test_budget']);
});
