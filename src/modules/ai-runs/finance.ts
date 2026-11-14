import * as v from 'valibot';

/** Frozen model execution configuration for one AI run. */
export interface AiModelConfig {
  provider:'nvidia'|'openai-compatible';model:string;
  connection?:{companyId:string;revision:number;baseUrl:string};modelConfigVersion:string;promptVersion:string;
  // Conservative total of input + cacheRead + cacheWrite; not an SDK input limit.
  maxInputTokens:number;maxOutputTokens:number;
  pricing:{version:string;currency:'USD';inputMicrosPerMillion:number;outputMicrosPerMillion:number;cacheReadMicrosPerMillion:number;cacheWriteMicrosPerMillion:number};
}
export interface AiUsage {input:number;output:number;cacheRead:number;cacheWrite:number}
export interface AiReceipt {submissionId:string;uid:string;acceptedAt:string}

const nonnegative=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const positive=v.pipe(nonnegative,v.minValue(1));
const label=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const configSchema=v.strictObject({
  provider:v.picklist(['nvidia','openai-compatible']),model:label,
  connection:v.optional(v.strictObject({companyId:label,revision:positive,baseUrl:v.pipe(v.string(),v.maxLength(2048),v.url())})),modelConfigVersion:label,promptVersion:label,maxInputTokens:positive,maxOutputTokens:positive,
  pricing:v.strictObject({version:label,currency:v.literal('USD'),inputMicrosPerMillion:nonnegative,outputMicrosPerMillion:nonnegative,cacheReadMicrosPerMillion:nonnegative,cacheWriteMicrosPerMillion:nonnegative}),
});
const usageSchema=v.strictObject({input:nonnegative,output:nonnegative,cacheRead:nonnegative,cacheWrite:nonnegative});

export function freezeAiModelConfig(value:unknown):AiModelConfig {
  const parsed=v.safeParse(configSchema,value);
  if(!parsed.success||(parsed.output.provider==='openai-compatible')!==(parsed.output.connection!==undefined))throw new RangeError('INVALID_AI_CONFIG');
  if(parsed.output.connection)Object.freeze(parsed.output.connection);
  Object.freeze(parsed.output.pricing);
  return Object.freeze(parsed.output);
}
function micros(numerator:bigint):number {
  const rounded=(numerator+999_999n)/1_000_000n;
  if(rounded>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('AI_COST_OVERFLOW');
  return Number(rounded);
}
export function estimateAiReservation(config:AiModelConfig):number {
  const {pricing:p,maxInputTokens,maxOutputTokens}=freezeAiModelConfig(config);
  const inputRate=Math.max(p.inputMicrosPerMillion,p.cacheReadMicrosPerMillion,p.cacheWriteMicrosPerMillion);
  return micros(BigInt(maxInputTokens)*BigInt(inputRate)+BigInt(maxOutputTokens)*BigInt(p.outputMicrosPerMillion));
}
export function estimateAiUsage(config:AiModelConfig,usage:AiUsage):number {
  const {pricing:p}=freezeAiModelConfig(config),parsed=v.safeParse(usageSchema,usage);
  if(!parsed.success)throw new RangeError('INVALID_AI_USAGE');
  const u=parsed.output;
  return micros(BigInt(u.input)*BigInt(p.inputMicrosPerMillion)+BigInt(u.output)*BigInt(p.outputMicrosPerMillion)
    +BigInt(u.cacheRead)*BigInt(p.cacheReadMicrosPerMillion)+BigInt(u.cacheWrite)*BigInt(p.cacheWriteMicrosPerMillion));
}
