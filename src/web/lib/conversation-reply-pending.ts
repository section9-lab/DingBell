import * as v from 'valibot';
import { isValidConversationReplyBody, type ConversationCommand } from './conversation-control-api.ts';

export interface PendingReplyScope {userId:string;memberId:string;companyId:string;conversationId:string}
export type PendingReplyCommand=Extract<ConversationCommand,{action:'send_reply'}>;
export type PendingReplyStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
export type PendingReplyRead={state:'none'}|{state:'pending';command:PendingReplyCommand}|{state:'blocked'};
type StorageInput=PendingReplyStorage|null|undefined;
type Selector=Pick<PendingReplyScope,'userId'>&Partial<Omit<PendingReplyScope,'userId'>>;
const prefix='dingbell:reply-pending:v1:';
const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>!!value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const scopeSchema=v.strictObject({userId:identifier,memberId:identifier,companyId:identifier,conversationId:identifier});
const selectorSchema=v.strictObject({userId:identifier,memberId:v.optional(identifier),companyId:v.optional(identifier),conversationId:v.optional(identifier)});
const commandSchema=v.strictObject({action:v.literal('send_reply'),commandId:v.pipe(v.string(),v.uuid()),
  expectedVersion:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER-1)),body:v.pipe(v.string(),v.check(isValidConversationReplyBody)),previewRequestId:v.optional(v.pipe(v.string(),v.uuid()))});
const recordSchema=v.strictObject({v:v.literal(1),scope:scopeSchema,command:commandSchema});
function keyFor(scope:PendingReplyScope){return prefix+encodeURIComponent(JSON.stringify([scope.userId,scope.memberId,scope.companyId,scope.conversationId]));}
function keyScope(key:string):PendingReplyScope|null{
  try{
    const parsed=v.safeParse(v.tuple([identifier,identifier,identifier,identifier]),JSON.parse(decodeURIComponent(key.slice(prefix.length))));
    if(!parsed.success)return null;
    const [userId,memberId,companyId,conversationId]=parsed.output,scope={userId,memberId,companyId,conversationId};
    return keyFor(scope)===key?scope:null;
  }catch{return null;}
}
function sameCommand(a:PendingReplyCommand,b:PendingReplyCommand){return a.commandId===b.commandId&&a.expectedVersion===b.expectedVersion&&a.action===b.action&&a.body===b.body&&a.previewRequestId===b.previewRequestId;}
export function readPendingReply(storage:StorageInput,scope:PendingReplyScope):PendingReplyRead{
  try{
    if(!storage||!v.is(scopeSchema,scope))return {state:'blocked'};
    const key=keyFor(scope),raw=storage.getItem(key);
    if(raw===null)return {state:'none'};
    if(raw.length>16_384)return {state:'blocked'};
    const parsed=v.safeParse(recordSchema,JSON.parse(raw));
    if(!parsed.success||keyFor(parsed.output.scope)!==key)return {state:'blocked'};
    return {state:'pending',command:parsed.output.command};
  }catch{return {state:'blocked'};}
}
export function savePendingReply(storage:StorageInput,scope:PendingReplyScope,command:PendingReplyCommand):boolean{
  try{
    if(!storage||!v.is(scopeSchema,scope)||!v.is(commandSchema,command))return false;
    const current=readPendingReply(storage,scope);
    if(current.state==='blocked')return false;
    if(current.state==='pending')return sameCommand(current.command,command);
    storage.setItem(keyFor(scope),JSON.stringify({v:1,scope,command}));
    const persisted=readPendingReply(storage,scope);
    return persisted.state==='pending'&&sameCommand(persisted.command,command);
  }catch{return false;}
}
export function clearPendingReply(storage:StorageInput,scope:PendingReplyScope,command:PendingReplyCommand):boolean{
  try{
    if(!storage||!v.is(scopeSchema,scope)||!v.is(commandSchema,command))return false;
    const current=readPendingReply(storage,scope);
    if(current.state==='none')return true;
    if(current.state==='blocked'||!sameCommand(current.command,command))return false;
    storage.removeItem(keyFor(scope));
    return storage.getItem(keyFor(scope))===null;
  }catch{return false;}
}
export function clearPendingReplies(storage:StorageInput,selector:Selector):boolean{
  try{
    if(!storage||!v.is(selectorSchema,selector))return false;
    const keys:string[]=[],length=storage.length;
    if(!Number.isSafeInteger(length)||length<0)return false;
    for(let index=0;index<length;index++){const key=storage.key(index);if(key?.startsWith(prefix))keys.push(key);}
    let complete=true;
    for(const key of keys){
      const scope=keyScope(key);
      if(!scope){complete=false;continue;}
      if(!Object.entries(selector).every(([field,value])=>value===undefined||scope[field as keyof PendingReplyScope]===value))continue;
      // Confirmed sign-out/revocation can remove corrupt content by its scoped key.
      storage.removeItem(key);
      if(storage.getItem(key)!==null)complete=false;
    }
    return complete;
  }catch{return false;}
}
