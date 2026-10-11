import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import type {PreviewSql} from '../src/modules/translations/ledger.ts';
import type {AiExecution} from '../src/modules/ai-runs/storage.ts';
async function fixture(){
 const m=await import('../src/modules/ai-runs/ledger.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.SupportLedger,'function','native Support needs durable per-generation HTTP and closure evidence');
 const db=new DatabaseSync(':memory:'),sql:PreviewSql={exec(query,...values){const rows=db.prepare(query).all(...values as any[]);return {toArray:()=>rows as any[]};}};
 return {db,sql,ledger:new m!.SupportLedger(sql),restore:()=>new m!.SupportLedger(sql)};
}
function run(){return {id:'run',budgetId:'budget',agent:'Support',instanceId:'ai-support:run',dispatchKey:'run',payload:{schemaVersion:1,run:{scope:{organizationId:'org'}},target:{agent:'Support',instanceId:'ai-support:run',dispatchKey:'run'},modelInput:{untrustedCustomerQuestion:'question'}},modelInput:{untrustedCustomerQuestion:'question'},config:{maxGenerations:2,model:{promptVersion:'support-v1'}},reservedMicros:20,perGenerationMicros:10,createdAt:1,receipt:null,closure:null,generations:[],remainingReservedMicros:20,status:'open'} as unknown as AiExecution;}
const evidence={usage:{input:1,output:1,cacheRead:0,cacheWrite:0},usageReported:true,output:'',finishReason:'tool_calls',tools:true,complete:true};
const receipt={submissionId:'s',uid:'u',acceptedAt:'2026-10-10T00:00:00.000Z'};
test('durable cancellation prevents another HTTP or delivered tool without pretending runtime closure',async()=>{
 const f=await fixture();try{
  f.ledger.prepare(run());f.ledger.begin();f.ledger.spend(1);
  assert.equal(typeof f.ledger.cancel,'function','cancellation needs a durable barrier before native abort');
  const marker=f.ledger.cancel();assert.deepEqual(f.restore().cancel(),marker);assert.equal(f.restore().inspect()!.closed,false);
  assert.deepEqual(f.restore().inspect()!.cancellation,marker);assert.throws(()=>f.restore().begin());assert.throws(()=>f.restore().spend(1));
  f.restore().bindReceipt(receipt);f.restore().record(1,evidence);assert.throws(()=>f.restore().deliver(1));
  assert.deepEqual(f.restore().inspect()!.generations[0]!.evidence,evidence);assert.ok(f.restore().close().evidenceId);
 }finally{f.db.close();}
});
test('native preparation freezes the original plan and rejects reconstruction after financial permission or native receipt',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.ledger.begin());const value=run();f.ledger.prepare(value);value.modelInput.untrustedCustomerQuestion='mutated';assert.equal(f.ledger.inspect()!.run.modelInput.untrustedCustomerQuestion,'question');
  f.ledger.prepare(run());assert.throws(()=>f.ledger.prepare({...run(),budgetId:'other'}));
  const second=await fixture();try{assert.throws(()=>second.ledger.prepare({...run(),receipt}));assert.throws(()=>second.ledger.prepare({...run(),generations:[{} as any]}));}finally{second.db.close();}
 }finally{f.db.close();}
});
test('generation and HTTP permits persist, require known prior outcomes, and stop at the frozen limit',async()=>{
 const f=await fixture();try{
  f.ledger.prepare(run());assert.equal(f.ledger.begin(),1);f.ledger.spend(1);assert.throws(()=>f.restore().spend(1));assert.throws(()=>f.restore().begin());
  f.ledger.record(1,evidence);assert.throws(()=>f.ledger.begin(),'recorded bytes alone do not authorize another model turn');f.ledger.deliver(1);f.ledger.record(1,evidence);assert.throws(()=>f.ledger.record(1,{...evidence,output:'different'}));
  assert.equal(f.restore().begin(),2);f.ledger.spend(2);f.ledger.record(2,evidence);assert.throws(()=>f.restore().begin());assert.equal(f.restore().inspect()!.generations.length,2);
 }finally{f.db.close();}
});
test('native closure and receipt binding remain immutable while late usage can be recorded without reopening',async()=>{
 const f=await fixture();try{
  f.ledger.prepare(run());f.ledger.bindReceipt(receipt);f.ledger.bindReceipt(receipt);assert.throws(()=>f.ledger.bindReceipt({...receipt,uid:'changed'}));
  f.ledger.begin();f.ledger.spend(1);const marker=f.ledger.close();assert.deepEqual(f.restore().close(),marker);assert.ok(marker.evidenceId);assert.throws(()=>f.restore().begin());assert.throws(()=>f.restore().spend(1));
  f.restore().record(1,evidence);assert.equal(f.restore().inspect()!.closed,true);assert.deepEqual(f.restore().inspect()!.receipt,receipt);assert.deepEqual(f.restore().inspect()!.generations[0]!.evidence,evidence);
 }finally{f.db.close();}
});
