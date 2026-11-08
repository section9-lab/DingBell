import * as v from 'valibot';
const id = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const body = v.pipe(v.string(), v.maxLength(800));
export const aiLoopStepSchema = v.variant('kind', [
  v.strictObject({ id, kind: v.literal('input'), text: body }),
  v.strictObject({ id, kind: v.literal('thinking'), text: body }),
  v.strictObject({ id, kind: v.literal('tool'), name: id, input: body, output: v.optional(body), failed: v.optional(v.boolean()) }),
  v.strictObject({ id, kind: v.literal('answer'), text: body }),
]);
export const aiActivitySchema = v.strictObject({
  companyId: id, conversationId: id, runId: v.nullable(id),
  status: v.picklist(['unavailable', 'pending', 'completed', 'failed']),
  steps: v.pipe(v.array(aiLoopStepSchema), v.maxLength(80)),
  truncated: v.boolean(),
});
export type AiLoopStep = v.InferOutput<typeof aiLoopStepSchema>;
export type AiActivity = v.InferOutput<typeof aiActivitySchema>;
