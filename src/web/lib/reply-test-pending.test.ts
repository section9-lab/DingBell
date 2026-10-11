/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPendingReplyTest,savePendingReplyTest,clearPendingReplyTest } from './reply-test-pending.ts';
const scope={userId:'user',companyId:'company',memberId:'member',conversationId:'conversation'};
const input={requestId:'00000000-0000-4000-8000-000000000001',messageId:'message',policyId:'policy',stage:'presale' as const,language:'ru' as const};
function storage(){const values=new Map<string,string>();return {values,getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};}
test('pending tests persist only scoped identifiers, never replace an uncertain request implicitly',()=>{
  const s=storage();assert.deepEqual(readPendingReplyTest(s,scope),{state:'none'});assert.equal(savePendingReplyTest(s,scope,input),true);
  assert.deepEqual(readPendingReplyTest(s,scope),{state:'pending',request:input});assert.equal(savePendingReplyTest(s,scope,input),true);
  const other={...input,requestId:crypto.randomUUID()};assert.equal(savePendingReplyTest(s,scope,other),false);
  assert.equal(clearPendingReplyTest(s,scope,other),false);assert.equal(clearPendingReplyTest(s,scope,input),true);assert.equal(s.values.size,0);
});
test('rejoined members and other users, companies and conversations cannot recover the same request',()=>{
  const s=storage();savePendingReplyTest(s,scope,input);
  for(const field of Object.keys(scope))assert.deepEqual(readPendingReplyTest(s,{...scope,[field]:'other'}),{state:'none'});
});
test('storage denial, corruption, and failed persistence stop a new request',()=>{
  const s=storage();savePendingReplyTest(s,scope,input);s.values.set([...s.values.keys()][0],'{broken');
  assert.deepEqual(readPendingReplyTest(s,scope),{state:'blocked'});assert.equal(savePendingReplyTest(s,scope,input),false);
  assert.equal(savePendingReplyTest({...storage(),setItem:()=>{}},scope,input),false);
  assert.deepEqual(readPendingReplyTest(null,scope),{state:'blocked'});assert.equal(savePendingReplyTest(null,scope,input),false);
  assert.equal(savePendingReplyTest(storage(),scope,{...input,question:'not allowed'} as typeof input),false);
});
