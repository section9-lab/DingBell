import * as v from 'valibot';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256)),uuid=v.pipe(v.string(),v.uuid());
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value));
export const aiReceptionCommandSchema=v.strictObject({commandId:uuid,expectedVersion:v.pipe(count,v.maxValue(Number.MAX_SAFE_INTEGER-1))});
const waiting={commandId:uuid,controlEpoch:count,afterSequence:count,resumedAt:timestamp};
export const aiReceptionSchema=v.pipe(v.strictObject({companyId:id,conversationId:id,viewerMemberId:id,projectionPending:v.boolean(),
 control:v.strictObject({version:count,controlEpoch:count,sequence:count,lifecycle:v.picklist(['open','resolved']),reception:v.picklist(['ai','human','paused']),updatedAt:timestamp}),
 waiting:v.nullable(v.strictObject(waiting)),
 resumption:v.nullable(v.strictObject({...waiting,expectedVersion:count,appliedVersion:count,actorMemberId:id})),
}),v.check(value=>{
 const {control,waiting,resumption}=value;
 return (!waiting||control.lifecycle==='open'&&control.reception==='ai'&&waiting.controlEpoch===control.controlEpoch&&Date.parse(waiting.resumedAt)<=Date.parse(control.updatedAt))
  &&(!resumption||resumption.actorMemberId===value.viewerMemberId&&resumption.appliedVersion===resumption.expectedVersion+1&&resumption.appliedVersion<=control.version&&resumption.controlEpoch<=control.controlEpoch&&Date.parse(resumption.resumedAt)<=Date.parse(control.updatedAt));
}));
export type AiReceptionCommand=v.InferOutput<typeof aiReceptionCommandSchema>;
export type AiReception=v.InferOutput<typeof aiReceptionSchema>;
