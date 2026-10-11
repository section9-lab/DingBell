/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readReplyDraft, saveReplyDraft, clearReplyDrafts } from './conversation-draft.ts';
const scope = { userId: 'user', memberId: 'member', companyId: 'company', conversationId: 'conversation' };
class MemoryStorage {
  values = new Map<string, string>();
  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
}
test('drafts preserve exact editable text, including incomplete input, and explicit empty text removes the saved draft', () => {
  const storage = new MemoryStorage(), body = '  Здравствуйте!\r\n中文\t<原文>  ';
  assert.deepEqual(readReplyDraft(storage, scope), { state: 'none' }); assert.equal(saveReplyDraft(storage, scope, body), true);
  assert.deepEqual(readReplyDraft(storage, scope), { state: 'saved', body });
  for (const body of ['   ', '\ud83d', '字'.repeat(1000)]) { assert.equal(saveReplyDraft(storage, scope, body), true); assert.deepEqual(readReplyDraft(storage, scope), { state: 'saved', body }); }
  assert.equal(saveReplyDraft(storage, scope, ''), true); assert.equal(storage.length, 0);
});
test('draft identity isolates users, replacement memberships, companies and conversations without key collisions', () => {
  const storage = new MemoryStorage(); assert.equal(saveReplyDraft(storage, scope, 'private'), true);
  for (const change of [{ userId: 'other' }, { memberId: 'rejoined' }, { companyId: 'other' }, { conversationId: 'other' }]) assert.deepEqual(readReplyDraft(storage, { ...scope, ...change }), { state: 'none' });
  const a = { ...scope, userId: 'a:b', memberId: 'c' }, b = { ...scope, userId: 'a', memberId: 'b:c' };
  assert.equal(saveReplyDraft(storage, a, 'A'), true); assert.deepEqual(readReplyDraft(storage, b), { state: 'none' });
  const unicode = { ...scope, companyId: '公司 / ? #', conversationId: '会话' }; assert.equal(saveReplyDraft(storage, unicode, '中文'), true); assert.deepEqual(readReplyDraft(storage, unicode), { state: 'saved', body: '中文' });
});
test('corrupt, oversized and wrong-scope drafts are not displayed or silently deleted by reads', () => {
  const storage = new MemoryStorage(); saveReplyDraft(storage, scope, 'private'); const key = storage.key(0)!, good = JSON.parse(storage.getItem(key)!);
  for (const value of ['{', 'x'.repeat(16_385), 'null', JSON.stringify({ ...good, v: 2 }), JSON.stringify({ ...good, body: 42 }), JSON.stringify({ ...good, body: 'x'.repeat(1001) }), JSON.stringify({ ...good, scope: { ...scope, memberId: 'rejoined' } }), JSON.stringify({ ...good, extra: true })]) {
    storage.values.set(key, value); assert.deepEqual(readReplyDraft(storage, scope), { state: 'unavailable' }); assert.equal(storage.getItem(key), value);
  }
});
test('storage denial, quota, failed readback and removal are reported without claiming a successful save', () => {
  assert.deepEqual(readReplyDraft(null, scope), { state: 'unavailable' }); assert.equal(saveReplyDraft(null, scope, 'draft'), false);
  const denied = new MemoryStorage(); denied.getItem = () => { throw new Error('SecurityError'); }; assert.deepEqual(readReplyDraft(denied, scope), { state: 'unavailable' });
  const quota = new MemoryStorage(); quota.setItem = () => { throw new Error('QuotaExceededError'); }; assert.equal(saveReplyDraft(quota, scope, 'draft'), false);
  const dropped = new MemoryStorage(); dropped.setItem = () => {}; assert.equal(saveReplyDraft(dropped, scope, 'draft'), false);
  const removal = new MemoryStorage(); saveReplyDraft(removal, scope, 'old'); removal.removeItem = () => {}; assert.equal(saveReplyDraft(removal, scope, ''), false); assert.deepEqual(readReplyDraft(removal, scope), { state: 'saved', body: 'old' });
});
test('confirmed identity cleanup removes only selected draft scopes and never the submission journals', () => {
  const storage = new MemoryStorage(), otherUser = { ...scope, userId: 'other' }, otherCompany = { ...scope, companyId: 'other' };
  for (const s of [scope, { ...scope, conversationId: 'other' }, otherUser, otherCompany]) saveReplyDraft(storage, s, 'private');
  storage.values.set(storage.key(0)!, '{corrupt'); storage.setItem('dingbell:reply-pending:v1:unrelated', 'send'); storage.setItem('dingbell:preview-pending:v1:unrelated', 'preview');
  assert.equal(clearReplyDrafts(storage, { userId: 'user', companyId: 'company' }), true); assert.deepEqual(readReplyDraft(storage, scope), { state: 'none' });
  assert.deepEqual(readReplyDraft(storage, otherCompany), { state: 'saved', body: 'private' }); assert.equal(clearReplyDrafts(storage, { userId: 'user' }), true);
  assert.deepEqual(readReplyDraft(storage, otherUser), { state: 'saved', body: 'private' }); assert.equal(storage.getItem('dingbell:reply-pending:v1:unrelated'), 'send'); assert.equal(storage.getItem('dingbell:preview-pending:v1:unrelated'), 'preview');
  storage.removeItem = () => { throw new Error('denied'); }; assert.equal(clearReplyDrafts(storage, { userId: 'other' }), false);
});
test('invalid draft bounds and scope never overwrite a valid record or broaden cleanup', () => {
  const storage = new MemoryStorage(); saveReplyDraft(storage, scope, 'keep'); const initial = new Map(storage.values);
  for (const s of [{ ...scope, userId: '' }, { ...scope, memberId: '\n' }, { ...scope, unexpected: 'x' }]) { assert.equal(saveReplyDraft(storage, s, 'replace'), false); assert.deepEqual(readReplyDraft(storage, s), { state: 'unavailable' }); }
  assert.equal(saveReplyDraft(storage, scope, 'x'.repeat(1001)), false); assert.equal(clearReplyDrafts(storage, { userId: '' }), false); assert.deepEqual(storage.values, initial);
});
