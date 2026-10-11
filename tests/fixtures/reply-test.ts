import assert from 'node:assert/strict';
import { ensureControlDirectory } from '../../src/modules/conversations/control-storage.ts';
import { createPolicy, changePolicy } from '../../src/modules/reply-policies/storage.ts';
import { prepareKnowledge, knowledgeHash } from '../../src/modules/knowledge/content.ts';
import { writeKnowledge, publishKnowledge } from '../../src/modules/knowledge/storage.ts';
import { indexKnowledge, knowledgeManifest, knowledgeProfile } from '../../src/modules/knowledge/vectorize.ts';
import type { StoreActor } from '../../src/modules/stores/storage.ts';

export const question='Какова ширина органайзера?';
export const vector=Array.from({length:1024},(_,i)=>i===0?1:0);
export async function seedReplyTest(db:D1Database,actor:StoreActor,storeId:string,conversationId='reply-test') {
  await db.prepare("INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES(?,?,?,?,'BUYER_SELLER','Opened',1,1) ON CONFLICT(id) DO NOTHING")
    .bind(conversationId,actor.orgId,storeId,conversationId).run();
  async function message(id:string,text=question,eventAt=1,direction='inbound',isImage=false) {
    await db.prepare("INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode) VALUES(?,?,?,?,?,'Customer',?,?,?,0,?,?,'incremental')")
      .bind(id,actor.orgId,storeId,conversationId,id,direction,JSON.stringify([text]),Number(isImage),eventAt,eventAt).run();
  }
  await message('reply-question');
  const directory=await ensureControlDirectory(db,actor,conversationId,Date.now());assert.ok(directory);
  const policyId=crypto.randomUUID(),config={kind:'automatic' as const,name:'Synthetic reply test',storeIds:[storeId],priority:50,stages:['presale' as const],mode:'suggest' as const,language:'customer' as const,tone:'concise' as const,instructions:'Answer only from the supplied facts.'};
  assert.ok(await createPolicy(db,actor,policyId,config));
  assert.ok(await changePolicy(db,actor,policyId,1,{action:'test'},crypto.randomUUID()));
  assert.ok(await changePolicy(db,actor,policyId,2,{action:'publish'},crypto.randomUUID()));
  const rows=new Map<string,VectorizeVector>();let onQuery:(()=>Promise<void>|void)|undefined;
  const index={upsert:async(vectors:VectorizeVector[])=>{for(const row of vectors)rows.set(row.id,row);return {mutationId:'synthetic-reply-test'};},
    query:async(_vector:number[],options:VectorizeQueryOptions)=>{
      const matches=[...rows.values()].filter(row=>row.namespace===options.namespace&&Object.entries(options.filter??{}).every(([key,value])=>
        value&&typeof value==='object'&&'$in' in value?Array.isArray(value.$in)&&value.$in.includes(row.metadata![key] as string):row.metadata?.[key]===value))
        .slice(0,options.topK).map(({values,...row})=>({...row,score:.54}));
      await onQuery?.();return {matches};
    }} as unknown as Vectorize;
  async function source(content='Ширина органайзера — 26 см.') {
    const id=crypto.randomUUID(),scope={storeId,productRef:null,language:'ru' as const,kind:'guide' as const};
    const prepared=await prepareKnowledge(actor.orgId,id,1,scope,{title:'Synthetic product facts',source:{format:'text',content}});
    assert.ok(await writeKnowledge(db,actor,id,scope,prepared,0,crypto.randomUUID()));
    await db.prepare("UPDATE knowledge_revision SET status='ready',index_profile=?,mutation_id='test-draft',tested_at=1,published_profile=?,published_mutation_id='test-published',published_at=2 WHERE organization_id=? AND document_id=?")
      .bind(knowledgeProfile.id,knowledgeProfile.id,actor.orgId,id).run();
    assert.ok(await publishKnowledge(db,actor,id,1));
    const manifest=await knowledgeManifest(actor.orgId,id,1,scope,prepared);
    await indexKnowledge(index,manifest,prepared.chunks.map(()=>vector),true);
    return {id,prepared};
  }
  return {scope:directory.scope,config,policyId,index,rows,message,source,onQuery:(fn:typeof onQuery)=>{onQuery=fn;},
    input:{conversationId,messageId:'reply-question',policyId,stage:'presale' as const,language:'ru' as const},
    embedding:{inputHash:await knowledgeHash(question),profile:knowledgeProfile.id,values:vector}};
}
