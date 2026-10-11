import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

test('knowledge draft transactions and publication gates in native Workers and D1', { timeout: 180_000 }, async t => {
  const app = await startLocalApplication();
  t.after(() => app.close());
  const signIn = await fetch(`${app.baseURL}/api/auth/sign-in/email`, { method: 'POST', headers: { origin: app.baseURL, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.invalid', password: app.password }) });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  const cookie = signIn.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const request = (suffix: string, body?: unknown) => fetch(`${app.baseURL}/api/companies/company-a/knowledge${suffix}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { cookie, origin: app.baseURL, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const id = crypto.randomUUID(), payload = { id, title: '测试店铺政策', kind: 'policy', storeId: null, productRef: null, language: 'ru', source: { format: 'markdown', content: '# 合成政策\n\n请联系商家确认规格。' } };
  await t.test('create and exact retries keep a single immutable revision', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await request('', payload); assert.equal(r.status, 200, await r.clone().text());
      const result = await r.json() as any; assert.equal(result.document.version, 1); assert.equal(result.draft.revision, 1); assert.equal(result.document.activeRevision, null);
    }
  });
  await t.test('batch changes advance the head and all revision content together', async () => {
    const r = await request(`/${id}/draft`, { expectedVersion: 1, title: '第二版', source: { format: 'text', content: '更新后的合成政策。' } });
    assert.equal(r.status, 200, await r.clone().text()); const result = await r.json() as any;
    assert.equal(result.document.version, 2); assert.equal(result.draft.revision, 2); assert.equal(result.draft.source.content, '更新后的合成政策。');
    assert.equal((await request(`/${id}/draft`, { expectedVersion: 1, title: '过时的修改', source: payload.source })).status, 409);
  });
  await t.test('unindexed drafts cannot publish and restoring history creates a new draft', async () => {
    const indexing = await request(`/${id}/index`, { jobId: crypto.randomUUID(), expectedVersion: 2 });
    assert.equal(indexing.status, 503, await indexing.clone().text());
    assert.equal((await indexing.json() as any).error.code, 'KNOWLEDGE_INDEXING_UNAVAILABLE');
    assert.equal((await request(`/${id}/publish`, { expectedVersion: 2 })).status, 409);
    const r = await request(`/${id}/restore`, { expectedVersion: 2, revision: 1 }); assert.equal(r.status, 200, await r.clone().text());
    const result = await r.json() as any; assert.equal(result.draft.revision, 3); assert.equal(result.draft.rollbackOf, 1);
    assert.equal(result.draft.source.content, payload.source.content); assert.equal(result.document.activeRevision, null);
    assert.equal((await request(`/${id}/publish`, { expectedVersion: 3 })).status, 409);
  });
  await t.test('keyset history and withdrawal preserve original sources', async () => {
    const r = await request(`/${id}/versions?before=4`); assert.equal(r.status, 200);
    assert.deepEqual((await r.json() as any).revisions.map((value: any) => value.revision), [3, 2, 1]);
    const withdrawn = await request(`/${id}/withdraw`, { expectedVersion: 3 }); assert.equal(withdrawn.status, 200);
    assert.equal((await withdrawn.json() as any).document.activeRevision, null);
  });
  await t.test('native multipart CSV import validates the whole file and saves resumable unpublished drafts', async () => {
    const upload = (suffix: string, content: string, manifestHash?: string) => {
      const form = new FormData(); form.append('file', new Blob([content], { type: 'text/csv' }), 'native.csv'); form.append('title', '');
      form.append('scope', JSON.stringify({ kind: 'guide', storeId: null, productRef: null, language: 'en' }));
      if (manifestHash) form.append('manifestHash', manifestHash);
      return fetch(`${app.baseURL}/api/companies/company-a/knowledge/${suffix}`, { method: 'POST', headers: { cookie, origin: app.baseURL }, body: form });
    };
    const csv = '\ufefftitle,content\r\n"Native, source","Verified line one.\r\nVerified line two."\r\nSecond,Another verified source.';
    const first = await upload('file-preview', csv); assert.equal(first.status, 200, await first.clone().text());
    const preview = await first.json() as any; assert.equal(preview.entries.length, 2); assert.equal(preview.entries[0].exists, false);
    for (const content of ['title,content\na,"broken', 'title,content\na,valid\nb,' + '中'.repeat(3000)]) assert.equal((await upload('file-preview', content)).status, 400);
    assert.equal((await upload('file-preview', 'x'.repeat(65537))).status, 413);
    for (let attempt = 0; attempt < 2; attempt++) { const result = await upload('file-import', csv, preview.manifestHash); assert.equal(result.status, 200, await result.clone().text()); }
    for (const entry of preview.entries) { const doc = await (await request(`/${entry.documentId}`)).json() as any;
      assert.equal(doc.document.draftRevision, 1); assert.equal(doc.document.activeRevision, null); assert.equal(doc.draft.contentHash, entry.contentHash); }
    const list = await (await request('')).json() as any; assert.equal(list.documents.length, 3);
  });
});
