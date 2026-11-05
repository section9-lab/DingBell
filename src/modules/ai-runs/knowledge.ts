import * as v from 'valibot';
import {type AiRun} from '../conversations/ai-state.ts';
import type {ControlScope} from '../conversations/control-types.ts';
import {knowledgeCitationSchema} from '../../shared/knowledge.ts';
import {retrievalScopeSchema} from '../knowledge/retrieval.ts';
const _id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const hash=v.pipe(v.string(),v.regex(/^[0-9a-f]{64}$/));
export const aiKnowledgeChunkSchema=v.strictObject({...knowledgeCitationSchema.entries,body:v.pipe(v.string(),v.maxLength(8192)),title:v.pipe(v.string(),v.maxLength(160)),contentHash:hash,score:v.pipe(v.number(),v.finite())});
export const aiKnowledgeEvidenceSchema=v.strictObject({runId:v.pipe(v.string(),v.uuid()),scope:retrievalScopeSchema,questionHash:hash,chunks:v.pipe(v.array(aiKnowledgeChunkSchema),v.maxLength(10))});
export type AiKnowledgeEvidence=v.InferOutput<typeof aiKnowledgeEvidenceSchema>;
export type AiKnowledgeBindings={DB?:D1Database;AI_OUTBOUND_ENABLED?:string;OUTBOUND_ENABLED?:string};
export async function aiKnowledgeScope(db:D1Database,scope:ControlScope,run:AiRun){
 const products=(await db.prepare(`SELECT DISTINCT alias.product_id AS id FROM message m JOIN product_sku alias ON alias.organization_id=m.organization_id AND alias.store_id=m.store_id AND alias.sku=m.sku
  WHERE m.id=? AND m.organization_id=? AND m.store_id=? AND m.conversation_id=? ORDER BY alias.product_id LIMIT 2`)
  .bind(run.request.messageId,scope.organizationId,scope.storeId,scope.conversationId).all<{id:string}>()).results;
 return v.parse(retrievalScopeSchema,{storeId:scope.storeId,productRef:products.length===1?products[0].id:null,language:run.admission.language});
}
