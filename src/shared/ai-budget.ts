import * as v from 'valibot';
import {replyTestBudgetWorkspaceSchema} from './reply-test-budget.ts';
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const configuration=v.pipe(v.object({enabled:v.boolean(),modelConfigured:v.boolean(),pricesConfigured:v.boolean(),
 model:v.nullable(v.pipe(v.string(),v.minLength(1),v.maxLength(256))),maxGenerations:v.nullable(v.pipe(count,v.minValue(1),v.maxValue(8))),
 perGenerationMicros:v.nullable(count),runReservationMicros:v.nullable(count),
}),v.check(c=>c.pricesConfigured?c.model!==null&&c.maxGenerations!==null&&c.perGenerationMicros!==null&&c.runReservationMicros!==null&&BigInt(c.perGenerationMicros)*BigInt(c.maxGenerations)===BigInt(c.runReservationMicros):c.model===null&&c.maxGenerations===null&&c.perGenerationMicros===null&&c.runReservationMicros===null));

export const aiBudgetWorkspaceSchema=v.object({
 ...v.omit(replyTestBudgetWorkspaceSchema,['queryToday','configuration']).entries,
 purpose:v.literal('production'),
 configuration,
});
export type AiBudgetWorkspace=v.InferOutput<typeof aiBudgetWorkspaceSchema>;
