import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PreviewLedger,type PreviewSql } from '../src/modules/translations/ledger.ts';
import type { TranslationRun } from '../src/modules/translations/types.ts';
const run:TranslationRun={id:'run',requestId:'request',organizationId:'org',storeId:'store',conversationId:'conversation',actorUserId:'user',actorMemberId:'member',source:'你好',sourceHash:'a'.repeat(64),sourceRevision:1,budgetId:'budget',reservedMicros:1,createdAt:1,
  config:{provider:'nvidia',model:'synthetic',modelConfigVersion:'v1',promptVersion:'v1',maxInputTokens:1,maxOutputTokens:1,pricing:{version:'v1',currency:'USD',inputMicrosPerMillion:1,outputMicrosPerMillion:1,cacheReadMicrosPerMillion:1,cacheWriteMicrosPerMillion:1}},receipt:null,settlement:'held',usage:null,chargedMicros:null,settledAt:null,releaseEvidence:null,providerRequestClaimedAt:null};
function fixture(){const db=new DatabaseSync(':memory:');const sql:PreviewSql={exec(query,...bindings){const rows=db.prepare(query).all(...bindings as (string|number|null)[]);return {toArray:()=>rows as Record<string,unknown>[]};}};return {db,sql,ledger:new PreviewLedger(sql)};}
test('unprepared execution cannot spend and immutable preparation cannot be rebound',()=>{
  const f=fixture();try{
    assert.throws(()=>f.ledger.spend('generation'));f.ledger.prepare(run);f.ledger.prepare({...run,providerRequestClaimedAt:2});
    assert.equal(f.ledger.inspect()?.run.source,'你好');assert.throws(()=>f.ledger.prepare({...run,source:'different'}));assert.throws(()=>f.ledger.prepare({...run,actorMemberId:'other'}));
  }finally{f.db.close();}
});
test('each local generation and HTTP permission survives a new ledger object and cannot be spent twice',()=>{
  const f=fixture();try{
    f.ledger.prepare(run);f.ledger.spend('generation');f.ledger.spend('http');const restored=new PreviewLedger(f.sql);
    assert.equal(restored.inspect()?.generation,1);assert.equal(restored.inspect()?.http,1);assert.throws(()=>restored.spend('generation'));assert.throws(()=>restored.spend('http'));
  }finally{f.db.close();}
});
test('zero-request closing is durable and denies later execution rather than recycling permission',()=>{
  const f=fixture();try{
    f.ledger.prepare(run);const proof=f.ledger.close();assert.equal(proof.providerRequests,0);assert.equal(proof.instanceId,'reply-preview:run');assert.equal(proof.executionClosed,true);
    assert.deepEqual(new PreviewLedger(f.sql).close(),proof);assert.throws(()=>f.ledger.spend('generation'));assert.throws(()=>f.ledger.spend('http'));
  }finally{f.db.close();}
});
test('a spent or missing local authority cannot fabricate zero-request evidence',()=>{
  const f=fixture();try{assert.throws(()=>f.ledger.close());f.ledger.prepare(run);f.ledger.spend('http');assert.throws(()=>f.ledger.close());}finally{f.db.close();}
});
test('a fresh local ledger cannot re-prepare a run already claimed or associated with native execution',()=>{
  for(const value of [{...run,providerRequestClaimedAt:2},{...run,receipt:{submissionId:'s',uid:'u',acceptedAt:'2026-10-10T00:00:00.000Z'}}]){
    const f=fixture();try{assert.throws(()=>f.ledger.prepare(value));}finally{f.db.close();}
  }
});
