import * as v from 'valibot';
import { isValidReplyPreviewRequest,type ReplyPreviewRequest } from './conversation-preview-api.ts';
export interface PendingPreviewScope {userId:string;memberId:string;companyId:string;conversationId:string}
export type PendingPreviewStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
export type PendingPreviewRead={state:'none'}|{state:'pending';request:ReplyPreviewRequest}|{state:'blocked'};
type StorageInput=PendingPreviewStorage|null|undefined;
type Selector=Pick<PendingPreviewScope,'userId'>&Partial<Omit<PendingPreviewScope,'userId'>>;
const prefix='dingbell:preview-pending:v1:';
const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)));
const scopeSchema=v.strictObject({userId:identifier,memberId:identifier,companyId:identifier,conversationId:identifier});
const selectorSchema=v.strictObject({userId:identifier,memberId:v.optional(identifier),companyId:v.optional(identifier),conversationId:v.optional(identifier)});
const recordSchema=v.strictObject({v:v.literal(1),scope:scopeSchema,request:v.custom<ReplyPreviewRequest>(isValidReplyPreviewRequest)});
function keyFor(scope:PendingPreviewScope){return prefix+encodeURIComponent(JSON.stringify([scope.userId,scope.memberId,scope.companyId,scope.conversationId]));}
function keyScope(key:string):PendingPreviewScope|null{
  try{
    const parsed=v.safeParse(v.tuple([identifier,identifier,identifier,identifier]),JSON.parse(decodeURIComponent(key.slice(prefix.length))));
    if(!parsed.success)return null;
    const [userId,memberId,companyId,conversationId]=parsed.output,scope={userId,memberId,companyId,conversationId};
    return keyFor(scope)===key?scope:null;
  }catch{return null;}
}
function sameRequest(a:ReplyPreviewRequest,b:ReplyPreviewRequest){return a.requestId===b.requestId&&a.source===b.source&&a.sourceRevision===b.sourceRevision;}
export function readPendingPreview(storage:StorageInput,scope:PendingPreviewScope):PendingPreviewRead{
  try{
    if(!storage||!v.is(scopeSchema,scope))return {state:'blocked'};
    const key=keyFor(scope),raw=storage.getItem(key);if(raw===null)return {state:'none'};
    if(raw.length>16_384)return {state:'blocked'};
    const parsed=v.safeParse(recordSchema,JSON.parse(raw));
    if(!parsed.success||keyFor(parsed.output.scope)!==key)return {state:'blocked'};
    return {state:'pending',request:parsed.output.request};
  }catch{return {state:'blocked'};}
}
export function savePendingPreview(storage:StorageInput,scope:PendingPreviewScope,request:ReplyPreviewRequest):boolean{
  try{
    if(!storage||!v.is(scopeSchema,scope)||!isValidReplyPreviewRequest(request))return false;
    const current=readPendingPreview(storage,scope);if(current.state==='blocked')return false;
    if(current.state==='pending')return sameRequest(current.request,request);
    storage.setItem(keyFor(scope),JSON.stringify({v:1,scope,request}));
    const saved=readPendingPreview(storage,scope);return saved.state==='pending'&&sameRequest(saved.request,request);
  }catch{return false;}
}
export function clearPendingPreview(storage:StorageInput,scope:PendingPreviewScope,request:ReplyPreviewRequest):boolean{
  try{
    if(!storage||!v.is(scopeSchema,scope)||!isValidReplyPreviewRequest(request))return false;
    const current=readPendingPreview(storage,scope);if(current.state==='none')return true;
    if(current.state==='blocked'||!sameRequest(current.request,request))return false;
    storage.removeItem(keyFor(scope));return storage.getItem(keyFor(scope))===null;
  }catch{return false;}
}
export function clearPendingPreviews(storage:StorageInput,selector:Selector):boolean{
  try{
    if(!storage||!v.is(selectorSchema,selector))return false;
    const keys:string[]=[],length=storage.length;if(!Number.isSafeInteger(length)||length<0)return false;
    for(let index=0;index<length;index++){const key=storage.key(index);if(key?.startsWith(prefix))keys.push(key);}
    let complete=true;
    for(const key of keys){
      const scope=keyScope(key);if(!scope){complete=false;continue;}
      if(!Object.entries(selector).every(([field,value])=>value===undefined||scope[field as keyof PendingPreviewScope]===value))continue;
      // Confirmed logout or revocation can remove corrupt content using its scoped key.
      storage.removeItem(key);if(storage.getItem(key)!==null)complete=false;
    }
    return complete;
  }catch{return false;}
}
