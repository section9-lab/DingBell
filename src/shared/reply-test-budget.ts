import * as v from 'valibot';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(count,v.maxValue(8640000000000000));
const day=v.pipe(time,v.check(value=>value%86400000===0));
export const replyTestBudgetCommandSchema=v.variant('action',[
  v.pipe(v.strictObject({id:v.pipe(v.string(),v.uuid()),action:v.literal('create'),startsAt:day,endsAt:day,limitMicros:count,maxRuns:v.pipe(count,v.minValue(1),v.maxValue(1000000))}),v.check(value=>value.endsAt>value.startsAt)),
  v.strictObject({id:v.pipe(v.string(),v.uuid()),action:v.literal('set_enabled'),budgetId:id,expectedRevision:v.pipe(count,v.maxValue(Number.MAX_SAFE_INTEGER-1)),enabled:v.boolean()}),
]);
export type ReplyTestBudgetCommand=v.InferOutput<typeof replyTestBudgetCommandSchema>;
export const replyTestBudgetSchema=v.pipe(v.object({id,startsAt:time,endsAt:time,enabled:v.boolean(),revision:count,limitMicros:count,reservedMicros:count,spentMicros:count,maxRuns:v.pipe(count,v.minValue(1),v.maxValue(1000000)),admittedRuns:count,remainingMicros:count,remainingRuns:count}),
  v.check(b=>b.endsAt>b.startsAt&&b.admittedRuns<=b.maxRuns&&b.remainingRuns===b.maxRuns-b.admittedRuns&&BigInt(b.remainingMicros)===(BigInt(b.limitMicros)>BigInt(b.reservedMicros)+BigInt(b.spentMicros)?BigInt(b.limitMicros)-BigInt(b.reservedMicros)-BigInt(b.spentMicros):0n)));
export type ReplyTestBudgetView=v.InferOutput<typeof replyTestBudgetSchema>;
export const replyTestBudgetReceiptSchema=v.object({id:v.pipe(v.string(),v.uuid()),action:v.picklist(['create','set_enabled']),budgetId:id,revision:count,enabled:v.boolean()});
export const replyTestBudgetWorkspaceSchema=v.object({companyId:id,viewerMemberId:id,at:time,currentBudget:v.nullable(replyTestBudgetSchema),budgets:v.pipe(v.array(replyTestBudgetSchema),v.maxLength(20)),nextBefore:v.nullable(v.pipe(v.string(),v.maxLength(1000))),
  queryToday:v.object({queries:count,reservedMicros:count}),
  events:v.pipe(v.array(v.object({...replyTestBudgetReceiptSchema.entries,actorName:v.string(),createdAt:time})),v.maxLength(10)),
  configuration:v.object({enabled:v.boolean(),modelConfigured:v.boolean(),knowledgeConfigured:v.boolean(),pricesConfigured:v.boolean(),answerReservationMicros:v.nullable(count),queryReservationMicros:v.nullable(count)}),
});
export type ReplyTestBudgetWorkspace=v.InferOutput<typeof replyTestBudgetWorkspaceSchema>;
