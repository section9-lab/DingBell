import * as v from 'valibot';
import {aiDraftSchema,type AiDraft} from '../../shared/ai-draft.ts';
import {readControlAccess} from '../conversations/control-storage.ts';
import type {ControlActor} from '../conversations/control-types.ts';
import {readAiExecution} from './storage.ts';
import {aiAnswerInputSchema} from './answer.ts';
import {aiKnowledgeEvidenceSchema,resolvePublishedAiKnowledge} from './knowledge.ts';
import {knowledgeHash} from '../knowledge/content.ts';
type Saved={runId:string;body:string;citations:string;knowledgeEvidence:string;createdAt:number};
type Context={inputRevision:number;platformType:string;platformStatus:string;storeStatus:string;policyEnabled:number|null;policyRevision:number|null;content:string|null;productRef:string|null};
/** Employee read of a historical draft. It neither resumes an AI execution nor grants a send permission. */
export async function readAiDraft(db:D1Database,actor:ControlActor,conversationId:string):Promise<AiDraft|null>{
 const before=await readControlAccess(db,actor,conversationId);if(!before||!actor.expectedMemberId||before.memberId!==actor.expectedMemberId)return null;
 const scope=before.directory?.scope;
 const latest=()=>db.prepare(`SELECT a.run_id AS runId,a.body,a.citations,a.knowledge_evidence AS knowledgeEvidence,a.created_at AS createdAt
  FROM ai_answer a JOIN ai_execution e ON e.id=a.run_id WHERE e.organization_id=? AND e.store_id=? AND e.conversation_id=? AND e.controller_id=?
  ORDER BY json_extract(e.payload,'$.run.admission.inputRevision') DESC,a.created_at DESC,a.run_id DESC LIMIT 1`)
  .bind(actor.orgId,before.storeId,conversationId,scope?.controllerId??'').first<Saved>();
 const saved=scope?await latest():null;
 const base={companyId:actor.orgId,conversationId,viewerMemberId:before.memberId,canSend:false as const};
 const authorized=async()=>{const after=await readControlAccess(db,actor,conversationId);return !!after&&after.memberId===before.memberId&&after.storeId===before.storeId&&after.directory?.scope.controllerId===scope?.controllerId;};
 if(!saved||!scope)return await authorized()?{...base,draft:null}:null;
 const execution=await readAiExecution(db,scope,saved.runId),run=execution?.payload.run;
 if(!run||run.schemaVersion!==1||execution.config.model.promptVersion!=='support-answer-v1')throw new Error('AI_DRAFT_INVALID');
 const input=v.parse(aiAnswerInputSchema,{body:saved.body,citations:JSON.parse(saved.citations)}),evidence=v.parse(aiKnowledgeEvidenceSchema,JSON.parse(saved.knowledgeEvidence));
 if(evidence.runId!==saved.runId||evidence.scope.storeId!==scope.storeId||evidence.scope.language!==run.admission.language||evidence.questionHash!==await knowledgeHash(run.admission.question))throw new Error('AI_DRAFT_INVALID');
 const citations=input.citations.map(id=>{const chunk=evidence.chunks.find(c=>c.chunkId===id);if(!chunk)throw new Error('AI_DRAFT_INVALID');return chunk;});
 const context=()=>db.prepare(`SELECT c.message_sequence AS inputRevision,c.platform_type AS platformType,c.platform_status AS platformStatus,s.status AS storeStatus,
  p.enabled AS policyEnabled,p.published_revision AS policyRevision,m.content,
  (SELECT CASE WHEN count(DISTINCT alias.product_id)=1 THEN min(alias.product_id) ELSE NULL END FROM product_sku alias
   WHERE alias.organization_id=c.organization_id AND alias.store_id=c.store_id AND alias.sku=m.sku) AS productRef
  FROM conversation c JOIN store s ON s.id=c.store_id AND s.organization_id=c.organization_id
  LEFT JOIN reply_policy p ON p.organization_id=c.organization_id AND p.id=?
  LEFT JOIN message m ON m.organization_id=c.organization_id AND m.store_id=c.store_id AND m.conversation_id=c.id AND m.id=?
  WHERE c.organization_id=? AND c.store_id=? AND c.id=?`).bind(run.admission.policyId,run.admission.messageId,scope.organizationId,scope.storeId,scope.conversationId).first<Context>();
 const initial=await context(),resolved=await resolvePublishedAiKnowledge(db,scope.organizationId,evidence.scope,evidence.chunks),current=await context();
 if(!await authorized())return null;
 if(!current)throw new Error('AI_DRAFT_UNAVAILABLE');
 let reason:NonNullable<AiDraft['draft']>['reason']=null;
 const question=current.content?JSON.parse(current.content):null;
 if(current.inputRevision!==run.admission.inputRevision||!Array.isArray(question)||question.join('\n')!==run.admission.question)reason='new_input';
 else if(current.policyEnabled!==1||current.policyRevision!==run.admission.policyRevision)reason='policy_changed';
 else if(current.platformType!=='BUYER_SELLER'||current.platformStatus!=='Opened'||!['verified','partial','attention'].includes(current.storeStatus))reason='conversation_changed';
 else if(current.productRef!==evidence.scope.productRef||!resolved||resolved.some((c,i)=>JSON.stringify(c)!==JSON.stringify((({score,...chunk})=>chunk)(evidence.chunks[i]))))reason='source_changed';
 else if(JSON.stringify(initial)!==JSON.stringify(current)||(await latest())?.runId!==saved.runId)reason='changed';
 if(!await authorized())return null;
 return v.parse(aiDraftSchema,{...base,draft:{runId:saved.runId,...input,question:run.admission.question,language:run.admission.language,createdAt:new Date(saved.createdAt).toISOString(),
  status:reason?'stale':'current',reason,citations:citations.map(({documentId,revision,chunkId,title,body})=>({documentId,revision,chunkId,title,body}))}});
}
