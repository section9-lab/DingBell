import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { prepareKnowledge } from '../src/modules/knowledge/content.ts';
import type { KnowledgeScope } from '../src/shared/knowledge.ts';
import { writeKnowledge } from '../src/modules/knowledge/storage.ts';
import { approveTextKnowledge, grepPublishedText, readPublishedKnowledge } from '../src/modules/knowledge/text-profile.ts';

async function fixture() {
  const f = await knowledgeFixture();
  const session = f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!;
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId: String(session.id) };
  const scope = { kind: 'faq' as const, storeId: null, productRef: null, language: 'ru' as const };
  return {
    ...f,
    async publish(index: number, content: string, overrides: Partial<KnowledgeScope> = {}) {
      const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      const selectedScope = { ...scope, ...overrides };
      const prepared = await prepareKnowledge('company', id, 1, selectedScope, { title: 'FAQ', source: { format: 'text', content } });
      assert.equal(await writeKnowledge(f.db, actor, id, selectedScope, prepared, 0, crypto.randomUUID()), true);
      assert.equal(await approveTextKnowledge(f.db, actor, id, 1), true);
      return id;
    },
  };
}

test('published knowledge after the first 500 chunks remains searchable', async t => {
  const f = await fixture();
  t.after(f.close);
  for (let index = 0; index < 500; index++) await f.publish(index, 'ordinary unrelated inventory information');
  const target = await f.publish(500, 'uniquefinalneedle approved return information');
  const matches = await grepPublishedText(f.db, 'company', { storeId: 'store-a', productRef: null, language: 'ru' }, 'uniquefinalneedle');
  assert.deepEqual(matches.map(match => match.documentId), [target]);
});

test('a previously reviewed vector publication keeps its original text readable after the text-only upgrade', async t => {
  const f = await fixture();
  t.after(f.close);
  const target = await f.publish(1, 'Возврат товара разрешён в течение 14 дней.');
  f.sqlite.prepare(`UPDATE knowledge_revision SET markdown=NULL,status='ready',tested_at=1,
    mutation_id='old-index-proof',index_profile='legacy-reviewed-profile',published_profile='legacy-reviewed-profile'
    WHERE document_id=?`).run(target);
  const scope = { storeId: 'store-a', productRef: null, language: 'ru' as const };
  const matches = await grepPublishedText(f.db, 'company', scope, 'возврат');
  assert.deepEqual(matches.map(match => match.documentId), [target]);
  const document = await readPublishedKnowledge(f.db, 'company', scope, target);
  assert.equal(document?.markdown, 'FAQ\n\nВозврат товара разрешён в течение 14 дней.');
  const response = await f.request(`/${target}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { active: { publicationReady: boolean } }).active.publicationReady, true);
});

test('Unicode matching and short Chinese queries use current scope and publications before limiting results', async t => {
  const f = await fixture(); t.after(f.close);
  const russian = await f.publish(1, 'ВОЗВРАТ товара разрешён в течение 14 дней.');
  const chinese = await f.publish(2, '退货政策：商品退款需要人工确认。', { language: 'zh-CN' });
  for (let index = 3; index < 12; index++) await f.publish(index, 'возврат возврат возврат', { storeId: 'store-b' });
  const scope = { storeId: 'store-a', productRef: null, language: 'ru' as const };
  assert.deepEqual((await grepPublishedText(f.db, 'company', scope, 'возврат')).map(row => row.documentId), [russian]);
  assert.deepEqual((await grepPublishedText(f.db, 'company', { ...scope, language: 'zh-CN' }, '退款')).map(row => row.documentId), [chinese]);
  assert.deepEqual(await grepPublishedText(f.db, 'other', scope, 'возврат'), []);
  assert.equal((await f.request(`/${russian}/withdraw`, { expectedVersion: 2 })).status, 200);
  assert.deepEqual(await grepPublishedText(f.db, 'company', scope, 'возврат'), []);
  await assert.rejects(grepPublishedText(f.db, 'company', scope, 'возврат', Infinity), /INVALID_KNOWLEDGE_LIMIT/);
});
