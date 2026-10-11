import assert from 'node:assert/strict';
import {conversationControlFixture} from './conversation-control.ts';
import {createPolicy,changePolicy} from '../../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../../src/modules/conversations/control-storage.ts';
import {changeAiBudget,reserveAiExecution} from '../../src/modules/ai-runs/storage.ts';
import {prepareKnowledge} from '../../src/modules/knowledge/content.ts';
import {writeKnowledge,publishKnowledge} from '../../src/modules/knowledge/storage.ts';
import {knowledgeProfile} from '../../src/modules/knowledge/vectorize.ts';
import type {AiRunReader} from '../../src/modules/ai-runs/storage.ts';
export async function aiAnswerFixture(promptVersion='support-answer-v1',config:{outboundEnabled?:string;aiEnabled?:string;aiOutboundEnabled?:string;aiTimeoutMs?:number}={}){
 const f=await conversationControlFixture(undefined,{aiEnabled:'true',...config}),actor={...f.actor(),expectedMemberId:'owner-member'},policyId=crypto.randomUUID();
 try{
  await f.db.prepare("UPDATE store SET status='verified' WHERE id='store'").run();
  const policy={kind:'automatic' as const,name:'Answer',storeIds:['store'],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
  assert.ok(await createPolicy(f.db,actor,policyId,policy));assert.ok(await changePolicy(f.db,actor,policyId,1,{action:'test'},crypto.randomUUID()));assert.ok(await changePolicy(f.db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const scope=(await ensureControlDirectory(f.db,actor,'conv',Date.now()))!.scope;
  await f.db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES('question','org','store','conv','question','Customer','inbound','[\"Какая ширина?\"]',0,0,1,1,'incremental')").run();
  const request={runId:crypto.randomUUID(),expectedVersion:0,messageId:'question',policyId,stage:'presale',language:'ru'},started=await f.call('ai-start',{request},scope);assert.equal(started.body.outcome,'accepted');const run=started.body.receipt.run;
  const read:AiRunReader=async(s,id)=>(await f.call('ai-read',{runId:id},s)).body,budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;
  assert.equal((await changeAiBudget(f.db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:10})).outcome,'applied');
  assert.equal((await changeAiBudget(f.db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome,'applied');
  const config={model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion,maxInputTokens:100,maxOutputTokens:10,
   pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}},maxGenerations:3};
  assert.equal((await reserveAiExecution(f.db,read,scope,request.runId,budgetId,config)).outcome,'reserved');
  const documentId=crypto.randomUUID(),ks={kind:'guide' as const,storeId:'store',productRef:null,language:'ru' as const},prepared=await prepareKnowledge('org',documentId,1,ks,{title:'Width',source:{format:'text',content:'Ширина — 26 см.'}});
  assert.ok(await writeKnowledge(f.db,actor,documentId,ks,prepared,0,crypto.randomUUID()));
  await f.db.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='draft',tested_at=1,published_profile=?,published_mutation_id='published',published_at=2 WHERE document_id=?").bind(knowledgeProfile.id,knowledgeProfile.id,documentId).run();assert.ok(await publishKnowledge(f.db,actor,documentId,1));
  // Seed the persisted, immutable retrieval receipt; separate knowledge tests exercise the external embedding/vector adapters.
  const chunk=prepared.chunks[0],evidence={runId:run.request.runId,scope:{storeId:'store',productRef:null,language:'ru'},questionHash:await (await import('../../src/modules/knowledge/content.ts')).knowledgeHash(run.admission.question),chunks:[{documentId,revision:1,chunkId:chunk.id,bodyHash:chunk.bodyHash,body:chunk.body,title:prepared.title,contentHash:prepared.contentHash,score:.8}]};
  await f.db.prepare('INSERT INTO ai_knowledge_query(run_id,config,scope,question_hash,reserved_micros,created_at,vectors,evidence) VALUES(?,?,?,?,0,1,?,?)').bind(run.request.runId,JSON.stringify({profile:knowledgeProfile.id,priceVersion:'synthetic-zero',maxInputTokens:60000,inputMicrosPerMillion:0}),JSON.stringify(evidence.scope),evidence.questionHash,JSON.stringify(Array(1024).fill(0)),JSON.stringify(evidence)).run();
  const env={DB:f.db,AI_RECEPTION_ENABLED:'true'},input={body:'Ширина этой модели — 26 см.',citations:[chunk.id]};
  return {f,actor,scope,run,read,env,input,evidence,documentId};
 }catch(e){await f.close();throw e;}
}
