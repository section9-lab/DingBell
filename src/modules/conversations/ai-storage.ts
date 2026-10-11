import * as v from 'valibot';
import {aiAdmissionSchema,aiStartSchema,aiScopeSchema,type AiStart} from './ai-state.ts';
import type {ControlScope} from './control-types.ts';
// Internal service admission: scope comes from the verified conversation directory,
// never from model arguments. Human simulations cannot create an automatic run.
export async function readAiAdmission(db:D1Database,scope:ControlScope,value:AiStart){
 const input=v.parse(aiStartSchema,value);v.parse(aiScopeSchema,scope);
 const row=await db.prepare(`SELECT c.message_sequence AS inputRevision,m.content,p.published_revision AS policyRevision,pv.config
  FROM conversation_control cc JOIN conversation c ON c.id=cc.conversation_id AND c.organization_id=cc.organization_id AND c.store_id=cc.store_id
  JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id
  JOIN message m ON m.conversation_id=c.id AND m.organization_id=c.organization_id AND m.store_id=c.store_id
  JOIN reply_policy p ON p.organization_id=c.organization_id AND p.id=? AND p.enabled=1 AND p.kind='automatic'
  JOIN policy_version pv ON pv.organization_id=p.organization_id AND pv.policy_id=p.id AND pv.revision=p.published_revision AND pv.schema_version=1
  WHERE cc.controller_id=? AND cc.organization_id=? AND cc.store_id=? AND cc.conversation_id=? AND m.id=?
  AND s.status IN ('verified','partial','attention') AND c.platform_type='BUYER_SELLER' AND c.platform_status='Opened'
  AND m.direction='inbound' AND m.is_image=0 AND length(CAST(m.content AS BLOB))<=15000
  AND NOT EXISTS (SELECT 1 FROM message newer WHERE newer.organization_id=c.organization_id AND newer.conversation_id=c.id AND (newer.event_at>m.event_at OR (newer.event_at=m.event_at AND newer.id>m.id)))`)
  .bind(input.policyId,scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,input.messageId).first<{inputRevision:number;content:string;policyRevision:number;config:string}>();
 if(!row)return null;
 try{
  const content=v.parse(v.pipe(v.array(v.string()),v.minLength(1),v.maxLength(16)),JSON.parse(row.content)),config=JSON.parse(row.config);
  const admission=v.parse(aiAdmissionSchema,{messageId:input.messageId,inputRevision:row.inputRevision,question:content.join('\n'),policyId:input.policyId,policyRevision:row.policyRevision,
   policyConfig:config,stage:input.stage,language:config.language==='customer'?input.language:config.language});
  return admission.policyConfig.kind==='automatic'&&admission.policyConfig.storeIds.includes(scope.storeId)&&admission.policyConfig.stages.includes(input.stage)?admission:null;
 }catch{return null;}
}
