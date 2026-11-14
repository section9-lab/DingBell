import assert from 'node:assert/strict';
import {test} from 'node:test';
async function api(){const m=await import('../src/modules/ai-runs/configuration.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.parseSupportConfiguration,'function','production Support configuration must be validated before choosing a budget');return m!;}
const config={maxGenerations:3,model:{provider:'nvidia',model:'nvidia/nemotron-3.5-super-vl-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}};
test('the direct reply prompt is the only answer configuration and never claims delivery',async()=>{
 const m=await api(),p=await import('../src/modules/ai-runs/policy.ts');
 const parsed=m.parseSupportConfiguration({...config,model:{...config.model,promptVersion:'support-reply-v2'}});assert.equal(parsed.config.model.promptVersion,'support-reply-v2');
 assert.match(p.supportInstructions('support-reply-v2'),/send_message/);assert.match(p.supportInstructions('support-reply-v2'),/never claim.*sent/i);
 assert.doesNotMatch(p.supportInstructions('support-v1'),/send_message/);
 assert.throws(()=>p.validateSupportModel(parsed.config.model,262144,'intake-v1'));
});
test('the v2 reply agent validates read/bash/fact/send tools without touching the v1 contract',async()=>{
 const m=await api(),p=await import('../src/modules/ai-runs/policy.ts');
 const parsed=m.parseSupportConfiguration({...config,model:{...config.model,promptVersion:'support-reply-v2'}});assert.equal(parsed.config.model.promptVersion,'support-reply-v2');
 const instructions=p.supportInstructions('support-reply-v2');
 for(const tool of ['bash','read','send_message','get_product_info','get_order_status','request_handoff'])assert.match(instructions,new RegExp(tool));
 assert.doesNotMatch(instructions,/prepare_reply/);
 assert.throws(()=>p.validateSupportModel(parsed.config.model,262144,'intake-v1'));
});
test('automatic reply configuration readiness requires all three switches',async()=>{
 const m=await api(),env={AI_OUTBOUND_ENABLED:'true',OUTBOUND_ENABLED:'true',NVAPI_KEY:'synthetic-private-value',CONVERSATION_CONTROLLER:{} as any,AGENT_RUNTIME:{} as any,
  AI_RECEPTION_CONFIG_JSON:JSON.stringify({...config,model:{...config.model,promptVersion:'support-reply-v2'}})};
 assert.equal(m.supportConfigurationView(env).enabled,true);
 for(const flag of ['AI_OUTBOUND_ENABLED','OUTBOUND_ENABLED'])for(const value of [undefined,'false','TRUE'])assert.equal(m.supportConfigurationView({...env,[flag]:value}).enabled,false,flag);
});
test('Support configuration uses the installed model bounds and the same full-run reservation as the ledger',async()=>{
 const m=await api(),parsed=m.parseSupportConfiguration(config);assert.deepEqual(parsed.config,config);assert.equal(parsed.per,264192);assert.equal(parsed.total,792576);
 const free={...config,model:{...config.model,pricing:{...config.model.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0}}};
 assert.equal(m.parseSupportConfiguration(free).total,0);assert.equal(m.parseSupportConfiguration(free).config.maxGenerations,3);
});
test('missing prices, unsupported models or versions, context under-reservation and unsafe bounds fail closed',async()=>{
 const m=await api();for(const value of [{...config,maxGenerations:0},{...config,maxGenerations:9},{...config,endpoint:'https://elsewhere.invalid'},...[
  {provider:'other'},{model:'unverified'},{modelConfigVersion:'support-v2'},{promptVersion:'support-v2'},{promptVersion:'support-reply-v1'},{promptVersion:'support-knowledge-v1'},{maxInputTokens:262143},{maxOutputTokens:2049},{maxOutputTokens:0},{pricing:undefined},{maxInputTokens:Number.MAX_SAFE_INTEGER,pricing:{...config.model.pricing,inputMicrosPerMillion:Number.MAX_SAFE_INTEGER}},
 ].map(patch=>({...config,model:{...config.model,...patch}}))])assert.throws(()=>m.parseSupportConfiguration(value));
});
test('public readiness reveals bounded configuration metadata, never the key or raw price configuration',async t=>{
 const m=await api(),fetch=t.mock.method(globalThis,'fetch',async()=>{throw new Error('configuration inspection must not call the network');});
 const env={NVAPI_KEY:'synthetic-private-value',AI_RECEPTION_CONFIG_JSON:JSON.stringify(config),CONVERSATION_CONTROLLER:{} as any,AGENT_RUNTIME:{} as any};
 const result=m.supportConfigurationView(env);assert.equal(result.enabled,true);assert.equal(result.modelConfigured,true);assert.equal(result.pricesConfigured,true);assert.equal(result.runReservationMicros,792576);assert.equal(result.maxGenerations,3);
 assert.equal(JSON.stringify(result).includes(env.NVAPI_KEY),false);assert.equal(JSON.stringify(result).includes('inputMicrosPerMillion'),false);assert.equal(fetch.mock.callCount(),0);
 assert.equal(m.supportConfigurationView({...env,AI_RECEPTION_CONFIG_JSON:undefined}).enabled,false);assert.equal(m.supportConfigurationView({...env,NVAPI_KEY:' '}).modelConfigured,false);assert.equal(m.supportConfigurationView({...env,AGENT_RUNTIME:undefined}).modelConfigured,false);
});
test('absent, malformed, oversized and incomplete configuration remains visibly unconfigured without a free fallback',async()=>{
 const m=await api();for(const raw of [undefined,'','{bad',JSON.stringify({model:config.model}),' '.repeat(32769)]){
  const data=m.supportConfigurationView({AI_RECEPTION_CONFIG_JSON:raw});assert.equal(data.pricesConfigured,false);assert.equal(data.model,null);assert.equal(data.runReservationMicros,null);assert.equal(data.perGenerationMicros,null);assert.equal(data.maxGenerations,null);
 }
});
