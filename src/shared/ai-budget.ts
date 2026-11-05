import * as v from 'valibot';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const time=v.pipe(count,v.maxValue(8640000000000000));
const day=v.pipe(time,v.check(value=>value%86400000===0));
export const aiBudgetCommandSchema=v.variant('action',[
  v.pipe(v.strictObject({id:v.pipe(v.string(),v.uuid()),action:v.literal('create'),startsAt:day,endsAt:day,limitMicros:count,maxRuns:v.pipe(count,v.minValue(1),v.maxValue(1000000))}),v.check(value=>value.endsAt>value.startsAt)),
  v.strictObject({id:v.pipe(v.string(),v.uuid()),action:v.literal('set_enabled'),budgetId:id,expectedRevision:v.pipe(count,v.maxValue(Number.MAX_SAFE_INTEGER-1)),enabled:v.boolean()}),
]);
export type AiBudgetCommand=v.InferOutput<typeof aiBudgetCommandSchema>;
export const aiBudgetSchema=v.pipe(v.object({id,startsAt:time,endsAt:time,enabled:v.boolean(),revision:count,limitMicros:count,reservedMicros:count,spentMicros:count,maxRuns:v.pipe(count,v.minValue(1),v.maxValue(1000000)),admittedRuns:count,remainingMicros:count,remainingRuns:count}),
  v.check(b=>b.endsAt>b.startsAt&&b.admittedRuns<=b.maxRuns&&b.remainingRuns===b.maxRuns-b.admittedRuns&&BigInt(b.remainingMicros)===(BigInt(b.limitMicros)>BigInt(b.reservedMicros)+BigInt(b.spentMicros)?BigInt(b.limitMicros)-BigInt(b.reservedMicros)-BigInt(b.spentMicros):0n)));
export type AiBudgetView=v.InferOutput<typeof aiBudgetSchema>;
export const aiBudgetReceiptSchema=v.object({id:v.pipe(v.string(),v.uuid()),action:v.picklist(['create','set_enabled']),budgetId:id,revision:count,enabled:v.boolean()});
const configuration=v.pipe(v.object({enabled:v.boolean(),modelConfigured:v.boolean(),pricesConfigured:v.boolean(),
 model:v.nullable(v.pipe(v.string(),v.minLength(1),v.maxLength(256))),maxGenerations:v.nullable(v.pipe(count,v.minValue(1),v.maxValue(8))),
 perGenerationMicros:v.nullable(count),runReservationMicros:v.nullable(count),
}),v.check(c=>c.pricesConfigured?c.model!==null&&c.maxGenerations!==null&&c.perGenerationMicros!==null&&c.runReservationMicros!==null&&BigInt(c.perGenerationMicros)*BigInt(c.maxGenerations)===BigInt(c.runReservationMicros):c.model===null&&c.maxGenerations===null&&c.perGenerationMicros===null&&c.runReservationMicros===null));

export const aiBudgetWorkspaceSchema=v.object({
  companyId:id,viewerMemberId:id,at:time,currentBudget:v.nullable(aiBudgetSchema),budgets:v.pipe(v.array(aiBudgetSchema),v.maxLength(20)),nextBefore:v.nullable(v.pipe(v.string(),v.maxLength(1000))),
  purpose:v.literal('production'),
  events:v.pipe(v.array(v.object({...aiBudgetReceiptSchema.entries,actorName:v.string(),createdAt:time})),v.maxLength(10)),
  configuration,
});
export type AiBudgetWorkspace=v.InferOutput<typeof aiBudgetWorkspaceSchema>;
