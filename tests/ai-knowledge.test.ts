import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {URL} from 'node:url';
import {conversationControlFixture} from './fixtures/conversation-control.ts';
import {createPolicy,changePolicy} from '../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../src/modules/conversations/control-storage.ts';
import {changeAiBudget,reserveAiExecution} from '../src/modules/ai-runs/storage.ts';
import {prepareKnowledge} from '../src/modules/knowledge/content.ts';
import {writeKnowledge,publishKnowledge,withdrawKnowledge} from '../src/modules/knowledge/storage.ts';
import {knowledgeManifest,indexKnowledge,knowledgeProfile} from '../src/modules/knowledge/vectorize.ts';
import type {AiRunReader} from '../src/modules/ai-runs/storage.ts';
const vector=Array.from({length:1024},(_,i)=>i===0?1:0);
const config={model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-knowledge-v1',maxInputTokens:100,maxOutputTokens:10,
 pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}},maxGenerations:3};
const queryConfig={profile:knowledgeProfile.id,priceVersion:'synthetic-query',maxInputTokens:60000,inputMicrosPerMillion:1000};
async function api(){const m=await import('../src/modules/ai-runs/knowledge.ts').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return null;throw e;});assert.equal(typeof m?.searchAiKnowledge,'function','AI knowledge retrieval needs a run-bound authorization and production embedding allowance');return m!;}
async function fixture(upTo?:string){
 const f=await conversationControlFixture(upTo,{aiEnabled:'true'}),actor={...f.actor(),expectedMemberId:'owner-member'},policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const policy={kind:'automatic' as const,name:'Knowledge',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,policy));assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const scope=(await ensureControlDirectory(f.db,actor,'conv',Date.now()))!.scope;
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('question','org','store','conv','question','Customer','inbound','[\"Какая ширина?\"]',0,0,1,1,'incremental')").run();
  const request={runId:crypto.randomUUID(),expectedVersion:0,messageId:'question',policyId,stage:'presale',language:'ru'},started=await f.call('ai-start',{request},scope);assert.equal(started.body.outcome,'accepted');const run=started.body.receipt.run;
  const read:AiRunReader=async(s,id)=>(await f.call('ai-read',{runId:id},s)).body;
  const budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
  assert.equal((await changeAiBudget(f.db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:10})).outcome,'applied');
  assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
  const admitted=await reserveAiExecution(f.db,read,scope,request.runId,budgetId,config);assert.equal(admitted.outcome,'reserved');
  const rows=new Map<string,VectorizeVector>();let calls=0,beforeQuery:(()=>Promise<void>)|undefined,embedding:(()=>Promise<void>)|undefined;
  const index={upsert:async(values:VectorizeVector[])=>{for(const v of values)rows.set(v.id,structuredClone(v));return {mutationId:'synthetic'};},query:async(_v:number[],options:VectorizeQueryOptions)=>{
   const matches=[...rows.values()].filter(row=>row.namespace===options.namespace&&Object.entries(options.filter??{}).every(([key,value])=>value&&typeof value==='object'&&'$in' in value?Array.isArray(value.$in)&&value.$in.includes(row.metadata![key] as string):row.metadata?.[key]===value)).map(({values,...row})=>({...row,score:.8})).slice(0,options.topK);
   await beforeQuery?.();return {matches};
  }} as unknown as Vectorize;
  const env={DB:f.db,AI_RECEPTION_ENABLED:'true',AI_KNOWLEDGE_QUERY_CONFIG_JSON:JSON.stringify(queryConfig),KNOWLEDGE_INDEX:index,
   KNOWLEDGE_AI:{run:async(model:string,input:any)=>{calls++;assert.equal(model,knowledgeProfile.model);assert.deepEqual(input,{text:[run.admission.question],truncate_inputs:false});await embedding?.();return {shape:[1,1024],data:[vector]};}} as unknown as Ai};
  async function source(title:string,overrides:Record<string,any>={}){
   const id=crypto.randomUUID(),ks={kind:'guide' as const,storeId:'store',productRef:null,language:'ru' as const,...overrides},prepared=await prepareKnowledge('org',id,1,ks,{title,source:{format:'text',content:'Ширина — 26 см.'}});
   assert.equal(await writeKnowledge(f.db,actor,id,ks,prepared,0,crypto.randomUUID()),true);
   await indexKnowledge(index,await knowledgeManifest('org',id,1,ks,prepared),prepared.chunks.map(()=>vector),true);
   await f.db.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='draft',tested_at=1,published_profile=?,published_mutation_id='published',published_at=2 WHERE document_id=?").bind(knowledgeProfile.id,knowledgeProfile.id,id).run();
   assert.ok(await publishKnowledge(f.db,actor,id,1));return {id,prepared};
  }
  return {f,actor,scope,run,read,budgetId,env,source,rows,calls:()=>calls,beforeQuery:(fn:typeof beforeQuery)=>{beforeQuery=fn;},embedding:(fn:typeof embedding)=>{embedding=fn;}};
 }catch(e){await f.close();throw e;}
}
test('AI knowledge uses published scoped facts without an employee session, and reuses one durably budgeted embedding',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const source=await x.source('published');await x.source('other-language',{language:'en'});await x.source('unbound-product',{productRef:'unrelated'});
 await x.f.db.prepare('DELETE FROM session').run();
 const result=await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId);assert.equal(result.status,'found');assert.equal(result.canSend,false);assert.deepEqual(result.evidence.chunks.map((r:any)=>r.documentId),[source.id]);assert.equal(result.evidence.chunks[0].body,source.prepared.chunks[0].body);
 assert.equal(x.calls(),1);const held=await x.f.db.prepare('SELECT reserved_micros FROM ai_budget WHERE id=?').bind(x.budgetId).first('reserved_micros');assert.equal(held,390);
 assert.deepEqual(await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId),result);assert.equal(x.calls(),1);assert.equal(await x.f.db.prepare('SELECT COUNT(*) FROM ai_knowledge_query').first('COUNT(*)'),1);
});
test('AI retrieval rejects scope forgery and takeover, and does not return withdrawn knowledge across an async query',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const source=await x.source('published');
 assert.equal((await m.searchAiKnowledge(x.env,x.read,{...x.scope,organizationId:'foreign'},x.run.request.runId)).status,'unavailable');assert.equal(x.calls(),0);
 let changed=false;x.beforeQuery(async()=>{if(!changed){changed=true;assert.ok(await withdrawKnowledge(x.f.db,x.actor,source.id,2));}});
 const removed=await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId);assert.equal(removed.status,'empty');
 assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}},x.scope)).body.outcome,'accepted');
 assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unavailable');assert.equal(x.calls(),1);
});
test('an ambiguous embedding response is never retried and insufficient production funds make no model request',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);await x.source('published');
 x.env.AI_KNOWLEDGE_QUERY_CONFIG_JSON=JSON.stringify({...queryConfig,inputMicrosPerMillion:1000000000});assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unavailable');assert.equal(x.calls(),0);
 x.env.AI_KNOWLEDGE_QUERY_CONFIG_JSON=JSON.stringify(queryConfig);x.embedding(async()=>{throw new Error('synthetic-response-loss');});
 assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unconfirmed');assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unconfirmed');assert.equal(x.calls(),1);
 assert.equal(await x.f.db.prepare('SELECT reserved_micros FROM ai_budget WHERE id=?').bind(x.budgetId).first('reserved_micros'),390);
});
test('concurrent searches share one provider permit; saved evidence is immutable and must still be currently published',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);const source=await x.source('published');let entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>{entered=r;}),waiting=new Promise<void>(r=>{release=r;});x.embedding(async()=>{entered();await waiting;});
 const first=m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId);await started;
 try{assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unconfirmed');assert.equal(x.calls(),1);}finally{release();}
 const result=await first;assert.equal(result.status,'found');assert.deepEqual(await m.reviewAiKnowledgeEvidence(x.env,x.read,x.scope,x.run.request.runId,result.evidence),result.evidence);
 const forged=structuredClone(result.evidence!);forged.chunks[0].body='invented';assert.equal(await m.reviewAiKnowledgeEvidence(x.env,x.read,x.scope,x.run.request.runId,forged),null);
 for(const sql of ["UPDATE ai_knowledge_query SET question_hash=printf('%064d',0)","UPDATE ai_knowledge_query SET config='{}'","UPDATE ai_knowledge_query SET vectors=NULL,evidence=NULL","DELETE FROM ai_knowledge_query"])
  await assert.rejects(()=>x.f.db.prepare(sql).run(),/AI_KNOWLEDGE_QUERY_IMMUTABLE/);
 assert.ok(await withdrawKnowledge(x.f.db,x.actor,source.id,2));assert.equal(await m.reviewAiKnowledgeEvidence(x.env,x.read,x.scope,x.run.request.runId,result.evidence),null);
 assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'changed');assert.equal(x.calls(),1);
});
test('failed query insertion rolls back its allowance and a later takeover withholds a completed embedding',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);await x.source('published');
 await x.f.db.prepare("CREATE TRIGGER synthetic_query_failure BEFORE INSERT ON ai_knowledge_query BEGIN SELECT RAISE(ABORT,'SYNTHETIC_QUERY_FAILURE'); END").run();
 assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unavailable');assert.equal(x.calls(),0);
 assert.equal(await x.f.db.prepare('SELECT reserved_micros FROM ai_budget WHERE id=?').bind(x.budgetId).first('reserved_micros'),330);
 await x.f.db.prepare('DROP TRIGGER synthetic_query_failure').run();
 x.embedding(async()=>{assert.equal((await x.f.call('execute',{command:{commandId:crypto.randomUUID(),action:'takeover',expectedVersion:1}},x.scope)).body.outcome,'accepted');});
 assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unavailable');assert.equal(x.calls(),1);
 assert.equal(await x.f.db.prepare('SELECT evidence FROM ai_knowledge_query').first('evidence'),null);assert.notEqual(await x.f.db.prepare('SELECT vectors FROM ai_knowledge_query').first('vectors'),null);
});
test('budget shutdown or global disable observed after a permit prevents the embedding request',{timeout:30000},async t=>{
 const m=await api();for(const kind of ['budget','global']){
  const x=await fixture();try{await x.source('published');let changed=false;
   const read:AiRunReader=async(scope,id)=>{const result=await x.read(scope,id);if(!changed&&await x.f.db.prepare('SELECT 1 FROM ai_knowledge_query').first()){
    changed=true;if(kind==='global')x.env.AI_RECEPTION_ENABLED='false';else assert.equal((await changeAiBudget(x.f.db,x.actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId:x.budgetId,expectedRevision:1,enabled:false})).outcome,'applied');
   }return result;};
   assert.equal((await m.searchAiKnowledge(x.env,read,x.scope,x.run.request.runId)).status,'unavailable');assert.ok(changed);assert.equal(x.calls(),0,kind+' must stop the request before external work');
  }finally{await x.f.close();}
 }
});
test('missing or invalid embedding prices fail closed; explicit zero still consumes the single persistent query permit',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);await x.source('published');
 for(const value of [{},{...queryConfig,inputMicrosPerMillion:-1},{...queryConfig,maxInputTokens:59999},{...queryConfig,profile:'other'},{...queryConfig,unrecognized:true}]){
  x.env.AI_KNOWLEDGE_QUERY_CONFIG_JSON=JSON.stringify(value);assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'unavailable');
 }
 assert.equal(x.calls(),0);assert.equal(await x.f.db.prepare('SELECT count(*) n FROM ai_knowledge_query').first('n'),0);
 x.env.AI_KNOWLEDGE_QUERY_CONFIG_JSON=JSON.stringify({...queryConfig,inputMicrosPerMillion:0});assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'found');
 assert.equal(await x.f.db.prepare('SELECT reserved_micros FROM ai_knowledge_query').first('reserved_micros'),0);await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId);assert.equal(x.calls(),1);
});
test('the product filter comes only from the original platform message and a changed mapping invalidates saved evidence',{timeout:30000},async t=>{
 const m=await api(),x=await fixture();t.after(x.f.close);
 for(const id of ['product-a','product-b'])await x.f.db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'org','store','{}',1,1,1,1)").bind(id).run();
 await x.f.db.prepare("UPDATE message SET sku='platform-sku' WHERE id='question'").run();
 await x.f.db.prepare("INSERT INTO product_sku(organization_id,store_id,sku,product_id,source) VALUES('org','store','platform-sku','product-a','list')").run();
 const expected=await x.source('correct product',{productRef:'product-a'});await x.source('other product',{productRef:'product-b'});
 const result=await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId);assert.equal(result.status,'found');assert.deepEqual(result.evidence!.chunks.map(c=>c.documentId),[expected.id]);
 await x.f.db.prepare("INSERT INTO product_sku(organization_id,store_id,sku,product_id,source) VALUES('org','store','platform-sku','product-b','list')").run();
 assert.equal(await m.reviewAiKnowledgeEvidence(x.env,x.read,x.scope,x.run.request.runId,result.evidence),null);assert.equal((await m.searchAiKnowledge(x.env,x.read,x.scope,x.run.request.runId)).status,'changed');assert.equal(x.calls(),1);
});
test('0041 preserves existing financial and knowledge rows, rolls back failures and never creates historical query grants',{timeout:30000},async t=>{
 const x=await fixture('0040');t.after(x.f.close);await x.source('prior knowledge');
 const tables=['ai_budget','ai_execution','ai_generation','conversation_control','conversation_control_event','knowledge_document','knowledge_revision','knowledge_chunk'];
 const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(async table=>(await x.f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results)));const before=await snapshot();
 const statements=(await readFile(new URL('../migrations/0041_ai_knowledge_query.sql',import.meta.url),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean);
 await assert.rejects(()=>x.f.db.batch([...statements.map(s=>x.f.db.prepare(s)),x.f.db.prepare('SELECT * FROM synthetic_missing_table')]),/synthetic_missing_table/);
 assert.equal(await x.f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='ai_knowledge_query'").first('n'),0);assert.equal(await snapshot(),before);
 await x.f.db.batch(statements.map(s=>x.f.db.prepare(s)));assert.equal(await snapshot(),before);assert.equal(await x.f.db.prepare('SELECT count(*) n FROM ai_knowledge_query').first('n'),0);
 assert.deepEqual((await x.f.db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
