import * as v from 'valibot';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const amount=v.pipe(v.string(),v.regex(/^(0|[1-9][0-9]*)$/),v.maxLength(30));
const difference=v.pipe(v.string(),v.regex(/^(0|-?[1-9][0-9]*)$/),v.maxLength(31));
export const budgetAuditKindSchema=v.picklist(['ai','translation','reply-test']);
export const budgetAuditIdSchema=id;
const totals=v.strictObject({reservedMicros:amount,spentMicros:amount,admittedRuns:v.nullable(amount)});
const time=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000));
export const budgetReconciliationViewSchema=v.pipe(v.strictObject({status:v.nullable(v.picklist(['balanced','mismatch'])),observedAt:v.nullable(time),nextDueAt:time,
 mismatchSince:v.nullable(time),consecutiveMismatches:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),
 lastErrorAt:v.nullable(time),lastErrorCode:v.nullable(v.literal('AUDIT_UNAVAILABLE')),consecutiveFailures:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))}),v.check(m=>
  (m.status===null?m.observedAt===null&&m.mismatchSince===null&&m.consecutiveMismatches===0:m.observedAt!==null)&&
  (m.status==='mismatch'?m.mismatchSince!==null&&m.consecutiveMismatches>0:m.mismatchSince===null&&m.consecutiveMismatches===0)&&
  (m.lastErrorAt===null?m.lastErrorCode===null&&m.consecutiveFailures===0:m.lastErrorCode==='AUDIT_UNAVAILABLE'&&m.consecutiveFailures>0)));
const subtracts=(difference:string,recorded:string,expected:string)=>{
 try{return BigInt(difference)===BigInt(recorded)-BigInt(expected);}catch{return false;}
};
export const companyBudgetAuditSchema=v.pipe(v.strictObject({
  companyId:id,viewerMemberId:id,kind:budgetAuditKindSchema,budgetId:id,
  at:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8640000000000000)),
  status:v.picklist(['balanced','mismatch']),recorded:totals,expected:totals,
  difference:v.strictObject({reservedMicros:difference,spentMicros:difference,admittedRuns:v.nullable(difference)}),
  embeddingReservedMicros:amount,embeddingCorrelatedMicros:amount,embeddingUncorrelatedMicros:amount,
  invalidExecutions:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),monitoring:v.nullable(budgetReconciliationViewSchema),
  canRelease:v.literal(false),supplierCostsVerified:v.literal(false),
}),v.check(a=>{
 const admitted=a.recorded.admittedRuns===null&&a.expected.admittedRuns===null&&a.difference.admittedRuns===null||
  a.recorded.admittedRuns!==null&&a.expected.admittedRuns!==null&&a.difference.admittedRuns!==null&&subtracts(a.difference.admittedRuns,a.recorded.admittedRuns,a.expected.admittedRuns);
 let embedding=false;try{embedding=BigInt(a.embeddingCorrelatedMicros)<=BigInt(a.embeddingReservedMicros)&&subtracts(a.embeddingUncorrelatedMicros,a.embeddingReservedMicros,a.embeddingCorrelatedMicros);}catch{}
 return subtracts(a.difference.reservedMicros,a.recorded.reservedMicros,a.expected.reservedMicros)&&
  subtracts(a.difference.spentMicros,a.recorded.spentMicros,a.expected.spentMicros)&&admitted&&embedding&&
  (a.status!=='balanced'||a.difference.reservedMicros==='0'&&a.difference.spentMicros==='0'&&(a.difference.admittedRuns===null||a.difference.admittedRuns==='0')&&a.invalidExecutions===0);
}));
export const budgetReconciliationAlertSchema=v.strictObject({kind:budgetAuditKindSchema,budgetId:id,status:v.nullable(v.picklist(['balanced','mismatch'])),observedAt:v.nullable(time),nextDueAt:time,
 mismatchSince:v.nullable(time),consecutiveMismatches:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),lastErrorAt:v.nullable(time),lastErrorCode:v.nullable(v.literal('AUDIT_UNAVAILABLE')),consecutiveFailures:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))});
const summaryCount=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
export const companyBudgetReconciliationSummarySchema=v.pipe(v.strictObject({companyId:id,viewerMemberId:id,at:time,totals:v.strictObject({tracked:summaryCount,pending:summaryCount,balanced:summaryCount,mismatch:summaryCount,unavailable:summaryCount,alerting:summaryCount}),items:v.pipe(v.array(budgetReconciliationAlertSchema),v.maxLength(50)),truncated:v.boolean()}),v.check(s=>{
 try{return BigInt(s.totals.pending)+BigInt(s.totals.balanced)+BigInt(s.totals.mismatch)===BigInt(s.totals.tracked)&&s.totals.alerting<=s.totals.tracked&&s.totals.unavailable<=s.totals.alerting&&
  s.items.every(i=>(i.status===null||i.status==='mismatch'||i.consecutiveFailures>0)&&
   (i.status===null?i.observedAt===null&&i.mismatchSince===null&&i.consecutiveMismatches===0:i.observedAt!==null)&&
   (i.status==='mismatch'?i.mismatchSince!==null&&i.consecutiveMismatches>0:i.mismatchSince===null&&i.consecutiveMismatches===0)&&
   (i.lastErrorAt===null?i.lastErrorCode===null&&i.consecutiveFailures===0:i.lastErrorCode==='AUDIT_UNAVAILABLE'&&i.consecutiveFailures>0));}catch{return false;}
}));
export type BudgetAuditKind=v.InferOutput<typeof budgetAuditKindSchema>;
export type CompanyBudgetAudit=v.InferOutput<typeof companyBudgetAuditSchema>;
export type CompanyBudgetReconciliationSummary=v.InferOutput<typeof companyBudgetReconciliationSummarySchema>;
