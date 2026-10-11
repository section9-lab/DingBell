import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import * as v from 'valibot';
import {replyTestOutputSchema} from '../src/modules/reply-tests/service.ts';
import {validateReplyTestConfig} from '../src/modules/reply-tests/policy.ts';
import {prepareReplyQuality} from '../probes/reply-quality/evaluate.ts';
async function api(){const m=await import('../src/modules/reply-tests/output.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.replyTestSampling,'function','output constraints must have a frozen model configuration version');return m!;}
test('old model configurations keep their payload and unknown output formats fail closed',async()=>{
  const m=await api();assert.deepEqual(m.replyTestSampling('nvidia-reply-test-v1'),{tool_choice:'none',chat_template_kwargs:{enable_thinking:false}});assert.throws(()=>m.replyTestSampling('unknown'),/REPLY_TEST_CONFIG_UNSUPPORTED/);
  const c={provider:'nvidia' as const,model:'nvidia/nemotron-3-super-120b-a12b',promptVersion:'grounded-reply-v2',maxInputTokens:262144,maxOutputTokens:2048,pricing:{version:'synthetic',currency:'USD' as const,inputMicrosPerMillion:1,outputMicrosPerMillion:1,cacheReadMicrosPerMillion:1,cacheWriteMicrosPerMillion:1}};
  assert.doesNotThrow(()=>validateReplyTestConfig({...c,modelConfigVersion:'nvidia-reply-test-v2'},262144));assert.throws(()=>validateReplyTestConfig({...c,modelConfigVersion:'unknown'},262144));
});
test('guided schema carries strict branch and citation constraints but local validation remains authoritative',async()=>{
  const m=await api(),sampling=m.replyTestSampling('nvidia-reply-test-v2'),schema=sampling.guided_json as any;
  assert.equal(createHash('sha256').update(JSON.stringify(sampling)).digest('hex'),'9c2b7fb1b95501405b8cac442fc299032a3b51e5a5a0fdfb69329e3eb7639fe0','a changed provider schema requires a new model configuration version');
  assert.equal(sampling.tool_choice,'none');assert.equal(sampling.chat_template_kwargs.enable_thinking,false);assert.equal(schema.oneOf.length,3);
  for(const branch of schema.oneOf){assert.equal(branch.additionalProperties,false);assert.ok(branch.required.includes('body'));assert.equal(branch.properties.body.minLength,1);assert.equal(branch.properties.body.maxLength,1000);}
  const answer=schema.oneOf.find((s:any)=>s.properties.kind.const==='answer'),source=answer.properties.sources;
  assert.deepEqual(source.items.required,['chunkId','quote']);assert.equal(source.items.additionalProperties,false);assert.equal(source.minItems,1);assert.equal(source.maxItems,10);assert.equal(source.items.properties.chunkId.pattern,'^[a-f0-9]{64}$');assert.equal(source.items.properties.quote.maxLength,2400);
  assert.equal(v.is(replyTestOutputSchema,{kind:'clarify',body:'   '}),false);assert.equal(v.is(replyTestOutputSchema,{kind:'clarify',body:'x\u0000'}),false);
  const citation={chunkId:'a'.repeat(64),quote:'evidence'};assert.equal(v.is(replyTestOutputSchema,{kind:'answer',body:'reply',sources:[citation,citation]}),false);
  schema.oneOf.length=0;assert.equal((m.replyTestSampling('nvidia-reply-test-v2').guided_json as any).oneOf.length,3,'callers cannot mutate the frozen contract');
});
test('evaluation output-format changes are explicit and cannot alter archived v1/v2 corpora',async()=>{
  const legacy=await prepareReplyQuality();assert.equal(legacy.datasetHash,'3b36f48cf75ed162c7065d99791e334ba270cf2f90c63b150cababcf0f7294af');
  const structured=await prepareReplyQuality('grounded-reply-v2','nvidia-reply-test-v2');assert.notEqual(structured.datasetHash,legacy.datasetHash);assert.deepEqual(structured.cases,legacy.cases);assert.equal(structured.promptHash,legacy.promptHash);assert.equal(structured.modelConfigVersion,'nvidia-reply-test-v2');
  const m=await api();assert.deepEqual(structured.samplingParams,m.replyTestSampling('nvidia-reply-test-v2'));await assert.rejects(()=>prepareReplyQuality('grounded-reply-v2','unknown'));
});
