import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrationFiles, migrationStatements } from './fixtures/migrations.ts';

const MIGRATION = '0080_reply_policy_single_stage.sql';

/** 迁移只负责把本地/历史数据从 `stages: [...]` 收敛成 `stage: "..."`。 */
test('reply policy migration rewrites legacy multi-stage configs and keeps versions immutable', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  try {
    for (const file of migrationFiles('0079')) for (const sql of migrationStatements(file)) db.exec(sql);
    db.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('company','Company','company',1)");

    const legacy = (id: string, config: unknown) => {
      db.prepare(`INSERT INTO reply_policy (organization_id,id,kind,version,draft_revision,tested_revision,tested_time_zone,
        draft_base_revision,published_revision,enabled,published_by,published_at,published_request_id,published_time_zone,draft_config,updated_at)
        VALUES('company',?,'automatic',1,1,1,'UTC',1,1,1,'owner',1,'request','UTC',?,1)`).run(id, JSON.stringify(config));
    };
    const base = { kind: 'automatic', name: 'History', storeIds: [], priority: 50, mode: 'automatic',
      language: 'customer', tone: 'concise', instructions: '' };
    legacy('multi', { ...base, stages: ['presale', 'order', 'aftersale'] });
    legacy('single', { ...base, stage: 'order' });

    assert.equal(db.prepare('SELECT count(*) AS n FROM policy_version').get()?.n, 2, 'insert snapshot ran');
    for (const sql of migrationStatements(MIGRATION)) db.exec(sql);

    const read = (table: string, column: string, key: string, id: string): Record<string, unknown> =>
      JSON.parse(String(db.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${key}=?`).get(id)?.value));
    const draft = read('reply_policy', 'draft_config', 'id', 'multi');
    assert.equal(draft.stage, 'presale', 'the first stage survives');
    assert.equal('stages' in draft, false, 'the array is removed');
    assert.equal(draft.name, 'History', 'other fields are preserved');
    assert.equal(read('policy_version', 'config', 'policy_id', 'multi').stage, 'presale', 'snapshots are migrated too');
    assert.equal(read('reply_policy', 'draft_config', 'id', 'single').stage, 'order', 'single-stage rows are untouched');

    assert.throws(() => db.exec("UPDATE policy_version SET config='{}'"), /immutable/, 'the trigger is restored');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});
