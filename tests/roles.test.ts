import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canManageCompany, hasRole, isOwner, parseRoles } from '../src/shared/roles.ts';

test('parseRoles trims and drops empty entries', () => {
  assert.deepEqual(parseRoles('owner'), ['owner']);
  assert.deepEqual(parseRoles(' owner , admin '), ['owner', 'admin']);
  assert.deepEqual(parseRoles(''), []);
  assert.deepEqual(parseRoles('owner,,admin'), ['owner', 'admin']);
});

test('hasRole accepts single and comma-separated better-auth roles', () => {
  assert.equal(hasRole('owner', 'owner'), true);
  assert.equal(hasRole('owner,admin', 'admin'), true);
  assert.equal(hasRole('member,admin', 'owner', 'admin'), true);
  assert.equal(hasRole('owner', 'admin'), false);
  assert.equal(hasRole('superadmin', 'admin'), false);
  assert.equal(hasRole('', 'owner'), false);
  assert.equal(hasRole('owner', ...[]), false);
});

test('company role helpers never grant management to plain members', () => {
  assert.equal(canManageCompany('owner'), true);
  assert.equal(canManageCompany('admin'), true);
  assert.equal(canManageCompany('owner,admin'), true);
  assert.equal(canManageCompany('member'), false);
  assert.equal(isOwner('owner,admin'), true);
  assert.equal(isOwner('admin'), false);
});
