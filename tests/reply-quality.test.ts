import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
async function api(){const m=await import('../probes/reply-quality/evaluate.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.prepareReplyQuality,'function','answer quality requires a fixed versioned corpus and the production prompt');return m!;}
test('prompt revisions preserve v1 byte for byte and cannot silently substitute an unknown or old run version',async()=>{
  const prompt=await import('../src/modules/reply-tests/prompt.ts');assert.equal(typeof prompt.getReplyTestInstructions,'function','frozen runs must select their own prompt version');
  assert.equal(createHash('sha256').update(JSON.stringify(prompt.getReplyTestInstructions('grounded-reply-v1'))).digest('hex'),'26606d1acabdb6ac732149d04ddd47fd4425262e6188c599f3cd764686bc0f99');
  assert.notEqual(prompt.getReplyTestInstructions('grounded-reply-v2'),prompt.getReplyTestInstructions('grounded-reply-v1'));assert.throws(()=>prompt.getReplyTestInstructions('missing'));
  const m=await api();assert.equal((await m.prepareReplyQuality('grounded-reply-v1')).datasetHash,'fee85d13b7e0aae4418ede9b83f43bf8e24cb542eb76f27e21867bb3c191f68b');assert.notEqual((await m.prepareReplyQuality('grounded-reply-v2')).datasetHash,(await m.prepareReplyQuality('grounded-reply-v1')).datasetHash);
});
test('the fixed corpus has 200 distinct bounded cases in 40 disclosed families with reference facts and decisions',async()=>{
  const m=await api(),plan=await m.prepareReplyQuality();assert.equal(plan.cases.length,200);assert.equal(new Set(plan.cases.map(c=>c.id)).size,200);assert.equal(new Set(plan.cases.map(c=>c.family)).size,40);
  for(const [stage,n]of [['presale',60],['sale',50],['aftersale',50],['safety',40]] as const)assert.equal(plan.cases.filter(c=>c.category===stage).length,n);
  assert.equal(plan.datasetHash,(await m.prepareReplyQuality()).datasetHash);
  for(const c of plan.cases){assert.ok(c.reference.length>0);assert.ok(c.manualChecks.length>0);assert.ok(c.input.question.length<=1000);assert.ok(c.input.untrustedKnowledge.every(k=>k.body.length<=2400));assert.ok(c.expected.kind!=='answer'||c.input.untrustedKnowledge.length>0);}
});
test('objective evaluation distinguishes traceable JSON from semantic quality and never treats a handoff suggestion as an executed action',async()=>{
  const m=await api(),plan=await m.prepareReplyQuality(),c=plan.cases.find(c=>c.expected.kind==='answer')!,k=c.input.untrustedKnowledge[0];
  const output={kind:'answer',body:c.reference,sources:[{chunkId:k.chunkId,quote:k.body}]};const good=m.checkReplyQuality(c,JSON.stringify(output));assert.equal(good.contractPassed,true);assert.equal(good.semanticReview,'pending');assert.equal(good.handoffExecuted,false);
  assert.ok(m.checkReplyQuality(c,JSON.stringify({...output,sources:[{chunkId:'0'.repeat(64),quote:k.body}]})).failures.includes('citation_not_in_input'));
  assert.ok(m.checkReplyQuality(c,JSON.stringify({...output,sources:[{chunkId:k.chunkId,quote:'invented excerpt'}]})).failures.includes('quote_not_in_source'));
  assert.ok(m.checkReplyQuality(c,'```json\n{}\n```').failures.includes('invalid_output'));
  const handoff=plan.cases.find(c=>c.expected.kind==='handoff')!;assert.ok(m.checkReplyQuality(handoff,JSON.stringify(output)).failures.includes('unexpected_decision'));
});
test('selection and reports reject duplicate, foreign and changed cases without silently grading incomplete evidence as a release',async()=>{
  const m=await api(),plan=await m.prepareReplyQuality();assert.throws(()=>m.selectReplyQuality(plan,[],1));assert.throws(()=>m.selectReplyQuality(plan,[plan.cases[0].id,plan.cases[0].id],1));assert.throws(()=>m.selectReplyQuality(plan,['missing'],1));assert.throws(()=>m.selectReplyQuality(plan,[plan.cases[0].id],4));
  const selected=m.selectReplyQuality(plan,[plan.cases[0].id],1);assert.equal(selected.length,1);assert.equal(selected[0].caseId,plan.cases[0].id);
  const report=m.summarizeReplyQuality(plan,[]);assert.equal(report.releaseReady,false);assert.equal(report.missingCases,200);assert.equal(report.humanReview,'pending');
});
test('the real collector requires explicit bounded selection and the existing official NVIDIA trial key',async()=>{
  const m=await api(),plan=await m.prepareReplyQuality(),env={DINGBELL_REPLY_QUALITY:'1',DINGBELL_REPLY_CASES:plan.cases[0].id,DINGBELL_REPLY_REPEAT:'1',NVAPI_KEY:'synthetic-key',NVAPI_URL:'https://integrate.api.nvidia.com'};
  assert.equal(m.readReplyQualityConfig(env,plan).selected.length,1);
  for(const patch of [{DINGBELL_REPLY_QUALITY:'0'},{DINGBELL_REPLY_CASES:''},{DINGBELL_REPLY_CASES:plan.cases.slice(0,25).map(c=>c.id).join(',')},{DINGBELL_REPLY_REPEAT:'4'},{NVAPI_KEY:''},{NVAPI_URL:'https://other.invalid'}])assert.throws(()=>m.readReplyQualityConfig({...env,...patch},plan));
});
test('captured evidence must match the exact result; malformed usage, duplicate runs and drift cannot inflate metrics',async()=>{
  const m=await api(),plan=await m.prepareReplyQuality(),c=plan.cases[0],output=JSON.stringify({kind:'answer',body:'Ширина 26 см.',sources:[{chunkId:c.input.untrustedKnowledge[0].chunkId,quote:'26 см.'}]});
  const r={caseId:c.id,repeat:1,datasetHash:plan.datasetHash,promptHash:plan.promptHash,model:plan.model,origin:'synthetic' as const,instanceId:'test',receipt:null,startedAt:new Date().toISOString(),elapsedMs:2,httpRequests:1,modelCalls:1,status:'completed' as const,output,httpStatuses:[200],evidence:{output,usage:{input:2,output:3,cacheRead:0,cacheWrite:0},usageReported:true,finishReason:'stop',complete:true,tools:false}};
  assert.equal(m.summarizeReplyQuality(plan,[r]).contractPassed,1);assert.equal(m.summarizeReplyQuality(plan,[r]).releaseReady,false);
  for(const patch of [{datasetHash:'wrong'},{model:'wrong'},{httpRequests:2},{repeat:0},{elapsedMs:-1},{status:'invented'},{evidence:{...r.evidence,output:'changed'}},{evidence:{...r.evidence,usage:{...r.evidence.usage,input:-1}}}])assert.throws(()=>m.summarizeReplyQuality(plan,[{...r,...patch}] as any));
  assert.throws(()=>m.summarizeReplyQuality(plan,[r,r]));
});
