/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearPendingReplies,clearPendingReply,readPendingReply,savePendingReply,type PendingReplyScope,type PendingReplyCommand,type PendingReplyStorage } from './conversation-reply-pending.ts';
const scope:PendingReplyScope={userId:'user',memberId:'member',companyId:'company',conversationId:'conversation'};
const command:PendingReplyCommand={action:'send_reply',commandId:'00000000-0000-4000-8000-000000000001',expectedVersion:7,body:'  Здравствуйте!\r\n正文\t<b>原文</b>  '};
class MemoryStorage implements PendingReplyStorage{
  values=new Map<string,string>();writes=0;
  get length(){return this.values.size;}
  getItem(key:string){return this.values.get(key)??null;}
  setItem(key:string,value:string){this.writes++;this.values.set(key,value);}
  removeItem(key:string){this.values.delete(key);}
  key(index:number){return [...this.values.keys()][index]??null;}
}
function saved(){const storage=new MemoryStorage();assert.equal(savePendingReply(storage,scope,command),true);return storage;}

test('pending translated replies preserve their preview reference and cannot be downgraded to plain replies',()=>{
  const storage=new MemoryStorage(),translated={...command,previewRequestId:crypto.randomUUID()};
  assert.equal(savePendingReply(storage,scope,translated),true);assert.deepEqual(readPendingReply(storage,scope),{state:'pending',command:translated});
  for(const changed of [command,{...translated,previewRequestId:crypto.randomUUID()}]){
    assert.equal(savePendingReply(storage,scope,changed),false);assert.equal(clearPendingReply(storage,scope,changed),false);
  }
  assert.equal(savePendingReply(storage,scope,{...translated}),true);assert.equal(clearPendingReply(storage,scope,translated),true);
  assert.deepEqual(readPendingReply(storage,scope),{state:'none'});
});

test('pending reply persists exact frozen command before dispatch and can be read again after recreating its UI',()=>{
  const storage=new MemoryStorage();assert.deepEqual(readPendingReply(storage,scope),{state:'none'});
  assert.equal(savePendingReply(storage,scope,command),true);assert.equal(storage.writes,1);
  assert.deepEqual(readPendingReply(storage,scope),{state:'pending',command});
  const reloaded=new MemoryStorage();reloaded.values=new Map(storage.values);
  assert.deepEqual(readPendingReply(reloaded,scope),{state:'pending',command});
  assert.equal(reloaded.key(0)?.includes(command.body),false);
});
test('identical retries are idempotent but a different ID, version or body cannot replace an unconfirmed command',()=>{
  const storage=saved(),before=new Map(storage.values);
  assert.equal(savePendingReply(storage,scope,{...command}),true);assert.equal(storage.writes,1);
  for(const change of [{commandId:'00000000-0000-4000-8000-000000000002'},{expectedVersion:8},{body:command.body.trim()}]){
    assert.equal(savePendingReply(storage,scope,{...command,...change}),false);assert.deepEqual(storage.values,before);
  }
});
test('corrupt or scope-mismatched pending records fail closed without silent deletion or replacement',()=>{
  const storage=saved(),key=storage.key(0)!,valid=storage.getItem(key)!;
  const parsed=JSON.parse(valid);
  for(const value of ['{','null',JSON.stringify({...parsed,extra:true}),JSON.stringify({...parsed,v:99}),
    JSON.stringify({...parsed,scope:{...scope,memberId:'rejoined'}}),JSON.stringify({...parsed,command:{...command,body:'\u0001'}}),
    JSON.stringify({...parsed,command:{...command,expectedVersion:8.1}}),JSON.stringify({...parsed,command:{...command,chatId:'forged'}})]){
    storage.values.set(key,value);
    assert.deepEqual(readPendingReply(storage,scope),{state:'blocked'});
    assert.equal(savePendingReply(storage,scope,command),false);assert.equal(clearPendingReply(storage,scope,command),false);
    assert.equal(storage.getItem(key),value);
  }
});
test('storage denial, quota failure and incorrect write readback block dispatch instead of falling back to memory',()=>{
  for(const storage of [null,undefined]){
    assert.deepEqual(readPendingReply(storage,scope),{state:'blocked'});assert.equal(savePendingReply(storage,scope,command),false);assert.equal(clearPendingReply(storage,scope,command),false);
  }
  const denied=new MemoryStorage();denied.getItem=()=>{throw new Error('SecurityError');};
  assert.deepEqual(readPendingReply(denied,scope),{state:'blocked'});assert.equal(savePendingReply(denied,scope,command),false);
  const quota=new MemoryStorage();quota.setItem=()=>{throw new Error('QuotaExceededError');};assert.equal(savePendingReply(quota,scope,command),false);assert.equal(quota.length,0);
  const dropped=new MemoryStorage();dropped.setItem=()=>{};assert.equal(savePendingReply(dropped,scope,command),false);
  const changed=new MemoryStorage();changed.setItem=(key,value)=>{const parsed=JSON.parse(value);changed.values.set(key,JSON.stringify({...parsed,command:{...command,body:'different'}}));};
  assert.equal(savePendingReply(changed,scope,command),false);
});
test('pending scopes isolate account, membership, company and conversation with unambiguous encoded keys',()=>{
  const storage=saved();
  const others=[{userId:'other-user'},{memberId:'rejoined-member'},{companyId:'other-company'},{conversationId:'other-conversation'}];
  for(const change of others){const other={...scope,...change};assert.deepEqual(readPendingReply(storage,other),{state:'none'});assert.equal(savePendingReply(storage,other,command),true);}
  assert.equal(storage.length,5);
  const a={...scope,userId:'a:b',memberId:'c'},b={...scope,userId:'a',memberId:'b:c'};
  assert.equal(savePendingReply(storage,a,command),true);assert.deepEqual(readPendingReply(storage,b),{state:'none'});
  const unicode={...scope,companyId:'公司 / ? #',conversationId:'会话'};assert.equal(savePendingReply(storage,unicode,command),true);assert.deepEqual(readPendingReply(storage,unicode),{state:'pending',command});
});
test('clearing requires the complete original command, so a late response cannot erase a later pending send',()=>{
  const storage=saved();
  assert.equal(clearPendingReply(storage,scope,{...command,body:'different'}),false);
  assert.equal(clearPendingReply(storage,scope,{...command,expectedVersion:8}),false);
  assert.equal(clearPendingReply(storage,scope,command),true);assert.deepEqual(readPendingReply(storage,scope),{state:'none'});
  assert.equal(clearPendingReply(storage,scope,command),true);
  const next={...command,commandId:'00000000-0000-4000-8000-000000000002'};
  assert.equal(savePendingReply(storage,scope,next),true);assert.equal(clearPendingReply(storage,scope,command),false);
  assert.deepEqual(readPendingReply(storage,scope),{state:'pending',command:next});
  storage.removeItem=()=>{throw new Error('storage failed');};assert.equal(clearPendingReply(storage,scope,next),false);
});
test('identity and permission cleanup removes only the matching namespaced scopes, including a corrupt value',()=>{
  const storage=saved();
  const sameCompany={...scope,conversationId:'another'},otherCompany={...scope,companyId:'other'},otherUser={...scope,userId:'other'};
  for(const next of [sameCompany,otherCompany,otherUser])assert.equal(savePendingReply(storage,next,command),true);
  storage.values.set(storage.key(0)!,'{corrupted');storage.setItem('unrelated-settings','keep');
  assert.equal(clearPendingReplies(storage,{userId:'user',companyId:'company'}),true);
  assert.deepEqual(readPendingReply(storage,scope),{state:'none'});assert.deepEqual(readPendingReply(storage,sameCompany),{state:'none'});
  assert.deepEqual(readPendingReply(storage,otherCompany),{state:'pending',command});assert.deepEqual(readPendingReply(storage,otherUser),{state:'pending',command});
  assert.equal(clearPendingReplies(storage,{userId:'user'}),true);assert.deepEqual(readPendingReply(storage,otherCompany),{state:'none'});
  assert.deepEqual(readPendingReply(storage,otherUser),{state:'pending',command});assert.equal(storage.getItem('unrelated-settings'),'keep');
  const revoked=new MemoryStorage();for(const next of [scope,{...scope,memberId:'rejoined'}])assert.equal(savePendingReply(revoked,next,command),true);
  assert.equal(clearPendingReplies(revoked,{...scope}),true);assert.deepEqual(readPendingReply(revoked,{...scope,memberId:'rejoined'}),{state:'pending',command});
});
test('invalid commands and identifiers are rejected before storage mutation and cleanup errors are reported',()=>{
  const storage=new MemoryStorage();
  for(const change of [{body:''},{body:'a'.repeat(1001)},{commandId:'not-uuid'},{expectedVersion:Number.MAX_SAFE_INTEGER},{action:'claim'},{extra:'forged'}])assert.equal(savePendingReply(storage,scope,{...command,...change} as PendingReplyCommand),false);
  for(const change of [{userId:''},{memberId:'x'.repeat(257)},{companyId:'\ud800'}]){
    assert.deepEqual(readPendingReply(storage,{...scope,...change}),{state:'blocked'});assert.equal(savePendingReply(storage,{...scope,...change},command),false);
  }
  assert.equal(storage.writes,0);assert.equal(clearPendingReplies(storage,{userId:''}),false);assert.equal(clearPendingReplies(null,{userId:'user'}),false);
  const failed=saved();failed.removeItem=()=>{throw new Error('denied');};assert.equal(clearPendingReplies(failed,{userId:'user'}),false);
});
