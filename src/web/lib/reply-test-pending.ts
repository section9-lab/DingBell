import * as v from 'valibot';
import { replyTestRequestSchema,type ReplyTestRequest } from '../../shared/reply-test.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(128));
const scopeSchema=v.strictObject({userId:id,companyId:id,memberId:id,conversationId:id});
export type ReplyTestScope=v.InferOutput<typeof scopeSchema>;
type StorageInput=Pick<Storage,'getItem'|'setItem'|'removeItem'>|null;
type Pending={state:'none'}|{state:'blocked'}|{state:'pending';request:ReplyTestRequest};
const recordSchema=v.strictObject({v:v.literal(1),scope:scopeSchema,request:replyTestRequestSchema});
const key=(scope:ReplyTestScope)=>'dingbell:reply-test:v1:'+encodeURIComponent(JSON.stringify([scope.userId,scope.companyId,scope.memberId,scope.conversationId]));
const same=(a:ReplyTestRequest,b:ReplyTestRequest)=>JSON.stringify(v.parse(replyTestRequestSchema,a))===JSON.stringify(v.parse(replyTestRequestSchema,b));
export function readPendingReplyTest(storage:StorageInput,scope:ReplyTestScope):Pending{
  try{
    if(!storage||!v.is(scopeSchema,scope))return {state:'blocked'};
    const raw=storage.getItem(key(scope));if(raw===null)return {state:'none'};if(raw.length>4096)return {state:'blocked'};
    const parsed=v.safeParse(recordSchema,JSON.parse(raw));
    return parsed.success&&key(parsed.output.scope)===key(scope)?{state:'pending',request:parsed.output.request}:{state:'blocked'};
  }catch{return {state:'blocked'};}
}
export function savePendingReplyTest(storage:StorageInput,scope:ReplyTestScope,input:ReplyTestRequest):boolean{
  try{
    if(!storage||!v.is(replyTestRequestSchema,input))return false;
    const current=readPendingReplyTest(storage,scope);if(current.state==='blocked')return false;
    if(current.state==='pending')return same(current.request,input);
    storage.setItem(key(scope),JSON.stringify({v:1,scope,request:input}));
    const saved=readPendingReplyTest(storage,scope);return saved.state==='pending'&&same(saved.request,input);
  }catch{return false;}
}
export function clearPendingReplyTest(storage:StorageInput,scope:ReplyTestScope,input:ReplyTestRequest):boolean{
  try{
    if(!storage||!v.is(replyTestRequestSchema,input))return false;
    const current=readPendingReplyTest(storage,scope);if(current.state==='none')return true;
    if(current.state!=='pending'||!same(current.request,input))return false;
    storage.removeItem(key(scope));return storage.getItem(key(scope))===null;
  }catch{return false;}
}
