import * as v from 'valibot';
import { policyStageSchema } from './reply-policy.ts';
import { knowledgeCitationSchema } from './knowledge.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(128),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const body=v.pipe(v.string(),v.minLength(1),v.maxLength(1000),v.check(value=>!!value.trim()&&value.isWellFormed()));
const text=v.pipe(v.string(),v.minLength(1),v.maxLength(2400));
const language=v.picklist(['ru','zh-CN','en']);
export const replyTestRequestSchema=v.strictObject({requestId:v.pipe(v.string(),v.uuid()),messageId:id,policyId:id,stage:policyStageSchema,language});
export type ReplyTestRequest=v.InferOutput<typeof replyTestRequestSchema>;
const decision=v.variant('kind',[
  v.object({kind:v.literal('answer'),body,sources:v.pipe(v.array(v.object({...knowledgeCitationSchema.entries,quote:text})),v.minLength(1),v.maxLength(10))}),
  v.object({kind:v.literal('clarify'),body}),
  v.object({kind:v.literal('handoff'),body,reason:v.picklist(['missing_evidence','customer_request','merchant_decision','tool_failure'])}),
]);
export const replyTestAnswerSchema=v.pipe(v.object({status:v.picklist(['review_required','pending','unconfirmed','unavailable']),usageStatus:v.picklist(['held','settled','released']),reason:v.nullable(v.string()),
  review:v.nullable(v.object({status:v.literal('review_required'),simulated:v.literal(true),canSend:v.literal(false),factCheck:v.literal('not_evaluated'),runId:v.pipe(v.string(),v.uuid()),contextHash:v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/)),decision}))}),
  v.check(value=>(value.status==='review_required')===(value.review!==null)));
export const replyTestViewSchema=v.object({requestId:v.pipe(v.string(),v.uuid()),messageId:id,policyId:id,policyRevision:v.pipe(v.number(),v.integer(),v.minValue(1)),stage:policyStageSchema,language,question:body,
  status:v.picklist(['prepared','retrieving','ready','changed','unconfirmed','index_unavailable']),
  sources:v.pipe(v.array(v.object({...knowledgeCitationSchema.entries,body:text,score:v.pipe(v.number(),v.finite())})),v.maxLength(10)),answer:v.nullable(replyTestAnswerSchema)});
export type ReplyTestView=v.InferOutput<typeof replyTestViewSchema>;
