import * as v from 'valibot';
const nullableText=v.nullable(v.string());
export const pushEventTypes=['TYPE_NEW_MESSAGE','TYPE_UPDATE_MESSAGE','TYPE_MESSAGE_READ','TYPE_CHAT_CLOSED','TYPE_CREATE_OR_UPDATE_ITEM','TYPE_STOCKS_CHANGED','TYPE_PRICE_INDEX_CHANGED','TYPE_NEW_POSTING','TYPE_POSTING_CANCELLED','TYPE_STATE_CHANGED','TYPE_CUTOFF_DATE_CHANGED','TYPE_DELIVERY_DATE_CHANGED'] as const;
export const pushSources=['chat','products','fbs_postings','fbo_postings','fbp_postings'] as const;
export const pushStateSchema=v.picklist(['pending','processing','retry','completed','ignored','failed']);
export const pushEventSchema=v.object({id:v.string(),notificationType:v.string(),source:v.string(),target:v.string(),state:pushStateSchema,attempts:v.number(),nextAttemptAt:v.string(),receivedAt:v.string(),lastError:nullableText,simulated:v.boolean(),requiresReview:v.boolean()});
export const pushViewSchema=v.object({storeId:v.string(),revision:v.number(),generation:v.number(),mode:v.picklist(['unconfigured','prepared','active','paused']),sellerId:nullableText,observedSellerId:nullableText,lastPingAt:nullableText,lastReceivedAt:nullableText,lastSimulationAt:nullableText,lastProcessedAt:nullableText,cutoverAt:nullableText,localSimulationAllowed:v.boolean(),reviewCount:v.number(),callbackUrl:v.optional(v.string()),queue:v.object({pending:v.number(),processing:v.number(),retry:v.number(),completed:v.number(),ignored:v.number(),failed:v.number()}),events:v.array(pushEventSchema)});
export type PushView=v.InferOutput<typeof pushViewSchema>;
const revision=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1));
export const pushCommandSchema=v.variant('operation',[
 v.strictObject({operation:v.literal('prepare'),expectedRevision:revision,sellerId:v.optional(v.pipe(v.string(),v.regex(/^(0|[1-9][0-9]{0,39})$/)))}),v.strictObject({operation:v.literal('reveal'),expectedRevision:revision}),
 v.strictObject({operation:v.literal('activate'),expectedRevision:revision}),v.strictObject({operation:v.literal('pause'),expectedRevision:revision}),
 v.strictObject({operation:v.literal('rollback'),expectedRevision:revision}),
 v.strictObject({operation:v.literal('retry'),expectedRevision:revision,eventId:v.pipe(v.string(),v.uuid())}),
 v.strictObject({operation:v.literal('reconcile'),expectedRevision:revision,source:v.picklist(pushSources),commandId:v.pipe(v.string(),v.uuid())}),
]);
export type PushCommand=v.InferOutput<typeof pushCommandSchema>;
