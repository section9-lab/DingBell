import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTranslationReservation, estimateTranslationUsage, freezeTranslationConfig } from '../src/modules/translations/config.ts';
import type { TranslationConfig, TranslationUsage } from '../src/modules/translations/types.ts';

function config():TranslationConfig {
  return {provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'synthetic-v1',promptVersion:'ru-v1',maxInputTokens:10,maxOutputTokens:20,
    pricing:{version:'synthetic-price-v1',currency:'USD',inputMicrosPerMillion:1_000_000,outputMicrosPerMillion:3_000_000,cacheReadMicrosPerMillion:100_000,cacheWriteMicrosPerMillion:2_000_000}};
}
const usage:TranslationUsage={input:10,output:20,cacheRead:100,cacheWrite:5};

test('translation configuration makes an immutable priced snapshot without mutating caller input',()=>{
  const input=config(),frozen=freezeTranslationConfig(input);
  assert.deepEqual(frozen,input);assert.notEqual(frozen,input);assert.notEqual(frozen.pricing,input.pricing);
  assert.ok(Object.isFrozen(frozen));assert.ok(Object.isFrozen(frozen.pricing));
  input.pricing.inputMicrosPerMillion=0;input.promptVersion='changed';
  assert.equal(frozen.pricing.inputMicrosPerMillion,1_000_000);assert.equal(frozen.promptVersion,'ru-v1');
});
test('unknown prices and malformed or ambiguous translation configuration fail closed',()=>{
  const {cacheReadMicrosPerMillion:_,...incomplete}=config().pricing;
  const bad:unknown[]=[null,{}, {...config(),pricing:null},{...config(),pricing:incomplete},{...config(),provider:'other'},
    {...config(),apiKey:'not-a-real-secret'},{...config(),pricing:{...config().pricing,currency:'RUB'}},
    ...['',' leading','trailing ','x\n','x\u0000','\ud800','x'.repeat(257)].map(model=>({...config(),model}))];
  for(const value of [-1,0,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'512'])bad.push({...config(),maxOutputTokens:value});
  for(const value of [-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,undefined])bad.push({...config(),pricing:{...config().pricing,inputMicrosPerMillion:value}});
  for(const value of bad)assert.throws(()=>freezeTranslationConfig(value),RangeError);
});
test('reservation uses the highest possible input category and rounds the combined estimate up once',()=>{
  assert.equal(estimateTranslationReservation(config()),80);
  const input=config();input.maxInputTokens=3;input.maxOutputTokens=2;
  input.pricing={...input.pricing,inputMicrosPerMillion:100_001,outputMicrosPerMillion:100_003,cacheReadMicrosPerMillion:600_001,cacheWriteMicrosPerMillion:400_001};
  assert.equal(estimateTranslationReservation(input),3);
  input.maxInputTokens=1;input.maxOutputTokens=1;
  input.pricing={...input.pricing,inputMicrosPerMillion:1,outputMicrosPerMillion:1,cacheReadMicrosPerMillion:1,cacheWriteMicrosPerMillion:1};
  assert.equal(estimateTranslationReservation(input),1);
});
test('usage charges all four leaf categories once and never clips usage to the reservation envelope',()=>{
  assert.equal(estimateTranslationUsage(config(),usage),90);
  const input=config();input.maxInputTokens=1;input.maxOutputTokens=1;
  assert.equal(estimateTranslationReservation(input),5);
  assert.equal(estimateTranslationUsage(input,usage),90);
  assert.deepEqual(usage,{input:10,output:20,cacheRead:100,cacheWrite:5});
});
test('explicit zero rates are accepted but missing usage or rates are never inferred as zero',()=>{
  const input=config();input.pricing={...input.pricing,inputMicrosPerMillion:0,outputMicrosPerMillion:0,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0};
  assert.equal(estimateTranslationReservation(input),0);assert.equal(estimateTranslationUsage(input,usage),0);
  for(const invalid of [null,{}, {...usage,input:undefined},{...usage,totalTokens:135},...[-1,0.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1].map(input=>({...usage,input}))])
    assert.throws(()=>estimateTranslationUsage(config(),invalid as TranslationUsage),RangeError);
});
test('estimation retains integer precision at the safe boundary and refuses unrepresentable totals',()=>{
  const input=config();input.maxInputTokens=Number.MAX_SAFE_INTEGER;input.maxOutputTokens=1;
  input.pricing={...input.pricing,inputMicrosPerMillion:1,outputMicrosPerMillion:1,cacheReadMicrosPerMillion:0,cacheWriteMicrosPerMillion:0};
  assert.equal(estimateTranslationReservation(input),9_007_199_255);
  input.pricing.inputMicrosPerMillion=1_000_000;input.pricing.outputMicrosPerMillion=1_000_000;
  assert.equal(estimateTranslationUsage(input,{input:Number.MAX_SAFE_INTEGER,output:0,cacheRead:0,cacheWrite:0}),Number.MAX_SAFE_INTEGER);
  assert.throws(()=>estimateTranslationUsage(input,{input:Number.MAX_SAFE_INTEGER,output:1,cacheRead:0,cacheWrite:0}),RangeError);
  assert.throws(()=>estimateTranslationReservation(input),RangeError);
});
test('cost entry points reject an unvalidated configuration instead of producing NaN or zero',()=>{
  for(const input of [null,{...config(),pricing:null},{...config(),maxInputTokens:-1}]){
    assert.throws(()=>estimateTranslationReservation(input as TranslationConfig),RangeError);
    assert.throws(()=>estimateTranslationUsage(input as TranslationConfig,usage),RangeError);
  }
});
