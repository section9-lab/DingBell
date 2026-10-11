import * as v from 'valibot';
import {aiReceptionCommandSchema,type AiReceptionCommand} from '../../shared/ai-reception.ts';
const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(s=>s===s.trim()&&s.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(s)));
const scopeSchema=v.strictObject({userId:id,memberId:id,companyId:id,conversationId:id});
export type AiResumptionScope=v.InferOutput<typeof scopeSchema>;
export type PendingAiResumption={state:'none'}|{state:'pending';command:AiReceptionCommand}|{state:'blocked'};
type StorageInput=Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>|null;
const recordSchema=v.strictObject({v:v.literal(1),scope:scopeSchema,command:aiReceptionCommandSchema});
const prefix='dingbell:ai-resumption:v1:';
const key=(s:AiResumptionScope)=>prefix+encodeURIComponent(JSON.stringify([s.userId,s.memberId,s.companyId,s.conversationId]));
const same=(a:AiReceptionCommand,b:AiReceptionCommand)=>a.commandId===b.commandId&&a.expectedVersion===b.expectedVersion;
export function readAiResumption(storage:StorageInput,scope:AiResumptionScope):PendingAiResumption{
 try{
  if(!storage||!v.is(scopeSchema,scope))return {state:'blocked'};
  const raw=storage.getItem(key(scope));if(raw===null)return {state:'none'};if(raw.length>4096)return {state:'blocked'};
  const parsed=v.safeParse(recordSchema,JSON.parse(raw));
  return parsed.success&&key(parsed.output.scope)===key(scope)?{state:'pending',command:parsed.output.command}:{state:'blocked'};
 }catch{return {state:'blocked'};}
}
export function saveAiResumption(storage:StorageInput,scope:AiResumptionScope,command:AiReceptionCommand){
 try{
  if(!storage||!v.is(aiReceptionCommandSchema,command))return false;
  const current=readAiResumption(storage,scope);if(current.state==='blocked')return false;if(current.state==='pending')return same(current.command,command);
  storage.setItem(key(scope),JSON.stringify({v:1,scope,command}));const saved=readAiResumption(storage,scope);return saved.state==='pending'&&same(saved.command,command);
 }catch{return false;}
}
export function clearAiResumption(storage:StorageInput,scope:AiResumptionScope,command:AiReceptionCommand){
 try{
  if(!storage||!v.is(aiReceptionCommandSchema,command))return false;
  const current=readAiResumption(storage,scope);if(current.state==='none')return true;if(current.state!=='pending'||!same(current.command,command))return false;
  storage.removeItem(key(scope));return storage.getItem(key(scope))===null;
 }catch{return false;}
}
export function clearAiResumptions(storage:StorageInput,selector:Pick<AiResumptionScope,'userId'>&Partial<Omit<AiResumptionScope,'userId'>>){
 try{
  if(!storage||!v.is(v.strictObject({userId:id,memberId:v.optional(id),companyId:v.optional(id),conversationId:v.optional(id)}),selector))return false;
  const keys:string[]=[],length=storage.length;if(!Number.isSafeInteger(length)||length<0)return false;
  for(let i=0;i<length;i++){const name=storage.key(i);if(name?.startsWith(prefix))keys.push(name);}
  let complete=true;
  for(const name of keys){
   let scope:AiResumptionScope;try{const [userId,memberId,companyId,conversationId]=v.parse(v.tuple([id,id,id,id]),JSON.parse(decodeURIComponent(name.slice(prefix.length))));scope={userId,memberId,companyId,conversationId};if(key(scope)!==name)throw new Error('Invalid key');}catch{complete=false;continue;}
   if(!Object.entries(selector).every(([field,value])=>value===undefined||scope[field as keyof AiResumptionScope]===value))continue;
   storage.removeItem(name);if(storage.getItem(name)!==null)complete=false;
  }
  return complete;
 }catch{return false;}
}
