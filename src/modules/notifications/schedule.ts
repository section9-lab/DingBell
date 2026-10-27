import * as v from 'valibot';
import { replyPolicyConfigSchema } from '../../shared/reply-policy.ts';

export type NotificationPolicy=v.InferOutput<typeof replyPolicyConfigSchema>&{kind:'notification'};
type LocalParts={year:number;month:number;day:number;hour:number;minute:number};
const formatter=new Map<string,Intl.DateTimeFormat>();
function localParts(value:number,timeZone:string):LocalParts {
  let format=formatter.get(timeZone);if(!format){format=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatter.set(timeZone,format);}
  const parts=format.formatToParts(new Date(value)),read=(kind:Intl.DateTimeFormatPartTypes)=>Number(parts.find(part=>part.type===kind)?.value);
  return {year:read('year'),month:read('month'),day:read('day'),hour:read('hour'),minute:read('minute')};
}
const clockMinutes=(value:string)=>Number(value.slice(0,2))*60+Number(value.slice(3));
function inQuietHours(value:number,timeZone:string,quiet:NonNullable<NotificationPolicy['quietHours']>) {
  const parts=localParts(value,timeZone),minute=parts.hour*60+parts.minute,start=clockMinutes(quiet.start),end=clockMinutes(quiet.end);
  return start<end?minute>=start&&minute<end:minute>=start||minute<end;
}
export function notificationWindow(input:unknown,eventAt:number,timeZone:string) {
  const parsed=v.parse(replyPolicyConfigSchema,input);if(parsed.kind!=='notification')throw new Error('NOTIFICATION_POLICY_REQUIRED');
  if(!Number.isSafeInteger(eventAt)||eventAt<0||!timeZone)throw new Error('NOTIFICATION_SCHEDULE_INVALID');
  // Constructing local parts validates the IANA zone before a job is persisted.
  localParts(eventAt,timeZone);
  const expiresAt=eventAt+parsed.expiresAfterMinutes*60_000;let dueAt=eventAt+parsed.delayMinutes*60_000;
  if(!Number.isSafeInteger(expiresAt)||!Number.isSafeInteger(dueAt))throw new Error('NOTIFICATION_SCHEDULE_INVALID');
  if(parsed.quietHours)for(let minute=0;minute<=26*60&&inQuietHours(dueAt,timeZone,parsed.quietHours);minute++)dueAt+=60_000;
  if(parsed.quietHours&&inQuietHours(dueAt,timeZone,parsed.quietHours))throw new Error('NOTIFICATION_QUIET_HOURS_UNRESOLVED');
  const due=localParts(dueAt,timeZone),localDay=`${due.year.toString().padStart(4,'0')}-${due.month.toString().padStart(2,'0')}-${due.day.toString().padStart(2,'0')}`;
  return {dueAt,expiresAt,expiredBeforeDue:dueAt>=expiresAt,localDay};
}
export function renderNotification(input:unknown,variables:Record<string,string>) {
  const parsed=v.parse(replyPolicyConfigSchema,input);if(parsed.kind!=='notification')throw new Error('NOTIFICATION_POLICY_REQUIRED');
  const allowed=new Set(['store_name','order_number','tracking_number']);
  if(Object.keys(variables).some(key=>!allowed.has(key))||Object.values(variables).some(value=>typeof value!=='string'||!value||value.length>256||!value.isWellFormed()))
    throw new Error('NOTIFICATION_VARIABLE_INVALID');
  return parsed.content.replace(/\{\{\s*([a-z_]+)\s*\}\}/g,(_match,key:string)=>{
    const value=variables[key];if(!value)throw new Error('NOTIFICATION_VARIABLE_MISSING');return value;
  });
}
export type NotificationPreflight={enabled:boolean;publishedRevision:number|null;expectedRevision:number;eventCancelled:boolean;sentOnLocalDay:number;now:number;dueAt:number;expiresAt:number;maxPerDay:number};
export function notificationPreflight(value:NotificationPreflight) {
  if(!value.enabled)return 'policy_disabled' as const;
  if(value.publishedRevision!==value.expectedRevision)return 'policy_changed' as const;
  if(value.eventCancelled)return 'event_cancelled' as const;
  if(value.now<value.dueAt)return 'not_due' as const;
  if(value.now>=value.expiresAt)return 'expired' as const;
  if(value.sentOnLocalDay>=value.maxPerDay)return 'daily_limit' as const;
  return 'ready' as const;
}
