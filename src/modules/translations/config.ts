import * as v from 'valibot';
import type { TranslationConfig, TranslationUsage } from './types.ts';

const nonnegative=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const positive=v.pipe(nonnegative,v.minValue(1));
const label=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const configSchema=v.strictObject({
  provider:v.picklist(['nvidia','openai-compatible']),model:label,
  connection:v.optional(v.strictObject({companyId:label,revision:positive,baseUrl:v.pipe(v.string(),v.maxLength(2048),v.url())})),modelConfigVersion:label,promptVersion:label,maxInputTokens:positive,maxOutputTokens:positive,
  pricing:v.strictObject({version:label,currency:v.literal('USD'),inputMicrosPerMillion:nonnegative,outputMicrosPerMillion:nonnegative,cacheReadMicrosPerMillion:nonnegative,cacheWriteMicrosPerMillion:nonnegative}),
});
const usageSchema=v.strictObject({input:nonnegative,output:nonnegative,cacheRead:nonnegative,cacheWrite:nonnegative});

export function freezeTranslationConfig(value:unknown):TranslationConfig {
  const parsed=v.safeParse(configSchema,value);
  if(!parsed.success||(parsed.output.provider==='openai-compatible')!==(parsed.output.connection!==undefined))throw new RangeError('INVALID_TRANSLATION_CONFIG');
  if(parsed.output.connection)Object.freeze(parsed.output.connection);
  Object.freeze(parsed.output.pricing);
  return Object.freeze(parsed.output);
}
function micros(numerator:bigint):number {
  const rounded=(numerator+999_999n)/1_000_000n;
  if(rounded>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('TRANSLATION_COST_OVERFLOW');
  return Number(rounded);
}
export function estimateTranslationReservation(config:TranslationConfig):number {
  const {pricing:p,maxInputTokens,maxOutputTokens}=freezeTranslationConfig(config);
  const inputRate=Math.max(p.inputMicrosPerMillion,p.cacheReadMicrosPerMillion,p.cacheWriteMicrosPerMillion);
  return micros(BigInt(maxInputTokens)*BigInt(inputRate)+BigInt(maxOutputTokens)*BigInt(p.outputMicrosPerMillion));
}
export function estimateTranslationUsage(config:TranslationConfig,usage:TranslationUsage):number {
  const {pricing:p}=freezeTranslationConfig(config),parsed=v.safeParse(usageSchema,usage);
  if(!parsed.success)throw new RangeError('INVALID_TRANSLATION_USAGE');
  const u=parsed.output;
  return micros(BigInt(u.input)*BigInt(p.inputMicrosPerMillion)+BigInt(u.output)*BigInt(p.outputMicrosPerMillion)
    +BigInt(u.cacheRead)*BigInt(p.cacheReadMicrosPerMillion)+BigInt(u.cacheWrite)*BigInt(p.cacheWriteMicrosPerMillion));
}
