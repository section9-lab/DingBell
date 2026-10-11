import assert from 'node:assert/strict';
import {test} from 'node:test';
async function api(){const m=await import('../src/modules/ai-runs/configuration.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.parseSupportConfiguration,'function','production Support configuration must be validated before choosing a budget');return m!;}
const config={maxGenerations:3,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
test('answer submission is an explicit prompt version and does not change the old prompt contracts',async()=>{
 const m=await api(),p=await import('../src/modules/ai-runs/policy.ts');
 assert.equal(m.parseSupportConfiguration({...config,model:{...config.model,promptVersion:'support-answer-v1'}}).config.model.promptVersion,'support-answer-v1');
 assert.match(p.supportInstructions('support-answer-v1'),/submit_answer/);assert.match(p.supportInstructions('support-answer-v1'),/human review/i);
 for(const version of ['support-v1','support-knowledge-v1'])assert.doesNotMatch(p.supportInstructions(version),/submit_answer/);
 assert.throws(()=>p.validateSupportModel(m.parseSupportConfiguration({...config,model:{...config.model,promptVersion:'support-answer-v1'}}).config.model,262144,'intake-v1'));
});
test('automatic reply preparation has a separate validated prompt and cannot replace old draft contracts',async()=>{
 const m=await api(),p=await import('../src/modules/ai-runs/policy.ts');
 const parsed=m.parseSupportConfiguration({...config,model:{...config.model,promptVersion:'support-reply-v1'}});assert.equal(parsed.config.model.promptVersion,'support-reply-v1');
 assert.match(p.supportInstructions('support-reply-v1'),/prepare_reply/);assert.match(p.supportInstructions('support-reply-v1'),/never claim.*sent/i);
 assert.doesNotMatch(p.supportInstructions('support-reply-v1'),/submit_answer/);assert.doesNotMatch(p.supportInstructions('support-answer-v1'),/prepare_reply/);assert.match(p.supportInstructions('support-answer-v1'),/human review/i);
 for(const version of ['support-v1','support-knowledge-v1'])assert.doesNotMatch(p.supportInstructions(version),/prepare_reply/);
 assert.throws(()=>p.validateSupportModel(parsed.config.model,262144,'intake-v1'));
});
test('automatic reply configuration readiness requires all three switches without changing draft readiness',async()=>{
 const m=await api(),env={AI_RECEPTION_ENABLED:'true',AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true',NVAPI_KEY:'synthetic-private-value',CONVERSATION_CONTROLLER:{} as any,FLUE_SUPPORT_AGENT:{} as any,
  AI_RECEPTION_CONFIG_JSON:JSON.stringify({...config,model:{...config.model,promptVersion:'support-reply-v1'}})};
 assert.equal(m.supportConfigurationView(env).enabled,true);
 for(const flag of ['AI_RECEPTION_ENABLED','AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED'])for(const value of [undefined,'false','TRUE'])assert.equal(m.supportConfigurationView({...env,[flag]:value}).enabled,false,flag);
 assert.equal(m.supportConfigurationView({...env,AI_OUTBOUND_ENABLED:'false',OUTBOUND_ENABLED:'false',AI_RECEPTION_CONFIG_JSON:JSON.stringify({...config,model:{...config.model,promptVersion:'support-answer-v1'}})}).enabled,true);
});
test('Support configuration uses the installed model bounds and the same full-run reservation as the ledger',async()=>{
 const m=await api(),parsed=m.parseSupportConfiguration(config);assert.deepEqual(parsed.config,config);assert.equal(parsed.per,264192);assert.equal(parsed.total,792576);
 const free={...config,model:{...config.model,pricing:{...config.model.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}}};
 assert.equal(m.parseSupportConfiguration(free).total,0);assert.equal(m.parseSupportConfiguration(free).config.maxGenerations,3);
});
test('missing prices, unsupported models or versions, context under-reservation and unsafe bounds fail closed',async()=>{
 const m=await api();for(const value of [{...config,maxGenerations:0},{...config,maxGenerations:9},{...config,endpoint:'https://elsewhere.invalid'},...[
  {provider:'other'},{model:'unverified'},{modelConfigVersion:'support-v2'},{promptVersion:'support-v2'},{maxInputTokens:262143},{maxOutputTokens:2049},{maxOutputTokens:0},{pricing:undefined},{maxInputTokens:Number.MAX_SAFE_INTEGER,pricing:{...config.model.pricing,inputMicrosPerMillion:Number.MAX_SAFE_INTEGER}},
 ].map(patch=>({...config,model:{...config.model,...patch}}))])assert.throws(()=>m.parseSupportConfiguration(value));
});
test('public readiness reveals bounded configuration metadata, never the key or raw price configuration',async t=>{
 const m=await api(),fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('configuration inspection must not call the network');});
 const env={AI_RECEPTION_ENABLED:'true',NVAPI_KEY:'synthetic-private-value',AI_RECEPTION_CONFIG_JSON:JSON.stringify(config),CONVERSATION_CONTROLLER:{} as any,FLUE_SUPPORT_AGENT:{} as any};
 const result=m.supportConfigurationView(env);assert.equal(result.enabled,true);assert.equal(result.modelConfigured,true);assert.equal(result.pricesConfigured,true);assert.equal(result.runReservationMicros,792576);assert.equal(result.maxGenerations,3);
 assert.equal(JSON.stringify(result).includes(env.NVAPI_KEY),false);assert.equal(JSON.stringify(result).includes('inputMicrosPerMillion'),false);assert.equal(fetch.mock.callCount(),0);
 assert.equal(m.supportConfigurationView({...env,AI_RECEPTION_ENABLED:'false'}).enabled,false);assert.equal(m.supportConfigurationView({...env,NVAPI_KEY:' '}).modelConfigured,false);assert.equal(m.supportConfigurationView({...env,FLUE_SUPPORT_AGENT:undefined}).modelConfigured,false);
});
test('absent, malformed, oversized and incomplete configuration remains visibly unconfigured without a free fallback',async()=>{
 const m=await api();for(const raw of [undefined,'','{bad',JSON.stringify({model:config.model}),' '.repeat(32769)]){
  const data=m.supportConfigurationView({AI_RECEPTION_CONFIG_JSON:raw});assert.equal(data.pricesConfigured,false);assert.equal(data.model,null);assert.equal(data.runReservationMicros,null);assert.equal(data.perGenerationMicros,null);assert.equal(data.maxGenerations,null);
 }
});
