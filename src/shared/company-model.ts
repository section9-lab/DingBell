import * as v from 'valibot';
const label=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const apiKey=v.pipe(v.string(),v.minLength(1),v.maxLength(4096),v.check(s=>/^[\x21-\x7e]+$/.test(s)));
const version=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
export const companyModelCatalogCommandSchema=v.strictObject({expectedVersion:version,baseUrl:v.pipe(v.string(),v.minLength(1),v.maxLength(2048)),apiKey:v.optional(apiKey)});
export const companyModelCatalogSchema=v.strictObject({companyId:label,version,baseUrl:v.string(),models:v.pipe(v.array(label),v.maxLength(2000)),truncated:v.boolean()});
export type CompanyModelCatalogCommand=v.InferOutput<typeof companyModelCatalogCommandSchema>;
export type CompanyModelCatalog=v.InferOutput<typeof companyModelCatalogSchema>;
const amount=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(1_000_000_000_000));
export const modelExecutionLimits={input:{min:16384,max:1_000_000},output:{min:1,max:2048},generations:{min:1,max:8}} as const;
export const defaultModelGenerations=3;
export const modelExecutionSchema=v.strictObject({
  maxInputTokens:v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.input.min),v.maxValue(modelExecutionLimits.input.max)),
  maxOutputTokens:v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.output.min),v.maxValue(modelExecutionLimits.output.max)),
  maxGenerations:v.optional(v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.generations.min),v.maxValue(modelExecutionLimits.generations.max))),
  inputMicrosPerMillion:amount,outputMicrosPerMillion:amount,cacheReadMicrosPerMillion:amount,cacheWriteMicrosPerMillion:amount,
  // A saved connection and reviewed prices never silently authorize customer delivery.
  autoReply:v.optional(v.boolean(),false),
});
export const companyModelCommandSchema=v.strictObject({expectedVersion:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1)),
  baseUrl:v.pipe(v.string(),v.minLength(1),v.maxLength(2048)),model:label,
  apiKey:v.optional(apiKey),
  execution:v.nullable(modelExecutionSchema),
});
export const companyModelTestFailureSchema=v.picklist(['credentials_unavailable','url_rejected','unauthorized','forbidden','not_found','request_rejected','rate_limited','provider_unavailable','redirect_refused','timed_out','network_error','invalid_response','output_limit','tool_call_missing','tool_call_invalid','test_failed']);
export type CompanyModelTestFailure=v.InferOutput<typeof companyModelTestFailureSchema>;
export const companyModelViewSchema=v.strictObject({companyId:label,version:v.pipe(v.number(),v.integer(),v.minValue(0)),
  baseUrl:v.nullable(v.string()),model:v.nullable(label),hasKey:v.boolean(),encryptionConfigured:v.boolean(),runtimeEnabled:v.boolean(),
  execution:v.nullable(modelExecutionSchema),test:v.nullable(v.strictObject({status:v.picklist(['passed','failed','pending']),testedAt:v.string(),failureCode:v.optional(v.nullable(companyModelTestFailureSchema),null),providerStatus:v.optional(v.nullable(v.pipe(v.number(),v.integer(),v.minValue(100),v.maxValue(599))),null)}))});
export type ModelExecution=v.InferOutput<typeof modelExecutionSchema>;
export type CompanyModelCommand=v.InferOutput<typeof companyModelCommandSchema>;
export type CompanyModelView=v.InferOutput<typeof companyModelViewSchema>;
