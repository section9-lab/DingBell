import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeFixture } from './fixtures/knowledge.ts';
import { claimKnowledgeVectorCleanups, queueStaleKnowledgeVectorCleanup, queueStaleKnowledgeVectorCleanups, repairKnowledgeVectorCleanups, runKnowledgeVectorCleanup } from '../src/modules/knowledge/vector-cleanup.ts';
import { knowledgeProfile } from '../src/modules/knowledge/vectorize.ts';

const hash=(character:string)=>character.repeat(64);

test('only stale revisions enter a fenced, retryable Vectorize deletion and D1 sources remain intact',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  f.sqlite.prepare(`INSERT INTO knowledge_document(organization_id,id,kind,store_id,product_ref,language,version,draft_revision,active_revision,mutation_id,updated_at)
    VALUES('company','doc','guide',NULL,NULL,'ru',2,2,NULL,'head',1)`).run();
  for(const revision of [1,2]) {
    f.sqlite.prepare(`INSERT INTO knowledge_revision(organization_id,document_id,revision,title,source_json,content_hash,status,index_profile,mutation_id,tested_at,published_profile,published_mutation_id,published_at,created_at,created_by)
      VALUES('company','doc',?,'Synthetic','{"format":"text","content":"synthetic"}',?,'ready',?,'accepted',1,?,'published',1,1,'owner')`)
      .run(revision,hash(revision===1?'a':'b'),knowledgeProfile.id,knowledgeProfile.id);
    f.sqlite.prepare(`INSERT INTO knowledge_chunk(organization_id,document_id,revision,id,ordinal,body,body_hash) VALUES('company','doc',?,?,0,'synthetic',?)`)
      .run(revision,hash(revision===1?'c':'d'),hash('e'));
  }
  assert.equal(await queueStaleKnowledgeVectorCleanup(f.db,'company','doc',2,1000),false,'current draft is never queued');
  assert.equal(await queueStaleKnowledgeVectorCleanups(f.db,1000,10),1,'bounded scanner finds only the stale revision');
  assert.equal(await queueStaleKnowledgeVectorCleanup(f.db,'company','doc',1,1000),false,'one persistent job fences duplicates');
  let jobs=(await claimKnowledgeVectorCleanups(f.db,'worker-a',1000,10)).results;assert.equal(jobs.length,1);assert.equal(jobs[0].state,'deleting');
  let deleted:string[]=[];let visible=true;
  const index={deleteByIds:async(ids:string[])=>{deleted=ids;return {mutationId:'delete-accepted'};},getByIds:async()=>visible?[{id:deleted[0]}]:[]} as unknown as Vectorize;
  assert.equal(await runKnowledgeVectorCleanup(f.db,index,jobs[0],'worker-a',1000),'confirming');assert.equal(deleted.length,2);
  assert.equal((await claimKnowledgeVectorCleanups(f.db,'too-early',5999,10)).results.length,0);
  jobs=(await claimKnowledgeVectorCleanups(f.db,'worker-b',6000,10)).results;assert.equal(jobs[0].state,'confirming');
  assert.equal(await runKnowledgeVectorCleanup(f.db,index,jobs[0],'worker-b',6000),'confirming','acceptance is not visibility');
  visible=false;jobs=(await claimKnowledgeVectorCleanups(f.db,'worker-c',10000,10)).results;assert.equal(jobs.length,1);
  assert.equal(await runKnowledgeVectorCleanup(f.db,index,jobs[0],'worker-c',10000),'succeeded');
  const state=f.sqlite.prepare("SELECT state,mutation_id,error_code FROM knowledge_vector_cleanup WHERE organization_id='company'").get();
  assert.deepEqual({...state},{state:'succeeded',mutation_id:'delete-accepted',error_code:null});
  assert.equal(f.sqlite.prepare("SELECT body FROM knowledge_chunk WHERE organization_id='company' AND document_id='doc' AND revision=1").get()!.body,'synthetic','cleanup deletes only duplicate vectors');
  await assert.rejects(()=>runKnowledgeVectorCleanup(f.db,index,jobs[0],'stale-token',10000),/KNOWLEDGE_CLEANUP_CLAIM_LOST/);
});

test('provider failures retain a generic retryable state without storing payloads',async t=>{
  const f=await knowledgeFixture();t.after(f.close);
  f.sqlite.prepare("INSERT INTO knowledge_document(organization_id,id,kind,language,version,draft_revision,mutation_id,updated_at) VALUES('company','doc','guide','ru',2,2,'head',1)").run();
  for(const revision of [1,2]) f.sqlite.prepare(`INSERT INTO knowledge_revision(organization_id,document_id,revision,title,source_json,content_hash,status,index_profile,created_at,created_by)
    VALUES('company','doc',?,'Synthetic','{"format":"text","content":"synthetic"}',?,'ready',?,1,'owner')`).run(revision,hash(revision===1?'a':'b'),knowledgeProfile.id);
  f.sqlite.prepare("INSERT INTO knowledge_chunk(organization_id,document_id,revision,id,ordinal,body,body_hash) VALUES('company','doc',1,?,0,'synthetic',?)").run(hash('c'),hash('d'));
  const index={deleteByIds:async()=>{throw new Error('secret provider payload');}} as unknown as Vectorize;
  await repairKnowledgeVectorCleanups({DB:f.db,KNOWLEDGE_INDEX:index,KNOWLEDGE_VECTOR_CLEANUP_ENABLED:'false'});
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM knowledge_vector_cleanup').get()!.n,0,'Cron is opt-in');
  await repairKnowledgeVectorCleanups({DB:f.db,KNOWLEDGE_INDEX:index,KNOWLEDGE_VECTOR_CLEANUP_ENABLED:'true'});
  const row=f.sqlite.prepare("SELECT state,error_code,claim_token,lease_until FROM knowledge_vector_cleanup").get();
  assert.deepEqual({...row},{state:'failed',error_code:'VECTOR_OPERATION_FAILED',claim_token:null,lease_until:null});
  assert.equal(JSON.stringify(row).includes('secret provider payload'),false);
});
