import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { prepareKnowledge } from '../src/modules/knowledge/content.ts';
import { writeKnowledge } from '../src/modules/knowledge/storage.ts';
import { approveTextKnowledge } from '../src/modules/knowledge/text-profile.ts';
import { readKnowledgeVirtualFile, readKnowledgeVirtualFiles } from '../src/modules/knowledge/virtual-files.ts';
import type { KnowledgeScope } from '../src/shared/knowledge.ts';

const scope = { storeId: 'store-a', productRef: null, language: 'ru' as const };
async function fixture() {
  const f = await knowledgeFixture();
  const session = f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!;
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId: String(session.id) };
  async function save(index: number, overrides: Partial<KnowledgeScope> = {}, publish = true) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const selected = { kind: 'faq' as const, storeId: null, productRef: null, language: 'ru' as const, ...overrides };
    const draft = await prepareKnowledge('company', id, 1, selected, { title: 'FAQ', source: { format: 'markdown', content: `Товар ${index}\n退款` } });
    assert.equal(await writeKnowledge(f.db, actor, id, selected, draft, 0, crypto.randomUUID()), true);
    if (publish) assert.equal(await approveTextKnowledge(f.db, actor, id, 1), true);
    return id;
  }
  return { ...f, save };
}

test('virtual files contain only published documents in the requested scope', async t => {
  const f = await fixture(); t.after(f.close);
  const id = await f.save(1);
  await f.save(2, { storeId: 'store-b' });
  await f.save(3, { language: 'zh-CN' });
  await f.save(4, {}, false);
  const files = await readKnowledgeVirtualFiles(f.db, 'company', scope);
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, `/knowledge/${id}.md`);
  assert.equal(files[0]?.content, 'FAQ\n\nТовар 1\n退款');
  assert.equal(files[0]?.revision, 1);
  assert.deepEqual(await readKnowledgeVirtualFiles(f.db, 'other', scope), []);
  assert.equal((await f.request(`/${id}/withdraw`, { expectedVersion: 2 })).status, 200);
  assert.deepEqual(await readKnowledgeVirtualFiles(f.db, 'company', scope), []);
});

test('bounded virtual reads use exact authorized paths and preserve line positions', async t => {
  const f = await fixture(); t.after(f.close);
  const id = await f.save(1);
  const files = await readKnowledgeVirtualFiles(f.db, 'company', scope);
  const path = `/knowledge/${id}.md`;
  assert.deepEqual(readKnowledgeVirtualFile(files, path, 3, 1), {
    path, documentId: id, revision: 1, contentHash: files[0]!.contentHash, title: 'FAQ',
    startLine: 3, endLine: 3, totalLines: 4, content: 'Товар 1',
  });
  assert.equal(readKnowledgeVirtualFile(files, `/knowledge/../knowledge/${id}.md`), null);
  assert.equal(readKnowledgeVirtualFile(files, '/etc/passwd'), null);
  assert.throws(() => readKnowledgeVirtualFile(files, path, 0), /INVALID_KNOWLEDGE_READ_RANGE/);
  assert.throws(() => readKnowledgeVirtualFile(files, path, 1, 201), /INVALID_KNOWLEDGE_READ_RANGE/);
  assert.equal(readKnowledgeVirtualFile(files, path, 99, 1)?.content, '');
  assert.throws(() => readKnowledgeVirtualFile([{ ...files[0]!, content: '字'.repeat(6000) }], path), /KNOWLEDGE_READ_TOO_LARGE/);
});

test('product-specific documents never cross product or store boundaries', async t => {
  const f = await fixture(); t.after(f.close);
  const id = '00000001-0000-4000-8000-000000000000';
  const session = f.sqlite.prepare("SELECT id FROM session WHERE user_id='owner'").get()!;
  const actor = { orgId: 'company', actorUserId: 'owner', sessionId: String(session.id) };
  const selected = { kind: 'product' as const, storeId: 'store-a', productRef: 'product-a', language: 'ru' as const };
  const draft = await prepareKnowledge('company', id, 1, selected, { title: 'Product', source: { format: 'product', facts: [{ label: 'Size', value: '20 cm' }] } });
  assert.equal(await writeKnowledge(f.db, actor, id, selected, draft, 0, crypto.randomUUID()), true);
  assert.equal(await approveTextKnowledge(f.db, actor, id, 1), true);
  assert.deepEqual(await readKnowledgeVirtualFiles(f.db, 'company', scope), []);
  assert.deepEqual(await readKnowledgeVirtualFiles(f.db, 'company', { ...scope, productRef: 'product-b' }), []);
  assert.deepEqual(await readKnowledgeVirtualFiles(f.db, 'company', { ...scope, storeId: 'store-b', productRef: 'product-a' }), []);
  const files = await readKnowledgeVirtualFiles(f.db, 'company', { ...scope, productRef: 'product-a' });
  assert.equal(files.length, 1);
  assert.equal(files[0]?.documentId, id);
  assert.match(files[0]!.content, /Size: 20 cm/);
});

test('virtual files reconstruct legitimate historical source and reject changed snapshots', async t => {
  const f = await fixture(); t.after(f.close);
  const id = await f.save(1);
  f.sqlite.prepare(`UPDATE knowledge_revision SET markdown=NULL,status='ready',tested_at=1,
    mutation_id='old-proof',index_profile='old-profile',published_profile='old-profile' WHERE document_id=?`).run(id);
  assert.equal((await readKnowledgeVirtualFiles(f.db, 'company', scope))[0]?.content, 'FAQ\n\nТовар 1\n退款');
  let calls = 0;
  f.after(sql => {
    if (sql.includes('FROM knowledge_document doc JOIN knowledge_revision rev') && ++calls === 1) {
      f.sqlite.prepare('UPDATE knowledge_revision SET markdown=? WHERE document_id=?').run('changed', id);
    }
  });
  await assert.rejects(readKnowledgeVirtualFiles(f.db, 'company', scope), /KNOWLEDGE_DIRECTORY_CHANGED/);
});

test('a directory beyond the bound fails instead of returning incomplete results', async t => {
  const f = await fixture(); t.after(f.close);
  for (let index = 1; index <= 501; index++) await f.save(index);
  await assert.rejects(readKnowledgeVirtualFiles(f.db, 'company', scope), /KNOWLEDGE_DIRECTORY_TOO_LARGE/);
});
