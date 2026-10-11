/// <reference types="node" />
import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as module from './ai-reception-pending.ts';
const journal=module as Record<string,(...args:any[])=>any>;
const scope={userId:'user',memberId:'member',companyId:'company',conversationId:'conversation'};
const command={commandId:'00000000-0000-4000-8000-000000000001',expectedVersion:4};
function storage(){const values=new Map<string,string>();return {values,get length(){return values.size;},getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);},key:(index:number)=>[...values.keys()][index]??null};}
test('a reload retains exactly the original command and an unrelated operation cannot replace or clear it',()=>{
 assert.equal(typeof journal.saveAiResumption,'function');const s=storage();assert.equal(journal.saveAiResumption!(s,scope,command),true);assert.deepEqual(journal.readAiResumption!(s,scope),{state:'pending',command});
 assert.equal(journal.saveAiResumption!(s,scope,{...command}),true);
 for(const changed of [{...command,commandId:crypto.randomUUID()},{...command,expectedVersion:5}]){assert.equal(journal.saveAiResumption!(s,scope,changed),false);assert.equal(journal.clearAiResumption!(s,scope,changed),false);}
 assert.equal(journal.clearAiResumption!(s,scope,command),true);assert.deepEqual(journal.readAiResumption!(s,scope),{state:'none'});
});
test('pending authority is isolated by user, company, conversation and original membership',()=>{
 assert.equal(typeof journal.saveAiResumption,'function');const s=storage();journal.saveAiResumption!(s,scope,command);
 for(const field of Object.keys(scope)){const other={...scope,[field]:'other'};assert.deepEqual(journal.readAiResumption!(s,other),{state:'none'});assert.equal(journal.saveAiResumption!(s,other,command),true);}
 assert.equal(s.length,5);journal.clearAiResumptions!(s,{userId:'user',companyId:'company',conversationId:'conversation'});assert.equal(s.length,3);
 journal.clearAiResumptions!(s,{userId:'user'});assert.equal(s.length,1);assert.deepEqual(journal.readAiResumption!(s,{...scope,userId:'other'}),{state:'pending',command});
});
test('corrupt, oversize, mismatched and unavailable storage block new writes',()=>{
 assert.equal(typeof journal.readAiResumption,'function');const s=storage();journal.saveAiResumption!(s,scope,command);const key=s.key(0)!;
 for(const raw of ['{bad','x'.repeat(4097),JSON.stringify({v:1,scope:{...scope,memberId:'rejoined'},command}),JSON.stringify({v:1,scope,command:{...command,previousRunId:'forged'}})]){
  s.setItem(key,raw);assert.deepEqual(journal.readAiResumption!(s,scope),{state:'blocked'});assert.equal(journal.saveAiResumption!(s,scope,command),false);assert.equal(s.getItem(key),raw);
 }
 assert.deepEqual(journal.readAiResumption!(null,scope),{state:'blocked'});assert.equal(journal.saveAiResumption!(null,scope,command),false);
 const broken={...storage(),setItem(){throw new Error('quota');}};assert.equal(journal.saveAiResumption!(broken,scope,command),false);
});
test('storage write and deletion must be confirmed, and cleanup stays in its own namespace',()=>{
 assert.equal(typeof journal.saveAiResumption,'function');const s=storage();assert.equal(journal.saveAiResumption!({...s,setItem(){}},scope,command),false);journal.saveAiResumption!(s,scope,command);
 assert.equal(journal.clearAiResumption!({...s,removeItem(){}},scope,command),false);s.setItem('dingbell:reply-pending:v1:unrelated','retain');
 assert.equal(journal.clearAiResumptions!(s,{userId:'user'}),true);assert.equal(s.getItem('dingbell:reply-pending:v1:unrelated'),'retain');
});
