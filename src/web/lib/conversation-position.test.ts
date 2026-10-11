/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
const implementation=await import('./conversation-position.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
function method(name:string){const result=Reflect.get(implementation,name);assert.equal(typeof result,'function',`${name} must be implemented`);return result as (...args:any[])=>any;}
const scope={userId:'user',memberId:'member',companyId:'company',conversationId:'conversation'};
const position={historyCursor:'h',pageCursor:null,anchorId:'m',earlierUpdate:{id:'older',eventAt:'2026-10-10T00:00:00.000Z'}};
class MemoryStorage {
  values=new Map<string,string>();get length(){return this.values.size;}
  getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){this.values.set(key,value);}removeItem(key:string){this.values.delete(key);}key(index:number){return [...this.values.keys()][index]??null;}
}
test('positions persist only bounded metadata and isolate user, company, membership and conversation',()=>{
  const read=method('readConversationPosition'),save=method('saveConversationPosition'),storage=new MemoryStorage();assert.deepEqual(read(storage,scope),{state:'none'});assert.equal(save(storage,scope,position),true);assert.deepEqual(read(storage,scope),{state:'saved',position});
  for(const change of [{userId:'other'},{memberId:'rejoined'},{companyId:'other'},{conversationId:'other'}])assert.deepEqual(read(storage,{...scope,...change}),{state:'none'});
  const original=storage.getItem(storage.key(0)!);assert.equal(save(storage,scope,{...position,messages:['PRIVATE BODY']}),false);assert.equal(storage.getItem(storage.key(0)!),original);
  for(const invalid of [{historyCursor:''},{historyCursor:'x'.repeat(4097)},{pageCursor:1},{anchorId:''},{earlierUpdate:{id:'m',eventAt:'not-time'}}])assert.equal(save(storage,scope,{...position,...invalid}),false);
});
test('corrupt or wrong-scope metadata never restores and failed storage never claims success',()=>{
  const read=method('readConversationPosition'),save=method('saveConversationPosition'),storage=new MemoryStorage();save(storage,scope,position);const key=storage.key(0)!,good=JSON.parse(storage.getItem(key)!);
  for(const raw of ['{','null','x'.repeat(32769),JSON.stringify({...good,v:2}),JSON.stringify({...good,scope:{...scope,memberId:'other'}})]){storage.setItem(key,raw);assert.deepEqual(read(storage,scope),{state:'unavailable'});assert.equal(storage.getItem(key),raw);}
  assert.equal(save(null,scope,position),false);assert.deepEqual(read(null,scope),{state:'unavailable'});
  storage.getItem=()=>{throw new Error('denied');};assert.deepEqual(read(storage,scope),{state:'unavailable'});assert.equal(save(storage,scope,position),false);
  const quota=new MemoryStorage();quota.setItem=()=>{throw new Error('quota');};assert.equal(save(quota,scope,position),false);
  const dropped=new MemoryStorage();dropped.setItem=()=>{};assert.equal(save(dropped,scope,position),false);
});
test('position cleanup uses canonical scope keys even for damaged values and leaves drafts and other users untouched',()=>{
  const save=method('saveConversationPosition'),clear=method('clearConversationPositions'),read=method('readConversationPosition'),storage=new MemoryStorage();
  for(const value of [scope,{...scope,companyId:'other'},{...scope,userId:'other'}])save(storage,value,position);
  storage.setItem(storage.key(0)!,'{corrupt');storage.setItem('dingbell:reply-draft:v1:unrelated','draft');
  assert.equal(clear(storage,{userId:'user',companyId:'company'}),true);assert.deepEqual(read(storage,scope),{state:'none'});assert.equal(read(storage,{...scope,companyId:'other'}).state,'saved');
  assert.equal(clear(storage,{userId:'user'}),true);assert.equal(read(storage,{...scope,userId:'other'}).state,'saved');assert.equal(storage.getItem('dingbell:reply-draft:v1:unrelated'),'draft');
  storage.removeItem=()=>{};assert.equal(clear(storage,{userId:'other'}),false);
});

test('position persistence is independent of object property order',()=>{
  const save=method('saveConversationPosition'),read=method('readConversationPosition'),storage=new MemoryStorage();
  const reordered={earlierUpdate:{eventAt:position.earlierUpdate.eventAt,id:position.earlierUpdate.id},anchorId:position.anchorId,pageCursor:position.pageCursor,historyCursor:position.historyCursor};
  assert.equal(save(storage,scope,reordered),true);assert.deepEqual(read(storage,scope),{state:'saved',position});
});
