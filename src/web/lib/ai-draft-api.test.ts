import assert from 'node:assert/strict';
import {test} from 'node:test';
async function api(){const m=await import('./ai-draft-api.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.readAiDraft,'function');return m!;}
const value={companyId:'company',conversationId:'conversation',viewerMemberId:'member',canSend:false,draft:null};
test('draft reads encode scope and bind response identity without writing or sending',async t=>{
 const m=await api(),calls:any[]=[];t.mock.method(globalThis,'fetch',async(url:any,init:any)=>{calls.push({url,init});return Response.json(value);});
 assert.deepEqual(await m.readAiDraft('company','conversation','member'),value);assert.match(calls[0].url,/\/api\/companies\/company\/conversations\/conversation\/ai-draft$/);
 assert.equal(calls[0].init.headers.get('X-DingBell-Member-Id'),'member');assert.ok(!calls[0].init.method||calls[0].init.method==='GET');assert.equal(calls[0].init.body,undefined);
 await assert.rejects(m.readAiDraft('','conversation','member'));assert.equal(calls.length,1);
});
test('a forged member, scope, send permission or draft validity is never displayed',async t=>{
 const m=await api();let payload:unknown=value;t.mock.method(globalThis,'fetch',async()=>Response.json(payload));
 for(const patch of [{companyId:'foreign'},{conversationId:'foreign'},{viewerMemberId:'replacement'},{canSend:true}]){payload={...value,...patch};await assert.rejects(m.readAiDraft('company','conversation','member'));}
 const draft={runId:crypto.randomUUID(),body:'Draft',question:'Question',language:'ru',createdAt:new Date().toISOString(),status:'current',reason:'source_changed',citations:[{documentId:crypto.randomUUID(),revision:1,chunkId:'a'.repeat(64),title:'Source',body:'Fact'}]};
 payload={...value,draft};await assert.rejects(m.readAiDraft('company','conversation','member'));
});
