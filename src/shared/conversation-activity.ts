import * as v from 'valibot';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const sequence=v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER));
const timestamp=v.pipe(v.string(),v.isoTimestamp());
export const conversationActivityActionSchema=v.picklist(['claim','takeover','resolve','reopen','set_work_status','transfer','add_note','send_reply','cancel_reply','ai_start','ai_resume','ai_listen','request_handoff','customer_message','ai_intake_start','ai_classification','ai_dispatch_stop','ai_send_reply']);
const stateSchema=v.strictObject({lifecycle:v.picklist(['open','resolved']),reception:v.picklist(['paused','human','ai']),workStatus:v.nullable(v.picklist(['needs_reply','waiting_customer','waiting_internal']))});
const actorSchema=v.strictObject({memberId:id,name:v.nullable(v.pipe(v.string(),v.maxLength(1000))),status:v.picklist(['present','removed'])});
const deliverySchema=v.strictObject({intentId:id,origin:v.picklist(['human','ai']),state:v.picklist(['queued','sending','sent','failed','unknown','skipped','canceled']),attemptState:v.nullable(v.picklist(['sending','sent','failed','unknown'])),httpStatus:v.nullable(v.pipe(v.number(),v.integer(),v.minValue(100),v.maxValue(599))),providerAccepted:v.boolean()});
const artifactsSchema=v.strictObject({platformMessage:v.boolean(),internalNote:v.boolean(),aiDraft:v.boolean(),translationEvidence:v.boolean(),replyIntent:v.boolean()});
export const aiRunResultSchema=v.picklist(['drafted','reply_submitted','handoff','completed','failed','aborted','unconfirmed','open','closed_without_output']);
const aiRunSchema=v.strictObject({runId:v.pipe(v.string(),v.uuid()),stage:v.picklist(['presale','order','aftersale']),policyId:id,policyRevision:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER)),result:aiRunResultSchema});
export const conversationActivityEntrySchema=v.strictObject({id:id,sequence,category:v.picklist(['human_action','ai_action','customer_event']),action:conversationActivityActionSchema,occurredAt:timestamp,actor:v.nullable(actorSchema),state:stateSchema,artifacts:artifactsSchema,aiRun:v.nullable(aiRunSchema),delivery:v.nullable(deliverySchema)});
export const conversationActivityResponseSchema=v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,entries:v.pipe(v.array(conversationActivityEntrySchema),v.maxLength(50),v.check(items=>items.every((item,index)=>!index||item.sequence<items[index-1]!.sequence))),nextCursor:v.nullable(v.pipe(v.string(),v.minLength(1),v.maxLength(4096)))});
export const companyConversationActivityEntrySchema=v.strictObject({companyId:id,conversationId:id,platformThreadId:id,store:v.strictObject({id,name:v.pipe(v.string(),v.maxLength(256))}),channel:v.literal('private'),event:conversationActivityEntrySchema});
export const companyConversationActivityResponseSchema=v.strictObject({companyId:id,viewerMemberId:id,entries:v.pipe(v.array(companyConversationActivityEntrySchema),v.maxLength(50)),nextCursor:v.nullable(v.pipe(v.string(),v.minLength(1),v.maxLength(4096)))});
export type ConversationActivityEntry=v.InferOutput<typeof conversationActivityEntrySchema>;
export type CompanyConversationActivityEntry=v.InferOutput<typeof companyConversationActivityEntrySchema>;
