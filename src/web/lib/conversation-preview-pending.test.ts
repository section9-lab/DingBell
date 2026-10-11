/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearPendingPreviews,clearPendingPreview,readPendingPreview,savePendingPreview,type PendingPreviewScope,type PendingPreviewStorage } from './conversation-preview-pending.ts';
import type { ReplyPreviewRequest } from './conversation-preview-api.ts';
const scope:PendingPreviewScope={userId:'user',memberId:'member',companyId:'company',conversationId:'conversation'};
const request:ReplyPreviewRequest={requestId:'00000000-0000-4000-8000-000000000001',source:'  请确认规格\r\n26 cm\t<b>正文</b>  ',sourceRevision:3};
class MemoryStorage implements PendingPreviewStorage{
  values=new Map<string,string>();writes=0;
  get length(){return this.values.size;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.writes++;this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
  key(index:number){return [...this.values.keys()][index]??null;}
}
function saved(){const storage=new MemoryStorage();assert.equal(savePendingPreview(storage,scope,request),true);return storage;}
test('preview journal persists exact frozen request and recovers after UI recreation without a send command',()=>{
  const storage=new MemoryStorage();assert.deepEqual(readPendingPreview(storage,scope),{state:'none'});
  assert.equal(savePendingPreview(storage,scope,request),true);assert.equal(storage.writes,1);
  const recreated=new MemoryStorage();recreated.values=new Map(storage.values);
  assert.deepEqual(readPendingPreview(recreated,scope),{state:'pending',request});
  assert.equal(recreated.key(0)!.includes(request.source),false);
  const record=JSON.parse(recreated.getItem(recreated.key(0)!)!);assert.deepEqual(Object.keys(record).sort(),['request','scope','v']);
});
test('preview journal allows identical retry but never overwrites unresolved request identity, revision or source',()=>{
  const storage=saved(),snapshot=new Map(storage.values);assert.equal(savePendingPreview(storage,scope,{...request}),true);assert.equal(storage.writes,1);
  for(const change of [{requestId:'00000000-0000-4000-8000-000000000002'},{sourceRevision:4},{source:request.source.trim()}]){
    assert.equal(savePendingPreview(storage,scope,{...request,...change}),false);assert.deepEqual(storage.values,snapshot);
  }
});
test('preview storage failures and failed readback block model submission without an in-memory fallback',()=>{
  for(const storage of [null,undefined]){assert.deepEqual(readPendingPreview(storage,scope),{state:'blocked'});assert.equal(savePendingPreview(storage,scope,request),false);}
  const denied=new MemoryStorage();denied.getItem=()=>{throw new Error('denied');};assert.deepEqual(readPendingPreview(denied,scope),{state:'blocked'});assert.equal(savePendingPreview(denied,scope,request),false);
  const quota=new MemoryStorage();quota.setItem=()=>{throw new Error('QuotaExceededError');};assert.equal(savePendingPreview(quota,scope,request),false);assert.equal(quota.length,0);
  const dropped=new MemoryStorage();dropped.setItem=()=>{};assert.equal(savePendingPreview(dropped,scope,request),false);
  const altered=new MemoryStorage();altered.setItem=(key,value)=>{const record=JSON.parse(value);altered.values.set(key,JSON.stringify({...record,request:{...request,source:'other'}}));};assert.equal(savePendingPreview(altered,scope,request),false);
});
test('corrupt, extra-field, mismatched and oversized journal records remain blocked without being erased',()=>{
  const storage=saved(),key=storage.key(0)!,original=storage.getItem(key)!,record=JSON.parse(original);
  for(const raw of ['{','null','x'.repeat(16_385),JSON.stringify({...record,v:2}),JSON.stringify({...record,receipt:{uid:'private'}}),
    JSON.stringify({...record,scope:{...scope,memberId:'new-member'}}),JSON.stringify({...record,request:{...request,sourceRevision:4.5}}),
    JSON.stringify({...record,request:{...request,source:'\ud800'}})]){
    storage.values.set(key,raw);assert.deepEqual(readPendingPreview(storage,scope),{state:'blocked'});
    assert.equal(savePendingPreview(storage,scope,request),false);assert.equal(clearPendingPreview(storage,scope,request),false);assert.equal(storage.getItem(key),raw);
  }
});
test('preview journals isolate user, member, company and conversation and do not collide with send journals',()=>{
  const storage=saved();
  for(const change of [{userId:'other'},{memberId:'rejoined'},{companyId:'other'},{conversationId:'other'}]){
    const other={...scope,...change};assert.deepEqual(readPendingPreview(storage,other),{state:'none'});assert.equal(savePendingPreview(storage,other,request),true);
  }
  assert.equal(storage.length,5);
  const unicode={...scope,memberId:'成员 /甲',companyId:'公司:一'};assert.equal(savePendingPreview(storage,unicode,request),true);assert.deepEqual(readPendingPreview(storage,unicode),{state:'pending',request});
  const a={...scope,userId:'a:b',memberId:'c'},b={...scope,userId:'a',memberId:'b:c'};assert.equal(savePendingPreview(storage,a,request),true);assert.deepEqual(readPendingPreview(storage,b),{state:'none'});
  storage.setItem('dingbell:reply-pending:v1:private-send','keep');assert.equal(clearPendingPreviews(storage,{userId:'user'}),true);assert.equal(storage.getItem('dingbell:reply-pending:v1:private-send'),'keep');
});
test('exact clear protects a new preview from an old result and reports failed deletion',()=>{
  const storage=saved();
  for(const change of [{source:request.source.trim()},{sourceRevision:4},{requestId:'00000000-0000-4000-8000-000000000002'}])assert.equal(clearPendingPreview(storage,scope,{...request,...change}),false);
  assert.equal(clearPendingPreview(storage,scope,request),true);assert.equal(clearPendingPreview(storage,scope,request),true);
  const next={...request,requestId:'00000000-0000-4000-8000-000000000002',sourceRevision:4};assert.equal(savePendingPreview(storage,scope,next),true);
  assert.equal(clearPendingPreview(storage,scope,request),false);assert.deepEqual(readPendingPreview(storage,scope),{state:'pending',request:next});
  storage.removeItem=()=>{};assert.equal(clearPendingPreview(storage,scope,next),false);
  storage.removeItem=()=>{throw new Error('denied');};assert.equal(clearPendingPreview(storage,scope,next),false);
});
test('logout and revocation cleanup can remove corrupt matching records but preserve other identities',()=>{
  const storage=saved(),otherCompany={...scope,companyId:'other'},otherUser={...scope,userId:'other'},rejoined={...scope,memberId:'rejoined'};
  for(const value of [otherCompany,otherUser,rejoined])assert.equal(savePendingPreview(storage,value,request),true);
  storage.values.set(storage.key(0)!,'{corrupt');assert.equal(clearPendingPreviews(storage,scope),true);
  assert.deepEqual(readPendingPreview(storage,rejoined),{state:'pending',request});assert.deepEqual(readPendingPreview(storage,otherUser),{state:'pending',request});
  assert.equal(clearPendingPreviews(storage,{userId:'user'}),true);assert.deepEqual(readPendingPreview(storage,rejoined),{state:'none'});assert.deepEqual(readPendingPreview(storage,otherCompany),{state:'none'});
  assert.deepEqual(readPendingPreview(storage,otherUser),{state:'pending',request});
});
test('invalid requests and scope identifiers never mutate storage and cleanup failures are reported',()=>{
  const storage=new MemoryStorage();
  for(const change of [{source:''},{source:'x'.repeat(1001)},{sourceRevision:Number.MAX_SAFE_INTEGER+1},{requestId:'not-uuid'},{extra:true}])assert.equal(savePendingPreview(storage,scope,{...request,...change}),false);
  for(const change of [{userId:''},{memberId:' x'},{companyId:'x'.repeat(257)},{conversationId:'\ud800'}]){
    assert.deepEqual(readPendingPreview(storage,{...scope,...change}),{state:'blocked'});assert.equal(savePendingPreview(storage,{...scope,...change},request),false);
  }
  assert.equal(storage.writes,0);assert.equal(clearPendingPreviews(null,{userId:'user'}),false);assert.equal(clearPendingPreviews(storage,{userId:''}),false);
  const denied=saved();denied.removeItem=()=>{throw new Error('denied');};assert.equal(clearPendingPreviews(denied,{userId:'user'}),false);
  const brokenKey=saved();brokenKey.key=()=>{throw new Error('denied');};assert.equal(clearPendingPreviews(brokenKey,{userId:'user'}),false);
});
