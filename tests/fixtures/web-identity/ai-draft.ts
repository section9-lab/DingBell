import {createPolicy,changePolicy} from '../../../src/modules/reply-policies/storage.ts';
import {ensureControlDirectory} from '../../../src/modules/conversations/control-storage.ts';
import {getConversationController,type ControlBindings} from '../../../src/modules/conversations/control-bindings.ts';
import {changeAiBudget,reserveAiExecution} from '../../../src/modules/ai-runs/storage.ts';
import {submitAiAnswer} from '../../../src/modules/ai-runs/answer.ts';
import {prepareKnowledge,knowledgeHash} from '../../../src/modules/knowledge/content.ts';
import {writeKnowledge,publishKnowledge,withdrawKnowledge} from '../../../src/modules/knowledge/storage.ts';
import {knowledgeProfile} from '../../../src/modules/knowledge/vectorize.ts';
const check=(value:unknown)=>{if(!value)throw new Error('synthetic AI draft setup failed');};
/** Actual business services and controller; only the already-retrieved knowledge receipt is synthetic. */
export async function seedAiDraft(env:ControlBindings,body:{conversationId?:string;withdraw?:string}){
 const db=env.DB!,session=await db.prepare("SELECT id FROM session WHERE user_id='web-owner' AND expires_at>? ORDER BY created_at DESC LIMIT 1").bind(Date.now()).first<{id:string}>();check(session);
 const actor={orgId:'company-a',actorUserId:'web-owner',sessionId:session!.id,expectedMemberId:'owner-a'};
 if(body.withdraw){check(await withdrawKnowledge(db,actor,body.withdraw,2));return {withdrawn:true};}
 const conversationId=body.conversationId!;check(/^[0-9a-f-]{36}$/.test(conversationId));
 const directory=await ensureControlDirectory(db,actor,conversationId,Date.now());check(directory);const scope=directory!.scope,storeId=scope.storeId;
 await db.prepare("UPDATE conversation SET platform_status='Opened' WHERE id=?").bind(conversationId).run();
 const policyId=crypto.randomUUID(),config={kind:'automatic' as const,name:'Synthetic draft',storeIds:[storeId],priority:50,stages:['presale' as const],mode:'automatic' as const,language:'customer' as const,tone:'concise' as const,instructions:''};
 check(await createPolicy(db,actor,policyId,config));check(await changePolicy(db,actor,policyId,1,{action:'test'},crypto.randomUUID()));check(await changePolicy(db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
 const messageId=crypto.randomUUID(),now=Date.now(),question='Какая ширина этого органайзера?';
 await db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,'company-a',?,?,?,'Customer','inbound',?,0,0,?,?,'incremental')").bind(messageId,storeId,conversationId,messageId,JSON.stringify([question]),now,now).run();
 const controller=getConversationController(env,scope.controllerId),request={runId:crypto.randomUUID(),expectedVersion:0,messageId,policyId,stage:'presale',language:'ru'};
 const started=await controller.startAi(scope,request);check(started.outcome==='accepted');if(started.outcome!=='accepted')throw new Error('synthetic draft start');const run=started.receipt.run;
 const read=(s:typeof scope,id:string)=>controller.readAiRun(s,id),budgetId=crypto.randomUUID(),startsAt=Math.floor(now/86400000)*86400000;
 check((await changeAiBudget(db,actor,{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:1000000,maxRuns:10})).outcome==='applied');
 check((await changeAiBudget(db,actor,{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true})).outcome==='applied');
 const model={provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-answer-v1',maxInputTokens:100,maxOutputTokens:10,
  pricing:{version:'synthetic',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}};
 check((await reserveAiExecution(db,read,scope,run.request.runId,budgetId,{model,maxGenerations:3})).outcome==='reserved');
 const documentId=crypto.randomUUID(),ks={kind:'guide' as const,storeId,productRef:null,language:'ru' as const},prepared=await prepareKnowledge('company-a',documentId,1,ks,{title:'桌面收纳盒 · 尺寸说明',source:{format:'text',content:'Ширина стандартной модели — 26 см. Проверьте выбранный вариант перед заказом.'}});
 check(await writeKnowledge(db,actor,documentId,ks,prepared,0,crypto.randomUUID()));
 await db.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='draft',tested_at=1,published_profile=?,published_mutation_id='published',published_at=2 WHERE document_id=?").bind(knowledgeProfile.id,knowledgeProfile.id,documentId).run();check(await publishKnowledge(db,actor,documentId,1));
 const chunk=prepared.chunks[0],evidence={runId:run.request.runId,scope:{storeId,productRef:null,language:'ru'},questionHash:await knowledgeHash(question),chunks:[{documentId,revision:1,chunkId:chunk.id,bodyHash:chunk.bodyHash,body:chunk.body,title:prepared.title,contentHash:prepared.contentHash,score:.8}]};
 await db.prepare('INSERT INTO ai_knowledge_query(run_id,config,scope,question_hash,reserved_micros,created_at,vectors,evidence) VALUES(?,?,?,?,0,1,?,?)').bind(run.request.runId,JSON.stringify({profile:knowledgeProfile.id,priceVersion:'synthetic-zero',maxInputTokens:60000,inputMicrosPerMillion:0}),JSON.stringify(evidence.scope),evidence.questionHash,JSON.stringify(Array(1024).fill(0)),JSON.stringify(evidence)).run();
 const text='Здравствуйте! Ширина стандартной модели — 26 см. Перед заказом проверьте выбранный вариант.';
 check((await submitAiAnswer(env,read,scope,run.request.runId,{body:text,citations:[chunk.id]})).status==='submitted');
 check((await controller.requestHandoff(scope,run.request.runId,{reason:'merchant_decision',summary:'Review the cited draft before sending.',neededInformation:[]})).outcome==='accepted');
 return {runId:run.request.runId,documentId,body:text,question};
}
