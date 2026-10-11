import * as v from 'valibot';
import { knowledgeCitationRequestSchema,knowledgeScopeSchema } from '../../shared/knowledge.ts';
import { policyStageSchema } from '../../shared/reply-policy.ts';
import { readControlAccess } from '../conversations/control-storage.ts';
import { normalizeControlState,replyBodySchema } from '../conversations/control-state.ts';
import { readMessageContext } from '../conversations/context.ts';
import type { ControlActor,ControlScope,ControlReadResult } from '../conversations/control-types.ts';
import { readPolicy } from '../reply-policies/storage.ts';
import { retrieveKnowledge,resolveKnowledgeCitations } from '../knowledge/storage.ts';
import { knowledgeHash } from '../knowledge/content.ts';
import { knowledgeProfile } from '../knowledge/vectorize.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(128));
const digest=v.pipe(v.string(),v.regex(/^[a-f0-9]{64}$/));
const inputSchema=v.strictObject({conversationId:id,messageId:id,policyId:id,stage:policyStageSchema,language:knowledgeScopeSchema.entries.language});
type Input=v.InferOutput<typeof inputSchema>;
export type ReplyTestControlReader=(scope:ControlScope,actor:ControlActor)=>Promise<ControlReadResult>;
const quote=v.pipe(v.string(),v.minLength(1),v.maxLength(2400),v.check(value=>!!value.trim()&&value.isWellFormed()));
const outputBody=v.pipe(replyBodySchema,v.minLength(1));
export const replyTestOutputSchema=v.variant('kind',[
  v.strictObject({kind:v.literal('answer'),body:outputBody,sources:v.pipe(v.array(v.strictObject({chunkId:digest,quote})),v.minLength(1),v.maxLength(10),v.check(rows=>new Set(rows.map(row=>row.chunkId)).size===rows.length))}),
  v.strictObject({kind:v.literal('clarify'),body:outputBody}),
  v.strictObject({kind:v.literal('handoff'),body:outputBody,reason:v.picklist(['missing_evidence','customer_request','merchant_decision','tool_failure'])}),
]);
function freeze<T>(value:T):T {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;
}
function fail(code='REPLY_TEST_UNAVAILABLE'):never {throw new Error(code);}

async function snapshot(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,input:Input) {
  const access=await readControlAccess(db,actor,input.conversationId);
  if(!access?.directory||(actor.expectedMemberId!==undefined&&actor.expectedMemberId!==access.memberId))fail();
  const policy=(await readPolicy(db,actor,input.policyId))?.policy,published=policy?.published;
  if(!policy?.enabled||!published||published.config.kind!=='automatic'||!published.config.storeIds.includes(access.storeId)||!published.config.stages.includes(input.stage))fail();
  // Bound the stored JSON before reading it; never silently truncate the request.
  const message=await db.prepare(`SELECT message.content,conversation.message_sequence AS inputRevision
    FROM message JOIN conversation ON conversation.id=message.conversation_id AND conversation.organization_id=message.organization_id AND conversation.store_id=message.store_id
    WHERE message.id=? AND conversation.id=? AND message.organization_id=? AND message.store_id=? AND message.direction='inbound' AND message.is_image=0
    AND length(CAST(message.content AS BLOB))<=15000 AND NOT EXISTS (SELECT 1 FROM message newer
      WHERE newer.organization_id=message.organization_id AND newer.conversation_id=message.conversation_id
      AND (newer.event_at>message.event_at OR (newer.event_at=message.event_at AND newer.id>message.id)))`)
    .bind(input.messageId,input.conversationId,actor.orgId,access.storeId).first<{content:string;inputRevision:number}>();
  if(!message)fail();
  const content=v.safeParse(v.pipe(v.array(v.string()),v.minLength(1),v.maxLength(16)),JSON.parse(message.content));
  if(!content.success)fail();
  const question=content.output.join('\n');
  if(!v.is(replyBodySchema,question)||new TextEncoder().encode(question).length>2400)fail();
  const source=await readMessageContext(db,actor,input.conversationId,input.messageId);
  if(!source||source.viewerMemberId!==access.memberId||source.storeId!==access.storeId)fail();
  const current=await control(access.directory.scope,{...actor,expectedMemberId:access.memberId});
  if(current.outcome!=='found'||current.view.viewerMemberId!==access.memberId)fail();
  const state=normalizeControlState(current.view.state);if(state.lifecycle!=='open')fail();
  return {actor:{orgId:actor.orgId,actorUserId:actor.actorUserId,sessionId:actor.sessionId,memberId:access.memberId},input,
    scope:access.directory.scope,controlVersion:state.version,controlEpoch:state.controlEpoch,inputRevision:message.inputRevision,
    question,questionHash:await knowledgeHash(question),
    // The selected SKU cannot be supplied by a client/model. Ambiguous or absent mappings get general knowledge only.
    knowledgeScope:{storeId:access.storeId,productRef:source.product.state==='matched'?source.product.item!.id:null,language:input.language},
    source:source.source,productState:source.product.state,
    replyLanguage:published.config.language==='customer'?input.language:published.config.language,
    policy:{id:policy.id,revision:published.revision,config:published.config,timeZone:published.timeZone}};
}
export type ReplyTestContext=Awaited<ReturnType<typeof prepareReplyTest>>;
export async function assertCurrentReplyTest(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,context:ReplyTestContext) {
  const {mode,runId,contextHash,...captured}=context;
  if(mode!=='simulation'||!v.is(v.pipe(v.string(),v.uuid()),runId)||await knowledgeHash(captured)!==contextHash)fail('REPLY_TEST_CHANGED');
  if(context.actor.orgId!==actor.orgId||context.actor.actorUserId!==actor.actorUserId||context.actor.sessionId!==actor.sessionId)fail('REPLY_TEST_CHANGED');
  const current=await snapshot(db,control,actor,context.input);
  if(await knowledgeHash(current)!==context.contextHash)fail('REPLY_TEST_CHANGED');
}

/** Internal staff simulation only. Persist this server-owned context with a budget before future model dispatch; never accept it from a browser/model. */
export async function prepareReplyTest(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,value:unknown) {
  const input=v.parse(inputSchema,value),initial=await snapshot(db,control,actor,input);
  const context=freeze({...initial,mode:'simulation' as const,runId:crypto.randomUUID(),contextHash:await knowledgeHash(initial)});
  await assertCurrentReplyTest(db,control,actor,context);return context;
}
export type ReplyTestEvidence=Awaited<ReturnType<typeof retrieveReplyTestKnowledge>>;
export async function replyTestModelInput(context:ReplyTestContext,evidence:ReplyTestEvidence,services:{db:D1Database;control:ReplyTestControlReader;actor:ControlActor}) {
  const resolved=await resolveEvidence(services.db,services.control,services.actor,context,evidence);
  return freeze({question:context.question,replyLanguage:context.replyLanguage,
    style:{tone:context.policy.config.tone,instructions:context.policy.config.instructions},
    untrustedKnowledge:resolved.map(({chunkId,body})=>({chunkId,body}))});
}
export async function retrieveReplyTestKnowledge(db:D1Database,index:Vectorize,control:ReplyTestControlReader,actor:ControlActor,context:ReplyTestContext,
  embedding:{inputHash:string;profile:string;values:number[]}) {
  await assertCurrentReplyTest(db,control,actor,context);
  if(embedding.inputHash!==context.questionHash||embedding.profile!==knowledgeProfile.id||embedding.values.length!==knowledgeProfile.dimensions
    ||!embedding.values.every(Number.isFinite)||!embedding.values.some(value=>value!==0))fail('REPLY_TEST_EMBEDDING_INVALID');
  const chunks=await retrieveKnowledge(db,index,actor,context.knowledgeScope,embedding.values);
  await assertCurrentReplyTest(db,control,actor,context);
  return freeze({runId:context.runId,contextHash:context.contextHash,chunks});
}

async function resolveEvidence(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,context:ReplyTestContext,evidence:ReplyTestEvidence) {
  if(evidence.runId!==context.runId||evidence.contextHash!==context.contextHash)fail('REPLY_TEST_EVIDENCE_INVALID');
  await assertCurrentReplyTest(db,control,actor,context);
  const citations=evidence.chunks.map(({documentId,revision,chunkId,bodyHash})=>({documentId,revision,chunkId,bodyHash}));
  if(citations.length&&!v.is(knowledgeCitationRequestSchema,{...context.knowledgeScope,citations}))fail('REPLY_TEST_EVIDENCE_INVALID');
  const resolved=citations.length?await resolveKnowledgeCitations(db,actor,{...context.knowledgeScope,citations}):[];
  if(!resolved||resolved.some((row,i)=>row.body!==evidence.chunks[i].body||row.contentHash!==evidence.chunks[i].contentHash))fail('REPLY_TEST_EVIDENCE_CHANGED');
  await assertCurrentReplyTest(db,control,actor,context);return resolved;
}

/** Traceability and freshness only, not semantic entailment or final send authorization. This service has no model or outbound connector. */
export async function reviewReplyTest(db:D1Database,control:ReplyTestControlReader,actor:ControlActor,context:ReplyTestContext,evidence:ReplyTestEvidence,value:unknown) {
  const output=v.safeParse(replyTestOutputSchema,value);if(!output.success)fail('REPLY_TEST_OUTPUT_INVALID');
  const resolved=await resolveEvidence(db,control,actor,context,evidence);
  const decision=output.output;
  const sources=decision.kind==='answer'?decision.sources.map(source=>{
    const row=resolved.find(row=>row.chunkId===source.chunkId);
    if(!row||!row.body.includes(source.quote))fail('REPLY_TEST_EVIDENCE_INVALID');
    return {documentId:row.documentId,revision:row.revision,chunkId:row.chunkId,bodyHash:row.bodyHash,quote:source.quote};
  }):undefined;
  return freeze({status:'review_required' as const,simulated:true as const,canSend:false as const,factCheck:'not_evaluated' as const,
    runId:context.runId,contextHash:context.contextHash,decision:decision.kind==='answer'?{...decision,sources:sources!}:decision});
}
