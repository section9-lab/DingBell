import * as v from 'valibot';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const body=v.pipe(v.string(),v.minLength(1),v.maxLength(1000),v.check(value=>value.trim().length>0&&value.isWellFormed()&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)));
const sequence=v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER));
export const handoffReviewSchema=v.strictObject({status:v.literal('reviewed'),reviewerMemberId:id,reviewerName:v.pipe(v.string(),v.maxLength(1000)),reviewedAt:v.pipe(v.string(),v.isoTimestamp()),
 customerDataCollected:v.literal(false),businessActionCompleted:v.literal(false)});
export const handoffRequirementKindSchema=v.picklist(['product_model','issue_description','desired_resolution','usage_context','photo_or_video','legacy_unspecified']);
const handoffItemBase={itemIndex:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(7)),kind:handoffRequirementKindSchema,revision:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),
 updatedBy:v.nullable(v.strictObject({memberId:id,name:v.pipe(v.string(),v.maxLength(1000)),at:v.pipe(v.string(),v.isoTimestamp())}))};
export const handoffItemSchema=v.variant('status',[
 v.strictObject({...handoffItemBase,status:v.literal('pending'),evidence:v.null()}),
 v.strictObject({...handoffItemBase,status:v.literal('not_required'),evidence:v.null()}),
 v.strictObject({...handoffItemBase,status:v.literal('unavailable'),evidence:v.null()}),
 v.strictObject({...handoffItemBase,status:v.literal('evidence_linked'),evidence:v.strictObject({messageId:id,eventAt:v.pipe(v.string(),v.isoTimestamp())})}),
]);
export const handoffBriefSchema=v.pipe(v.strictObject({runId:v.pipe(v.string(),v.uuid()),purpose:v.literal('human_follow_up'),collectionStatus:v.literal('requirements_only'),collectionPolicy:v.picklist(['reference_only','legacy_read_only']),customerDataCopied:v.literal(false),businessActionCompleted:v.literal(false),followUpStatus:v.picklist(['pending','ready_for_human_decision','closed','superseded']),
 reason:v.picklist(['missing_evidence','customer_request','merchant_decision','tool_failure']),summary:body,
 neededInformation:v.pipe(v.array(v.pipe(body,v.maxLength(200))),v.maxLength(8)),items:v.pipe(v.array(handoffItemSchema),v.maxLength(8)),state:v.picklist(['open','resolved','superseded']),
 sequence,requestedAt:v.pipe(v.string(),v.isoTimestamp()),review:v.nullable(handoffReviewSchema)}),v.check(value=>value.items.length===value.neededInformation.length&&value.items.every((item,index)=>item.itemIndex===index)));
export const handoffBriefResponseSchema=v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,handoff:v.nullable(handoffBriefSchema)});
export const acknowledgeHandoffRequestSchema=v.strictObject({commandId:v.pipe(v.string(),v.uuid()),action:v.literal('acknowledge_requirements'),runId:v.pipe(v.string(),v.uuid()),expectedSequence:sequence});
export const acknowledgeHandoffResponseSchema=v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,commandId:v.pipe(v.string(),v.uuid()),runId:v.pipe(v.string(),v.uuid()),sourceSequence:sequence,
 outcome:v.literal('acknowledged'),review:handoffReviewSchema});
const itemCommandBase={commandId:v.pipe(v.string(),v.uuid()),action:v.literal('set_follow_up_item'),runId:v.pipe(v.string(),v.uuid()),expectedSequence:sequence,itemIndex:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(7)),expectedRevision:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER))};
export const changeHandoffItemRequestSchema=v.variant('status',[
 v.strictObject({...itemCommandBase,status:v.literal('evidence_linked'),evidenceMessageId:id}),
 v.strictObject({...itemCommandBase,status:v.literal('pending')}),v.strictObject({...itemCommandBase,status:v.literal('not_required')}),v.strictObject({...itemCommandBase,status:v.literal('unavailable')}),
]);
export const changeHandoffItemResponseSchema=v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,commandId:v.pipe(v.string(),v.uuid()),runId:v.pipe(v.string(),v.uuid()),sourceSequence:sequence,outcome:v.literal('updated'),item:handoffItemSchema,
 customerDataCopied:v.literal(false),businessActionCompleted:v.literal(false)});
export type HandoffBrief=v.InferOutput<typeof handoffBriefSchema>;
export type AcknowledgeHandoffRequest=v.InferOutput<typeof acknowledgeHandoffRequestSchema>;
export type ChangeHandoffItemRequest=v.InferOutput<typeof changeHandoffItemRequestSchema>;
