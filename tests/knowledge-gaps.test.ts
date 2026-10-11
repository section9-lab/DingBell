import assert from 'node:assert/strict';
import { test } from 'node:test';
import { immediateSteps, knowledgeReviewFixture } from './fixtures/knowledge-review.ts';
import { runKnowledgeReview } from '../src/modules/knowledge/review-runtime.ts';
import { runKnowledgeIndex } from '../src/modules/knowledge/index-runtime.ts';

async function evaluate(f:Awaited<ReturnType<typeof knowledgeReviewFixture>>,score:number,cases=f.cases) {
  f.score(score);const doc=await(await f.request(`/${f.id}`)).json() as any,jobId=crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/tests`,{jobId,expectedVersion:doc.document.version,cases})).status,202);
  await runKnowledgeReview(f.env,{organizationId:'company',jobId},immediateSteps);return jobId;
}
async function gaps(f:Awaited<ReturnType<typeof knowledgeReviewFixture>>,query='') {
  const r=await f.request(`/gaps${query}`);assert.equal(r.status,200,await r.clone().text());return await r.json() as any;
}
async function publish(f:Awaited<ReturnType<typeof knowledgeReviewFixture>>) {
  const current=await(await f.request(`/${f.id}`)).json() as any,jobId=crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/publish`,{jobId,expectedVersion:current.document.version})).status,202);
  f.visible();await runKnowledgeReview(f.env,{organizationId:'company',jobId},immediateSteps);
}
test('knowledge gaps expose failed saved test cases with immutable source evidence, without writing a second task ledger',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);const failedJobId=await evaluate(f,.2);
  const before=f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_review_job').get()?.n;
  const list=await gaps(f);assert.equal(list.companyId,'company');assert.equal(list.gaps.length,1);
  const gap=list.gaps[0];assert.equal(gap.jobId,failedJobId);assert.equal(gap.caseIndex,0);assert.equal(gap.documentId,f.id);
  assert.equal(gap.question,f.cases[0].question);assert.equal(gap.minimumScore,.7);assert.equal(gap.observedScore,.2);assert.equal(gap.state,'pending');assert.equal(gap.proof,null);
  assert.equal(gap.storeId,'store-a');assert.equal(gap.productRef,'sku-a');assert.equal(gap.language,'en');assert.equal(gap.revision,1);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM knowledge_review_job').get()?.n,before);
});
test('gap progress requires a passing current revision, sufficient original threshold and separate publication',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);await evaluate(f,.2);
  await evaluate(f,.3,[{...f.cases[0],minimumScore:.1}]);assert.equal((await gaps(f)).gaps[0].state,'pending','lowering the test threshold cannot satisfy the old requirement');
  const passed=await evaluate(f,.9);let gap=(await gaps(f)).gaps[0];assert.equal(gap.state,'retested');assert.deepEqual(gap.proof,{jobId:passed,revision:1});
  assert.equal((await gaps(f,'?state=pending')).gaps.length,0);assert.equal((await gaps(f,'?state=retested')).gaps.length,1);
  await publish(f);gap=(await gaps(f)).gaps[0];assert.equal(gap.state,'published');assert.equal(gap.proof.jobId,passed);
  const doc=await(await f.request(`/${f.id}`)).json() as any;assert.equal((await f.request(`/${f.id}/withdraw`,{expectedVersion:doc.document.version})).status,200);
  assert.equal((await gaps(f)).gaps[0].state,'retested','withdrawal cannot retain the published label');
});
test('older published knowledge and tests for another question cannot clear a newer failed revision',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);await evaluate(f,.9);await publish(f);
  let doc=await(await f.request(`/${f.id}`)).json() as any;
  assert.equal((await f.request(`/${f.id}/draft`,{expectedVersion:doc.document.version,title:'Updated guide',source:{format:'text',content:'The blue model has a revised setup.'}})).status,200);
  doc=await(await f.request(`/${f.id}`)).json() as any;const indexJobId=crypto.randomUUID();
  assert.equal((await f.request(`/${f.id}/index`,{jobId:indexJobId,expectedVersion:doc.document.version})).status,202);
  await runKnowledgeIndex(f.env,{organizationId:'company',jobId:indexJobId},immediateSteps);
  const chunkId=f.sqlite.prepare('SELECT id FROM knowledge_chunk WHERE document_id=? AND revision=2').get(f.id)!.id as string;
  const cases=[{...f.cases[0],expectedChunkId:chunkId}];await evaluate(f,.2,cases);
  assert.equal((await gaps(f)).gaps[0].state,'pending');
  await evaluate(f,.9,[{...cases[0],question:'A different question?'}]);assert.equal((await gaps(f)).gaps[0].state,'pending');
  await evaluate(f,.9,cases);assert.equal((await gaps(f)).gaps[0].state,'retested');
});
test('model or indexing failures are operational errors rather than evidence of missing knowledge',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);f.modelError();await evaluate(f,.2);
  assert.equal((await gaps(f)).gaps.length,0);
});
test('same-second earlier success cannot clear a later failure when an unrelated question subsequently passes',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);const seconds=Math.floor(Date.now()/1000);
  f.sqlite.function('unixepoch',()=>seconds);
  await evaluate(f,.9);await evaluate(f,.2);
  await evaluate(f,.9,[{...f.cases[0],question:'A different question in the same second?'}]);
  assert.equal((await gaps(f)).gaps[0].state,'pending');
  await evaluate(f,.9);assert.equal((await gaps(f)).gaps[0].state,'retested');
});
test('gap filters apply before keyset pagination and reject malformed queries and unauthorized companies',async t=>{
  const f=await knowledgeReviewFixture();t.after(f.close);
  for(let i=0;i<22;i++)await evaluate(f,.2,[{...f.cases[0],question:`Question ${i}?`}]);
  const first=await gaps(f);assert.equal(first.gaps.length,20);assert.ok(first.nextAfter);
  const second=await gaps(f,`?after=${encodeURIComponent(first.nextAfter)}`);assert.equal(second.gaps.length,2);assert.equal(second.nextAfter,null);
  assert.equal(new Set([...first.gaps,...second.gaps].map(gap=>`${gap.jobId}:${gap.caseIndex}`)).size,22);
  assert.equal((await f.request('/gaps?after=ABCDEF00-0000-4000-8000-000000000001:0')).status,200);
  assert.equal((await gaps(f,'?storeId=store-b')).gaps.length,0);assert.equal((await gaps(f,'?language=ru')).gaps.length,0);
  assert.equal((await gaps(f,'?kind=policy')).gaps.length,0);assert.equal((await gaps(f,'?state=published')).gaps.length,0);
  for(const query of ['?state=bad','?after=bad','?language=en&language=ru','?namespace=other'])assert.equal((await f.request(`/gaps${query}`)).status,400);
  assert.equal((await f.request('/gaps',undefined,'staff')).status,403);assert.equal((await f.request('/gaps',undefined,'other')).status,404);
  assert.equal((await f.request('/gaps',undefined,'owner','other')).status,404);
  let revoked=false;f.after(sql=>{if(sql.includes('WITH failed_cases')&&!revoked){revoked=true;f.sqlite.prepare("UPDATE member SET role='member' WHERE id='admin'").run();}});
  assert.equal((await f.request('/gaps',undefined,'admin')).status,403);
});
