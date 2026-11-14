import * as v from 'valibot';
const label=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const apiKey=v.pipe(v.string(),v.minLength(1),v.maxLength(4096),v.check(s=>/^[\x21-\x7e]+$/.test(s)));
const version=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
const providerId=v.pipe(v.string(),v.minLength(1),v.maxLength(64),v.regex(/^[a-z0-9][a-z0-9-]*$/));
export const companyModelCatalogCommandSchema=v.strictObject({expectedVersion:version,baseUrl:v.pipe(v.string(),v.minLength(1),v.maxLength(2048)),apiKey:v.optional(apiKey)});
export const companyModelCatalogSchema=v.strictObject({companyId:label,version,baseUrl:v.string(),models:v.pipe(v.array(label),v.maxLength(2000)),truncated:v.boolean()});
export type CompanyModelCatalogCommand=v.InferOutput<typeof companyModelCatalogCommandSchema>;
export type CompanyModelCatalog=v.InferOutput<typeof companyModelCatalogSchema>;
const amount=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(1_000_000_000_000));
export const modelExecutionLimits={input:{min:16384,max:1_000_000},output:{min:1,max:2048},generations:{min:1,max:8}} as const;
export const defaultModelGenerations=6;
export const modelExecutionSchema=v.strictObject({
  maxInputTokens:v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.input.min),v.maxValue(modelExecutionLimits.input.max)),
  maxOutputTokens:v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.output.min),v.maxValue(modelExecutionLimits.output.max)),
  maxGenerations:v.optional(v.pipe(v.number(),v.integer(),v.minValue(modelExecutionLimits.generations.min),v.maxValue(modelExecutionLimits.generations.max))),
  inputMicrosPerMillion:amount,outputMicrosPerMillion:amount,cacheReadMicrosPerMillion:amount,cacheWriteMicrosPerMillion:amount,
  // Deprecated compatibility field for historical rows. New runs always use support-reply-v2;
  // the runtime ignores this value and the UI no longer exposes a draft mode.
  autoReply:v.optional(v.boolean()),
});
export const companyModelCommandSchema=v.strictObject({expectedVersion:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1)),
  provider:v.optional(providerId),
  baseUrl:v.optional(v.pipe(v.string(),v.minLength(1),v.maxLength(2048))),model:label,
  apiKey:v.optional(apiKey),
  authType:v.optional(v.picklist(['api_key','oauth'])),
  execution:v.nullable(modelExecutionSchema),
});
const providerModelSchema=v.strictObject({id:label,name:label,api:label,baseUrl:v.string(),contextWindow:v.pipe(v.number(),v.integer(),v.minValue(1)),input:v.array(label)});
export const companyModelProviderSchema=v.strictObject({id:providerId,name:label,authKinds:v.array(v.picklist(['api_key','oauth'])),supported:v.boolean(),models:v.array(providerModelSchema)});
export const companyModelProvidersSchema=v.strictObject({companyId:label,providers:v.array(companyModelProviderSchema)});
export const companyModelTestFailureSchema=v.picklist(['credentials_unavailable','url_rejected','unauthorized','forbidden','not_found','request_rejected','rate_limited','provider_unavailable','redirect_refused','timed_out','network_error','invalid_response','output_limit','tool_call_missing','tool_call_invalid','test_failed']);
export type CompanyModelTestFailure=v.InferOutput<typeof companyModelTestFailureSchema>;
export const companyModelOAuthStartSchema=v.strictObject({provider:v.picklist(['kimi-coding'])});
export type CompanyModelOAuthStart=v.InferOutput<typeof companyModelOAuthStartSchema>;
export const companyModelOAuthSessionSchema=v.strictObject({sessionId:label,provider:v.picklist(['kimi-coding']),
  status:v.picklist(['pending','complete','failed','expired']),userCode:label,verificationUri:v.pipe(v.string(),v.url()),
  intervalSeconds:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(60)),expiresAt:v.pipe(v.string(),v.isoTimestamp()),
  failureCode:v.optional(v.nullable(v.picklist(['oauth_denied','oauth_expired','oauth_unavailable','oauth_invalid_response','oauth_refresh_failed'])),null)});
export type CompanyModelOAuthSession=v.InferOutput<typeof companyModelOAuthSessionSchema>;
export const companyModelViewSchema=v.strictObject({companyId:label,version:v.pipe(v.number(),v.integer(),v.minValue(0)),
  provider:v.string(),baseUrl:v.nullable(v.string()),model:v.nullable(label),hasKey:v.boolean(),encryptionConfigured:v.boolean(),runtimeEnabled:v.boolean(),
  authType:v.optional(v.picklist(['api_key','oauth']),'api_key'),credentialExpiresAt:v.optional(v.nullable(v.pipe(v.string(),v.isoTimestamp())),null),
  execution:v.nullable(modelExecutionSchema),test:v.nullable(v.strictObject({status:v.picklist(['passed','failed','pending']),testedAt:v.string(),failureCode:v.optional(v.nullable(companyModelTestFailureSchema),null),providerStatus:v.optional(v.nullable(v.pipe(v.number(),v.integer(),v.minValue(100),v.maxValue(599))),null)}))});
export type ModelExecution=v.InferOutput<typeof modelExecutionSchema>;
export type CompanyModelCommand=v.InferOutput<typeof companyModelCommandSchema>;
export type CompanyModelAuthType=v.InferOutput<typeof companyModelCommandSchema>['authType'];
export type CompanyModelView=v.InferOutput<typeof companyModelViewSchema>;
export type CompanyModelProvider=v.InferOutput<typeof companyModelProviderSchema>;
export type CompanyModelProviders=v.InferOutput<typeof companyModelProvidersSchema>;
