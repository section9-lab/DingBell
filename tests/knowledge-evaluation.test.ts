import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync,readFileSync,existsSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const location='../probes/knowledge/evaluate.ts';
async function api() {
  const module=await import(location).catch(()=>({}));
  assert.equal(typeof module.prepareEvaluation,'function','The fixed semantic evaluation plan must be available');
  return module;
}
function oracle(plan:any) {
  const vector=(axis:number)=>Array.from({length:1024},(_,i)=>i===axis?1:0);
  return {datasetHash:plan.datasetHash,profile:plan.profile,model:plan.model,origin:'synthetic',rows:plan.entries.map((entry:any)=>{
    const item=entry.kind==='query'?plan.cases.find((item:any)=>item.key===entry.key):null;
    const id=item?item.expectedDocumentId:entry.documentId;
    return {key:entry.key,values:vector(id?plan.documents.findIndex((doc:any)=>doc.id===id):100)};
  })};
}
test('semantic plan is fixed, bilingual and uses only production chunks or questions as model inputs',async()=>{
  const {prepareEvaluation}=await api();const plan=await prepareEvaluation();
  assert.deepEqual(plan,await prepareEvaluation());assert.equal(plan.documents.length,12);assert.equal(plan.cases.length,36);
  assert.equal(plan.entries.length,48);assert.equal(new Set(plan.entries.map((item:any)=>item.key)).size,48);
  assert.equal(plan.cases.filter((item:any)=>item.expectedDocumentId===null).length,8);
  for(const item of plan.cases)assert.equal(plan.entries.find((entry:any)=>entry.key===item.key).text,item.question);
  for(const item of plan.cases) {
    assert.equal(item.referenceFact===null,item.expectedDocumentId===null);
    if(item.expectedDocumentId)assert.equal(plan.documents.find((doc:any)=>doc.id===item.expectedDocumentId).language,item.knowledgeLanguage);
  }
  for(const language of ['ru','zh-CN'])assert.equal(plan.cases.filter((item:any)=>item.queryLanguage===language).length,18);
  assert.ok(plan.totalInputBytes<32_000);
});
test('oracle embeddings check ranking arithmetic without claiming real model or answer quality',async()=>{
  const {prepareEvaluation,evaluateEmbeddings}=await api();const plan=await prepareEvaluation();
  const artifact=oracle(plan);const report=evaluateEmbeddings(plan,artifact);
  assert.equal(report.origin,'synthetic');assert.equal(report.answerQuality,'not_evaluated');
  assert.equal(report.cases.length,36);
  for(const group of [report.calibration,report.holdout]) {
    assert.equal(group.answerable,14);assert.equal(group.hitAt1,1);assert.equal(group.hitAt3,1);assert.equal(group.mrrAt3,1);
    assert.equal(group.unanswerable,4);assert.equal(group.unsupportedAboveThreshold,0);assert.equal(group.expectedBelowThreshold,0);
  }
  artifact.rows.reverse();assert.deepEqual(evaluateEmbeddings(plan,artifact),report,'row order must not silently pair vectors with different texts');
});
test('incomplete, duplicated, stale or invalid vectors cannot produce a quality report',async()=>{
  const {prepareEvaluation,evaluateEmbeddings}=await api();const plan=await prepareEvaluation();const good=oracle(plan);
  const bad=[{...good,datasetHash:'0'.repeat(64)},{...good,profile:'other-model'},{...good,model:'other-model'},
    {...good,rows:good.rows.slice(1)},{...good,rows:[good.rows[0],...good.rows.slice(0,-1)]},
    {...good,rows:good.rows.map((row:any,i:number)=>i?row:{...row,values:[1]})},
    {...good,rows:good.rows.map((row:any,i:number)=>i?row:{...row,values:Array(1024).fill(0)})},
    {...good,rows:good.rows.map((row:any,i:number)=>i?row:{...row,values:[NaN,...row.values.slice(1)]})}];
  for(const value of bad)assert.throws(()=>evaluateEmbeddings(plan,value),/KNOWLEDGE_EVAL_ARTIFACT_INVALID/);
});
test('incorrect nearest matches and unsupported questions stay visible in evaluation metrics',async()=>{
  const {prepareEvaluation,evaluateEmbeddings}=await api();const plan=await prepareEvaluation();const artifact=oracle(plan);
  const positive=plan.cases.find((item:any)=>item.expectedDocumentId&&item.split==='holdout');
  const wrong=plan.documents.find((doc:any)=>doc.language===positive.knowledgeLanguage&&doc.id!==positive.expectedDocumentId);
  artifact.rows.find((row:any)=>row.key===positive.key).values=artifact.rows.find((row:any)=>row.key===wrong.chunkKeys[0]).values;
  const unsupported=plan.cases.find((item:any)=>!item.expectedDocumentId&&item.split==='holdout');
  const candidate=plan.documents.find((doc:any)=>doc.language===unsupported.knowledgeLanguage);
  artifact.rows.find((row:any)=>row.key===unsupported.key).values=artifact.rows.find((row:any)=>row.key===candidate.chunkKeys[0]).values;
  const report=evaluateEmbeddings(plan,artifact);
  assert.ok(report.holdout.hitAt1<1);assert.equal(report.holdout.unsupportedAboveThreshold,1);
  assert.equal(report.cases.find((item:any)=>item.id===unsupported.id).expectedDocumentId,null);
  assert.equal(report.answerQuality,'not_evaluated');
});
test('collection persists each attempt before its model call and never retries an unknown batch',async()=>{
  const {prepareEvaluation,collectEmbeddings}=await api();const plan=await prepareEvaluation();const events:any[]=[];let calls=0;
  const ai={async run(model:string,input:{text:string[];truncate_inputs:boolean}) {
    calls++;assert.equal(events.at(-1).phase,'attempt');assert.equal(model,'@cf/baai/bge-m3');assert.equal(input.truncate_inputs,false);
    if(calls===2)throw new Error('synthetic private provider error');
    return {data:input.text.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0)),shape:[input.text.length,1024]};
  }};
  await assert.rejects(()=>collectEmbeddings(ai,plan,async(event:any)=>{events.push(event);}),/KNOWLEDGE_EVAL_COLLECTION_UNKNOWN/);
  assert.equal(calls,2);assert.deepEqual(events.map(item=>item.phase),['attempt','result','attempt','unknown']);
  assert.equal(JSON.stringify(events).includes('private provider'),false);
  let deniedCalls=0;
  await assert.rejects(()=>collectEmbeddings({run:async()=>{deniedCalls++;}},plan,async()=>{throw new Error('capture unavailable');}));
  assert.equal(deniedCalls,0);
  let uncapturedCalls=0;
  await assert.rejects(()=>collectEmbeddings({async run(_model:string,input:{text:string[]}) {
    uncapturedCalls++;return {data:input.text.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0))};
  }},plan,async(event:any)=>{if(event.phase==='result')throw new Error('capture unavailable');}));
  assert.equal(uncapturedCalls,1,'a lost result capture must prevent the next model batch');
});
test('successful collection binds all three batches to the prepared text identities',async()=>{
  const {prepareEvaluation,collectEmbeddings,evaluateEmbeddings}=await api();const plan=await prepareEvaluation();
  const events:any[]=[],inputs:string[]=[];
  const artifact=await collectEmbeddings({async run(_model:string,input:{text:string[]}) {
    assert.ok(input.text.length<=16);inputs.push(...input.text);
    return {data:input.text.map(()=>Array.from({length:1024},(_,i)=>i===0?1:0)),shape:[input.text.length,1024]};
  }},plan,async(event:any)=>{events.push(event);});
  assert.deepEqual(inputs,plan.entries.map((entry:any)=>entry.text));assert.equal(artifact.rows.length,48);
  assert.deepEqual(events.map(item=>item.phase),['attempt','result','attempt','result','attempt','result']);
  assert.equal(evaluateEmbeddings(plan,artifact).retrieval,'local_exact_cosine');
});
test('the evaluation CLI prepares and scores locally but requires opt-in before creating a live capture',async t=>{
  const {prepareEvaluation}=await api();const plan=await prepareEvaluation();
  const directory=mkdtempSync(join(tmpdir(),'dingbell-semantic-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const run=(...args:string[])=>spawnSync(process.execPath,['probes/knowledge/run.ts',...args],{
    encoding:'utf8',timeout:10_000,env:{...process.env,DINGBELL_KNOWLEDGE_EVAL:'',CLOUDFLARE_API_TOKEN:''},
  });
  const manifest=join(directory,'plan.json');let result=run('prepare',manifest);assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(readFileSync(manifest,'utf8')).datasetHash,plan.datasetHash);
  result=run('collect',join(directory,'live'));assert.notEqual(result.status,0);assert.equal(existsSync(join(directory,'live')),false);
  const existing=spawnSync(process.execPath,['probes/knowledge/run.ts','collect',directory],{encoding:'utf8',timeout:10_000,
    env:{...process.env,DINGBELL_KNOWLEDGE_EVAL:'1',CLOUDFLARE_API_TOKEN:'synthetic-token-not-for-network'}});
  assert.notEqual(existing.status,0);assert.equal(existsSync(join(directory,'batch-0-attempt.json')),false);
  const artifact=join(directory,'vectors.json'),report=join(directory,'report.json');writeFileSync(artifact,JSON.stringify(oracle(plan)));
  result=run('evaluate',artifact,report);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(report,'utf8')).answerQuality,'not_evaluated');
  const saved=readFileSync(report,'utf8');result=run('evaluate',artifact,report);assert.notEqual(result.status,0);assert.equal(readFileSync(report,'utf8'),saved);
  writeFileSync(artifact,' '.repeat(2*1024*1024+1));result=run('evaluate',artifact,join(directory,'large.json'));assert.notEqual(result.status,0);assert.equal(existsSync(join(directory,'large.json')),false);
});
