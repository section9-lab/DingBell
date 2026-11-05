import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../src/modules/conversations/control-storage.ts';
import {changeAiBudget,reserveAiExecution,type AiRunReader} from '../src/modules/ai-runs/storage.ts';
import {prepareKnowledge} from '../src/modules/knowledge/content.ts';
import {writeKnowledge,withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {approveTextKnowledge,grepPublishedText,resolveTextKnowledgeCitations} from '../src/modules/knowledge/text-profile.ts';
import {grepAiKnowledge,reviewAiTextEvidence,readRunKnowledgeEvidence} from '../src/modules/ai-runs/text-knowledge.ts';
const config={model:{provider:'nvidia',model:'nvidia/nemotron-3.5-super-vl-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-knowledge-v1',maxInputTokens:100,maxOutputTokens:10,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}},maxGenerations:3};
async function api(){const m=await import('../src/modules/ai-runs/text-knowledge.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.grepAiKnowledge,'function');return m!;}
async function fixture(){
 const f=await conversationControlFixture(undefined,{}),actor={...f.actor(),expectedMemberId:'owner-member'},policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const policy={kind:'automatic' as const,name:'Knowledge',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,policy));
  assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));
  assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const scope=(await ensureControlDirectory(f.db,actor,'conv',Date.now()))!.scope;
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('question','org','store','conv','question','Customer','inbound','[\"Какая ширина?\"]',0,0,1,1,'incremental')").run();
  const request={runId:crypto.randomUUID(),expectedVersion:0,messageId:'question',policyId,stage:'presale',language:'ru'};
  const started=await f.call('ai-start',{request},scope);assert.equal(started.body.outcome,'accepted');const run=started.body.receipt.run;
  const read:AiRunReader=async(s,id)=>(await f.call('ai-read',{runId:id},s)).body;
  const budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
  assert.equal((await changeAiBudget(f.db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:10})).outcome,'applied');
  assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
  const admitted=await reserveAiExecution(f.db,read,scope,request.runId,budgetId,config);assert.equal(admitted.outcome,'reserved');
  const env={DB:f.db};
  async function source(title:string,content:string,overrides:Record<string,unknown>={}){
   const id=crypto.randomUUID(),ks={kind:'guide' as const,storeId:'store',productRef:null,language:'ru' as const,...overrides};
   const prepared=await prepareKnowledge('org',id,1,ks,{title,source:{format:'markdown',content}});
   assert.equal(await writeKnowledge(f.db,actor,id,ks,prepared,0,crypto.randomUUID()),true);
   return {id,prepared};
  }
  return {f,actor,scope,run,read,budgetId,env,source};
 }catch(e){await f.close();throw e;}
}
test('approved text knowledge is readable without any embedding model or vector index',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 const guide=await x.source('Правила доставки','## Ширина\nШирина стола — 26 см по внешнему краю.\n\n## Возврат\nВозврат принимается 14 дней.');
 const hidden=await x.source('Черновик','Секретный срок — 99 дней.');
 assert.equal(await approveTextKnowledge(x.f.db,{orgId:'org',actorUserId:x.actor.actorUserId,sessionId:x.actor.sessionId},guide.id,1),true);
 const listed=(await grepPublishedText(x.f.db,'org',{storeId:'store',productRef:null,language:'ru'},'ширина')).map(row=>row.documentId);
 assert.deepEqual(listed,[guide.id]);
 assert.deepEqual(await grepPublishedText(x.f.db,'org',{storeId:'store',productRef:null,language:'ru'},'99'),[]);
 const result=await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина стола'});
 assert.equal(result.status,'found');assert.equal(result.canSend,false);
 assert.deepEqual(result.evidence!.chunks.map((row:any)=>row.documentId),[guide.id]);
 assert.ok(result.evidence!.chunks[0].body.includes('26'));
 assert.equal(hidden.id!==guide.id,true);
 assert.deepEqual(await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина стола'}),result);
 const actor={orgId:'org',actorUserId:x.actor.actorUserId,sessionId:x.actor.sessionId};
 const second=await x.source('Оплата','Оплата картой или наличными при получении.');
 assert.equal(await approveTextKnowledge(x.f.db,actor,second.id,1),true);
 const grown=await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'оплата картой'});
 assert.equal(grown.status,'found');assert.equal(grown.evidence!.chunks.length,2);
 assert.deepEqual(grown.evidence!.chunks.map((row:any)=>row.documentId).sort(),[guide.id,second.id].sort());
 assert.equal(grown.evidence!.chunks[0].chunkId,result.evidence!.chunks[0].chunkId);
 const saved=await readRunKnowledgeEvidence(x.f.db,x.run.request.runId);
 assert.equal(saved?.profile,'text-grep-2400-v1');assert.equal(saved?.raw,JSON.stringify(grown.evidence!.chunks));
 assert.deepEqual(await m.reviewAiTextEvidence(x.env,x.read,x.scope,x.run.request.runId,grown.evidence),grown.evidence);
 assert.equal(await m.reviewAiTextEvidence(x.env,x.read,x.scope,x.run.request.runId,result.evidence),null);
 const citations=await resolveTextKnowledgeCitations(x.f.db,'org',grown.evidence!.scope,grown.evidence!.chunks);
 assert.equal(citations?.length,2);
});
test('withdrawn text is rejected and frozen evidence can never shrink',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 const guide=await x.source('Правила доставки','Ширина стола — 26 см.');
 const actor={orgId:'org',actorUserId:x.actor.actorUserId,sessionId:x.actor.sessionId};
 assert.equal(await approveTextKnowledge(x.f.db,actor,guide.id,1),true);
 const first=await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина'});
 assert.equal(first.status,'found');
 assert.equal(await x.f.db.prepare("UPDATE knowledge_chunk SET body='Ширина стола — 40 см.' WHERE document_id=?").bind(guide.id).run().then(()=>false,()=>true),true);
 assert.ok(await withdrawKnowledge(x.f.db,actor,guide.id,2));
 assert.equal(await m.reviewAiTextEvidence(x.env,x.read,x.scope,x.run.request.runId,first.evidence),null);
 assert.equal((await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина'})).status,'changed');
 await assert.rejects(()=>x.f.db.prepare("UPDATE ai_knowledge_evidence SET chunks='[]' WHERE run_id=?").bind(x.run.request.runId).run(),/AI_KNOWLEDGE_EVIDENCE_IMMUTABLE/);
 await assert.rejects(()=>x.f.db.prepare('DELETE FROM ai_knowledge_evidence WHERE run_id=?').bind(x.run.request.runId).run(),/AI_KNOWLEDGE_EVIDENCE_IMMUTABLE/);
});
test('an unapproved revision and a taken-over run never answer with text knowledge',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 await x.source('Правила доставки','Ширина стола — 26 см.');
 assert.equal((await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина'})).status,'empty');
 assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}},x.scope)).body.outcome,'accepted');
 assert.equal((await m.grepAiKnowledge(x.env,x.read,x.scope,x.run.request.runId,{query:'ширина'})).status,'unavailable');
 assert.equal((await m.grepAiKnowledge(x.env,x.read,{...x.scope,organizationId:'foreign'},x.run.request.runId,{query:'ширина'})).status,'unavailable');
});
test('text approval publishes the saved revision with the text profile in one commit',{timeout:30000},async t=>{
 const x=await fixture();t.after(x.f.close);
 const actor={orgId:'org',actorUserId:x.actor.actorUserId,sessionId:x.actor.sessionId};
 const guide=await x.source('Правила доставки','Ширина стола — 26 см.');
 assert.equal(await approveTextKnowledge(x.f.db,actor,guide.id,1),true);
 const row=await x.f.db.prepare('SELECT published_profile,published_at FROM knowledge_revision WHERE document_id=?').bind(guide.id).first<any>();
 assert.equal(row.published_profile,'text-grep-2400-v1');assert.ok(row.published_at!==null);
 assert.equal(await x.f.db.prepare('SELECT active_revision FROM knowledge_document WHERE id=?').bind(guide.id).first('active_revision'),1);
 assert.equal(await approveTextKnowledge(x.f.db,actor,guide.id,1),false);
});
