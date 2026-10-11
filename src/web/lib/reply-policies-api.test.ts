import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReplyPolicy, readReplyPolicy, readReplyPolicies, updateReplyPolicy } from './reply-policies-api.ts';

const config={kind:'automatic' as const,name:'售前接待',storeIds:['store-a'],priority:50,stages:['presale' as const],mode:'suggest' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
const policy={id:'p/id',kind:'automatic',version:1,draftRevision:1,testedRevision:null,testedTimeZone:null,draftBaseRevision:null,draftRollbackOf:null,draft:config,enabled:false,published:null,updatedAt:'2026-10-10T00:00:00.000Z'};
const detail={companyId:'a/b',policy,history:{versions:[],nextBefore:null}};
test('policy requests bind company and policy IDs and send exact versioned actions',async t=>{
  const calls:{url:string;init:RequestInit}[]=[];
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{calls.push({url,init});return Response.json(detail);});
  assert.deepEqual(await readReplyPolicy('a/b','p/id'),detail);
  assert.equal(calls[0].url,'/api/companies/a%2Fb/reply-policies/p%2Fid');
  await updateReplyPolicy('a/b','p/id','draft',{expectedVersion:1,config});
  assert.deepEqual(JSON.parse(String(calls[1].init.body)),{expectedVersion:1,config});
  assert.equal(calls[1].init.method,'POST');
});
test('policy responses reject wrong scope, contradictory versions and malformed publication snapshots',async t=>{
  const publication={revision:1,schemaVersion:1,config,timeZone:'UTC',publishedBy:'admin',publishedAt:policy.updatedAt,rollbackOf:null};
  for(const value of [
    {...detail,companyId:'other'},{...detail,policy:{...policy,id:'other'}},
    {...detail,policy:{...policy,testedRevision:2}}, {...detail,policy:{...policy,enabled:true}},
    {...detail,policy:{...policy,kind:'notification'}},
    {...detail,policy:{...policy,published:{...publication,timeZone:'Mars/Olympus'}}},
    {...detail,policy:{...policy,published:publication},history:{versions:[],nextBefore:null}},
    {...detail,history:{versions:[],nextBefore:1}},
  ]) {
    const mock=t.mock.method(globalThis,'fetch',async()=>Response.json(value));
    await assert.rejects(readReplyPolicy('a/b','p/id'),{code:'INVALID_RESPONSE'});mock.mock.restore();
  }
});
test('policy lists preserve their kind and an uncertain write is attempted only once',async t=>{
  const mock=t.mock.method(globalThis,'fetch',async()=>Response.json({companyId:'a/b',kind:'notification',policies:[],nextAfter:null}));
  await assert.rejects(readReplyPolicies('a/b','automatic'),{code:'INVALID_RESPONSE'});mock.mock.restore();
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('connection lost');});
  await assert.rejects(createReplyPolicy('a/b','p/id',config),{code:'OPERATION_UNCONFIRMED'});assert.equal(calls,1);
});
