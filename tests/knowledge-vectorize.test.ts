import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as v from 'valibot';
import { knowledgeDraftSchema } from '../src/shared/knowledge.ts';
import { knowledgeHash, prepareKnowledge } from '../src/modules/knowledge/content.ts';
import { embedKnowledge, indexKnowledge, isKnowledgeVisible, queryKnowledge, knowledgeProfile, knowledgeManifest } from '../src/modules/knowledge/vectorize.ts';

const scope={kind:'guide' as const,storeId:'店铺'.repeat(50)+'A',productRef:'sku-white',language:'ru' as const};
async function manifest(orgId='company-a',storeId=scope.storeId) {
  const documentId='10000000-0000-4000-8000-000000000001',revision=1;
  const prepared=await prepareKnowledge(orgId,documentId,revision,{...scope,storeId},v.parse(knowledgeDraftSchema,{title:'说明',source:{format:'text',content:'白色款的宽度是26厘米。'}}));
  return { ...await knowledgeManifest(orgId,documentId,revision,{...scope,storeId},prepared), contentHash: prepared.contentHash };
}
const vector=()=>Array.from({length:1024},(_,i)=>i===0?1:0);

test('embedding uses the pinned multilingual profile and rejects malformed, truncated or unbounded results',async()=>{
  const calls:any[]=[];let data:any={data:[vector()],shape:[1,1024]};
  const ai={run:async(...args:unknown[])=>{calls.push(args);return data;}} as unknown as Ai;
  assert.equal((await embedKnowledge(ai,['合成测试']))[0].length,1024);
  assert.deepEqual(calls[0],[knowledgeProfile.model,{text:['合成测试'],truncate_inputs:false}]);
  for(const invalid of [{data:[],shape:[0,1024]},{data:[[1,2]],shape:[1,2]},{data:[vector(),vector()]},{data:[vector().map(()=>0)]},
    {data:[vector().map((x,i)=>i===2?NaN:x)]},{response:[]},{data:[vector()],shape:[1,512]},null,undefined]) {
    data=invalid;await assert.rejects(()=>embedKnowledge(ai,['合成测试']),/KNOWLEDGE_EMBEDDING_INVALID/);
  }
  const count=calls.length;
  for(const texts of [[],Array.from({length:17},()=>'.'),['中'.repeat(801)],['']]) await assert.rejects(()=>embedKnowledge(ai,texts),/KNOWLEDGE_INPUT_LIMIT/);
  assert.equal(calls.length,count);
});

test('index manifests hash long scope IDs and bind every vector to its tenant, revision and source hash',async()=>{
  const a=await manifest(),b=await manifest('company-b'),longOther=await manifest('company-a','店铺'.repeat(50)+'B');
  assert.notEqual(a.namespace,b.namespace);assert.notEqual(a.chunks[0].id,b.chunks[0].id);
  assert.notEqual(a.scopeKey,longOther.scopeKey);assert.equal(a.scopeKey.length,64);assert.equal(a.namespace.length,64);
  let written:any[]=[];const index={upsert:async(rows:any[])=>{written=rows;return {mutationId:'accepted-not-visible'};}} as unknown as Vectorize;
  assert.equal(await indexKnowledge(index,a,[vector()]),'accepted-not-visible');
  assert.equal(written[0].namespace,a.namespace);assert.equal(written[0].metadata.eligible,false);
  assert.equal(written[0].metadata.bodyHash,a.chunks[0].bodyHash);assert.equal(written[0].metadata.revision,a.revisionKey);
  assert.equal('body' in written[0].metadata,false);assert.equal(JSON.stringify(written).includes('白色款'),false);
  await assert.rejects(()=>indexKnowledge(index,a,[[1,2]]),/KNOWLEDGE_EMBEDDING_INVALID/);
});

test('write acceptance never proves visibility; missing, duplicate and stale metadata fail the readiness check',async()=>{
  const a=await manifest();let records:any[]=[];let matches:any[]=[];const queries:any[]=[];
  const index={upsert:async(rows:any[])=>{records=rows;return {mutationId:'accepted'};},queryById:async(...args:any[])=>{queries.push(args);return {matches};}} as unknown as Vectorize;
  await indexKnowledge(index,a,[vector()]);assert.equal(await isKnowledgeVisible(index,a),false);
  matches=records.map(({values,...row})=>({...row,score:1}));assert.equal(await isKnowledgeVisible(index,a),true);
  assert.equal(queries[0][1].namespace,a.namespace);assert.equal(queries[0][1].filter.revision,a.revisionKey);
  assert.equal(queries[0][1].filter.eligible,false);
  const good=structuredClone(matches);
  for(const altered of [[...good,...good],[{...good[0],namespace:'other'}],[{...good[0],metadata:{...good[0].metadata,bodyHash:'a'.repeat(64)}}],
    [{...good[0],metadata:{...good[0].metadata,revision:'old'}}],[{...good[0],metadata:{...good[0].metadata,eligible:true}}]]) {
    matches=altered;assert.equal(await isKnowledgeVisible(index,a),false);
  }
});

test('published candidate queries apply server scope and return references without trusting provider text',async()=>{
  const a=await manifest();let records:any[]=[];const calls:any[]=[];
  const index={upsert:async(rows:any[])=>{records=rows;return {mutationId:'accepted'};},query:async(...args:any[])=>{calls.push(args);return {matches:records.map(({values,...row})=>({...row,score:.9,metadata:{...row.metadata,body:'malicious provider text'}}))};}} as unknown as Vectorize;
  await indexKnowledge(index,a,[vector()],true);
  const result=await queryKnowledge(index,'company-a',{storeId:scope.storeId,productRef:scope.productRef,language:'ru'},vector(),[a]);
  assert.equal(calls[0][1].namespace,a.namespace);assert.equal(calls[0][1].filter.eligible,true);
  assert.deepEqual(calls[0][1].filter.scope,{$in:['all',a.scopeKey]});assert.deepEqual(calls[0][1].filter.product,{$in:['all',a.productKey]});
  assert.equal(result.length,1);assert.equal(result[0].chunkId,a.chunks[0].id);assert.equal('body' in result[0],false);
  assert.equal(result[0].bodyHash,await knowledgeHash(a.chunks[0].body));
  records[0].metadata.scope=await knowledgeHash('unauthorized store');
  await assert.rejects(()=>queryKnowledge(index,'company-a',{storeId:scope.storeId,productRef:scope.productRef,language:'ru'},vector(),[a]),/KNOWLEDGE_INDEX_INVALID/);
  records[0].metadata.scope=[a.scopeKey];
  await assert.rejects(()=>queryKnowledge(index,'company-a',{storeId:scope.storeId,productRef:scope.productRef,language:'ru'},vector(),[a]),/KNOWLEDGE_INDEX_INVALID/);
});
