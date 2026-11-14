import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conversationsFixture } from './fixtures/conversations.ts';

test('default search combines exact thread and order matches across list, counts, pagination and CSV', { timeout: 30_000 }, async t => {
  const f = await conversationsFixture();
  t.after(f.close);
  // One value matches a message order in A and a thread in B. Repeated matching messages must not duplicate A.
  await f.DB.batch([
    f.DB.prepare("UPDATE conversation SET platform_thread_id='order-1' WHERE id IN ('conv-b','conv-c')"),
    f.DB.prepare("UPDATE message SET order_number='order-1' WHERE id='msg-a2'"),
  ]);
  async function list(query: string, actor = 'owner') {
    const response = await f.request(query, actor);
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as any;
  }
  const first = await list('?search=order-1&limit=1');
  assert.deepEqual(first.conversations.map((item: any) => item.id), ['conv-a']);
  assert.deepEqual(first.counts, { all: 2, mine: 0, unassigned: 2, ai: 0 });
  assert.ok(first.nextCursor);
  const second = await list(`?search=order-1&limit=1&cursor=${first.nextCursor}`);
  assert.deepEqual(second.conversations.map((item: any) => item.id), ['conv-b']);
  assert.deepEqual(second.counts, first.counts);
  assert.equal(second.nextCursor, null);
  assert.equal((await f.request(`?searchField=order&search=order-1&cursor=${first.nextCursor}`)).status, 400);
  for (const [query, actor] of [['?search=order-1', 'staff'], ['?search=order-1&storeId=store-a', 'owner']]) {
    const page = await list(query, actor);
    assert.deepEqual(page.conversations.map((item: any) => item.id), ['conv-a']);
    assert.equal(page.counts.all, 1);
  }
  for (const value of ['order', 'order%', '%', "order-1' OR 1=1 --"]) {
    assert.deepEqual((await list(`?search=${encodeURIComponent(value)}`)).conversations, []);
  }
  for (const kind of ['conversations', 'messages']) {
    const response = await f.app.request(`${f.env.APP_BASE_URL}/api/companies/company/exports/csv`, {
      method: 'POST',
      headers: { cookie: f.cookies.owner, origin: f.env.APP_BASE_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ kind, scope: 'all', filters: { search: 'order-1' } }),
    }, f.env as never);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('x-dingbell-row-count'), kind === 'conversations' ? '2' : '3');
    const csv = await response.text();
    assert.match(csv, /conv-a/);
    assert.match(csv, /conv-b/);
    assert.doesNotMatch(csv, /conv-c|conv-empty/);
  }
});
