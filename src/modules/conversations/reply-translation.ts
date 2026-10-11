import * as v from 'valibot';
import { storeAccess } from '../stores/storage.ts';
import { checkedReplyTranslation,replyBodySchema } from './control-state.ts';
import type { ControlActor,ControlScope } from './control-types.ts';
import type { ReplyTranslation } from './reply-types.ts';

async function digest(body:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}

// Confirmation reads immutable business facts only; it never creates or reads a model execution.
export async function readReplyTranslation(db:D1Database,scope:ControlScope,actor:ControlActor,memberId:string,requestId:string,confirmedBodyHash:string):Promise<ReplyTranslation|null>{
  if(actor.orgId!==scope.organizationId)return null;
  const row=await db.prepare(`SELECT run.id AS runId,run.request_id AS requestId,run.source,run.source_hash AS sourceHash,
    run.source_revision AS sourceRevision,output.body,output.body_hash AS outputHash
    FROM reply_preview_run AS run JOIN reply_preview_output AS output ON output.run_id=run.id AND output.receipt=run.receipt
    JOIN conversation ON conversation.id=run.conversation_id AND conversation.organization_id=run.organization_id AND conversation.store_id=run.store_id
    JOIN store ON store.id=run.store_id AND store.organization_id=run.organization_id
    JOIN member AS original ON original.id=run.actor_member_id AND original.user_id=run.actor_user_id AND original.organization_id=run.organization_id
    WHERE run.organization_id=? AND run.store_id=? AND run.conversation_id=? AND run.request_id=?
      AND run.actor_user_id=? AND run.actor_member_id=? AND run.settlement<>'released' AND ${storeAccess('store.organization_id',false)}`)
    .bind(scope.organizationId,scope.storeId,scope.conversationId,requestId,actor.actorUserId,memberId,actor.actorUserId,actor.sessionId)
    .first<{runId:string;requestId:string;source:string;sourceHash:string;sourceRevision:number;body:string;outputHash:string}>();
  if(!row)return null;
  if(!v.is(replyBodySchema,row.source)||!v.is(replyBodySchema,row.body))throw new Error('INVALID_REPLY_TRANSLATION');
  const [sourceHash,outputHash]=await Promise.all([digest(row.source),digest(row.body)]);
  if(sourceHash!==row.sourceHash||outputHash!==row.outputHash)throw new Error('INVALID_REPLY_TRANSLATION');
  return checkedReplyTranslation({requestId:row.requestId,runId:row.runId,sourceRevision:row.sourceRevision,sourceHash,outputHash,confirmedBodyHash},requestId)!;
}
