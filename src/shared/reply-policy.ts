import * as v from 'valibot';

const boundedInteger = (min:number,max:number) => v.pipe(v.number(),v.integer(),v.minValue(min),v.maxValue(max));
const id = v.pipe(v.string(),v.minLength(1),v.maxLength(128));
const unique = (values:string[]) => new Set(values).size === values.length;
const common = {
  name:v.pipe(v.string(),v.trim(),v.minLength(1),v.maxLength(80)),
  // 空数组表示公司内全部店铺；显式列表用于兼容历史策略的店铺范围。
  storeIds:v.pipe(v.array(id),v.maxLength(20),v.check(unique),v.transform(values=>[...values].sort())),
  priority:boundedInteger(0,100),
};
export const policyStageSchema=v.picklist(['presale','order','aftersale']);
export const notificationVariables=['store_name','order_number','tracking_number'] as const;
function validTemplate(value:string) {
  const remainder=value.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(match,key:string)=>notificationVariables.includes(key as typeof notificationVariables[number])?'':match);
  return !remainder.includes('{{')&&!remainder.includes('}}');
}
const clock=v.pipe(v.string(),v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
const automaticBase={kind:v.literal('automatic'),
  // 一条策略只服务一个业务阶段；三个阶段各建一条才能全覆盖。
  stage:policyStageSchema,
  mode:v.picklist(['suggest','automatic']),language:v.picklist(['customer','ru','zh-CN','en']),
  tone:v.picklist(['concise','friendly','formal']),instructions:v.pipe(v.string(),v.maxLength(2000)),
} as const;
const notificationSchema=v.pipe(v.strictObject({...common,kind:v.literal('notification'),
  event:v.picklist(['order_placed','dispatched','ready_for_pickup','delivered']),
  delayMinutes:boundedInteger(0,10080),expiresAfterMinutes:boundedInteger(1,43200),maxPerDay:boundedInteger(1,3),
  quietHours:v.nullable(v.pipe(v.strictObject({start:clock,end:clock}),v.check(value=>value.start!==value.end))),
  content:v.pipe(v.string(),v.trim(),v.minLength(1),v.maxLength(1000),v.check(validTemplate)),
}),v.check(value=>value.delayMinutes<value.expiresAfterMinutes));
export const replyPolicyConfigSchema=v.variant('kind',[
  v.strictObject({...common,...automaticBase}),
  notificationSchema,
]);
export type ReplyPolicyConfig=v.InferOutput<typeof replyPolicyConfigSchema>;
export type PolicyStage=v.InferOutput<typeof policyStageSchema>;
export const policyVersionSchema=boundedInteger(1,Number.MAX_SAFE_INTEGER-1);
