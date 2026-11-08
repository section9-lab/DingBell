import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOW_MS, NOW_MS_WHOLE_SECONDS, sqlHasRole, sqlManagesCompany } from '../src/platform/database/sql.ts';

test('database time expressions stay in integer milliseconds', () => {
  assert.equal(NOW_MS, "CAST(unixepoch('subsecond')*1000 AS INTEGER)");
  assert.equal(NOW_MS_WHOLE_SECONDS, 'unixepoch()*1000');
});

test('role predicates tolerate comma-separated roles without substring matches', () => {
  const predicate = sqlHasRole('actor.role', 'admin');
  assert.equal(predicate, "instr(',' || actor.role || ',', ',admin,') > 0");
  assert.doesNotMatch(predicate, /role IN/);
});

test('manager predicate covers owners and administrators', () => {
  const predicate = sqlManagesCompany('actor.role');
  assert.match(predicate, /',owner,'/);
  assert.match(predicate, /',admin,'/);
  assert.match(predicate, /^\(/);
});

test('role names cannot inject SQL', () => {
  assert.throws(() => sqlHasRole('actor.role', "admin') OR 1=1 --"), { name: 'RangeError' });
  assert.throws(() => sqlHasRole('actor.role', ''), { name: 'RangeError' });
});
