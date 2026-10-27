import * as v from 'valibot';
import {handoffBriefSchema,handoffItemSchema,handoffReviewSchema,type AcknowledgeHandoffRequest,type ChangeHandoffItemRequest,type HandoffBrief} from '../../shared/handoff-brief.ts';
import {storeAccess} from '../stores/storage.ts';
import {checkedAiReceipt} from './ai-state.ts';
import {readControlAccess} from './control-storage.ts';
import type {ControlActor} from './control-types.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
type SourceRow={sequence:number;receipt:string;projectedAt:number;newerAi:number};
type ReviewRow={runId:string;sourceSequence:number;commandId:string;reviewerUserId:string;reviewerMemberId:string;reviewerName:string;reviewedAt:number};
type ItemRow={runId:string;sourceSequence:number;itemIndex:number;revision:number;commandId:string;actorUserId:string;actorMemberId:string;actorName:string;status:'pending'|'evidence_linked'|'not_required'|'unavailable';evidenceMessageId:string|null;evidenceEventAt:number|null;createdAt:number};
const sameDirectory=(a:Awaited<ReturnType<typeof readControlAccess>>,b:Awaited<ReturnType<typeof readControlAccess>>)=>
 !!a?.directory&&!!b?.directory&&a.memberId===b.memberId&&JSON.stringify(a.directory.scope)===JSON.stringify(b.directory.scope);
const publicReview=(row:ReviewRow)=>v.parse(handoffReviewSchema,{status:'reviewed',reviewerMemberId:row.reviewerMemberId,reviewerName:row.reviewerName,reviewedAt:new Date(row.reviewedAt).toISOString(),customerDataCollected:false,businessActionCompleted:false});
type RequirementKind='product_model'|'issue_description'|'desired_resolution'|'usage_context'|'photo_or_video'|'legacy_unspecified';
const requirementLabels:Record<Exclude<RequirementKind,'legacy_unspecified'>,string>={product_model:'商品型号或 SKU',issue_description:'问题现象与发生条件',desired_resolution:'希望人工协助的处理方向',usage_context:'商品使用场景',photo_or_video:'能说明问题的图片或视频'};
const controlledSummaries={missing_evidence:'自动处理缺少可靠依据，需要人工核对。',customer_request:'消费者要求人工处理。',merchant_decision:'需要由商家人工决定后续处理。',tool_failure:'自动处理未能确认，需要人工检查。'};
const publicItem=(row:ItemRow,kind:RequirementKind)=>v.parse(handoffItemSchema,{itemIndex:row.itemIndex,kind,revision:row.revision,status:row.status,evidence:row.status==='evidence_linked'?{messageId:row.evidenceMessageId,eventAt:new Date(row.evidenceEventAt!).toISOString()}:null,updatedBy:{memberId:row.actorMemberId,name:row.actorName,at:new Date(row.createdAt).toISOString()}});
const itemColumns=`item.run_id AS runId,item.source_sequence AS sourceSequence,item.item_index AS itemIndex,item.revision,item.command_id AS commandId,item.actor_user_id AS actorUserId,item.actor_member_id AS actorMemberId,item.actor_name AS actorName,item.status,item.evidence_message_id AS evidenceMessageId,evidence.event_at AS evidenceEventAt,item.created_at AS createdAt`;
function itemByCommand(db:D1Database,controllerId:string,commandId:string){return db.prepare(`SELECT ${itemColumns} FROM handoff_follow_up_item_event item LEFT JOIN message evidence ON evidence.id=item.evidence_message_id AND evidence.organization_id=item.organization_id AND evidence.store_id=item.store_id AND evidence.conversation_id=item.conversation_id WHERE item.controller_id=? AND item.command_id=?`).bind(controllerId,commandId).first<ItemRow>();}
async function latestItems(db:D1Database,controllerId:string,runId:string){const rows=await db.prepare(`SELECT ${itemColumns} FROM handoff_follow_up_item_event item LEFT JOIN message evidence ON evidence.id=item.evidence_message_id AND evidence.organization_id=item.organization_id AND evidence.store_id=item.store_id AND evidence.conversation_id=item.conversation_id WHERE item.controller_id=? AND item.run_id=? AND NOT EXISTS(SELECT 1 FROM handoff_follow_up_item_event newer WHERE newer.controller_id=item.controller_id AND newer.run_id=item.run_id AND newer.item_index=item.item_index AND newer.revision>item.revision) ORDER BY item.item_index`).bind(controllerId,runId).all<ItemRow>();return rows.results;}
function source(db:D1Database,scope:{controllerId:string;organizationId:string;storeId:string;conversationId:string}){
 return db.prepare(`SELECT event.sequence,event.receipt,event.projected_at AS projectedAt,
   EXISTS(SELECT 1 FROM conversation_control_event newer WHERE newer.controller_id=event.controller_id AND newer.sequence>event.sequence
    AND newer.action IN ('ai_start','ai_resume','ai_listen','ai_intake_start')) AS newerAi
  FROM conversation_control_event event JOIN conversation_control control ON control.controller_id=event.controller_id
   AND control.organization_id=event.organization_id AND control.store_id=event.store_id AND control.conversation_id=event.conversation_id
  WHERE event.controller_id=? AND event.organization_id=? AND event.store_id=? AND event.conversation_id=? AND event.action='request_handoff'
  ORDER BY event.sequence DESC LIMIT 1`).bind(scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId).first<SourceRow>();
}
function checkedSource(row:SourceRow,scope:{controllerId:string;organizationId:string;storeId:string;conversationId:string}){
 const receipt=checkedAiReceipt(JSON.parse(row.receipt));
 if(receipt.action!=='request_handoff'||receipt.appliedState.sequence!==row.sequence||receipt.appliedState.updatedAt>row.projectedAt||JSON.stringify(receipt.run.scope)!==JSON.stringify(scope))throw new Error('INVALID_HANDOFF_PROJECTION');
 return receipt;
}
function reviewByRun(db:D1Database,controllerId:string,runId:string){return db.prepare(`SELECT run_id AS runId,source_sequence AS sourceSequence,command_id AS commandId,reviewer_user_id AS reviewerUserId,
 reviewer_member_id AS reviewerMemberId,reviewer_name AS reviewerName,reviewed_at AS reviewedAt FROM handoff_follow_up_review WHERE controller_id=? AND run_id=?`).bind(controllerId,runId).first<ReviewRow>();}
function reviewByCommand(db:D1Database,controllerId:string,commandId:string){return db.prepare(`SELECT run_id AS runId,source_sequence AS sourceSequence,command_id AS commandId,reviewer_user_id AS reviewerUserId,
 reviewer_member_id AS reviewerMemberId,reviewer_name AS reviewerName,reviewed_at AS reviewedAt FROM handoff_follow_up_review WHERE controller_id=? AND command_id=?`).bind(controllerId,commandId).first<ReviewRow>();}

/** Read the latest projected AI handoff requirements. This never calls a model or claims that customer values were collected. */
export async function readHandoffBrief(db:D1Database,actor:ControlActor,conversationId:string):Promise<{viewerMemberId:string;handoff:HandoffBrief|null}|null>{
 conversationId=v.parse(id,conversationId);const before=await readControlAccess(db,actor,conversationId);
 if(!before||actor.expectedMemberId&&actor.expectedMemberId!==before.memberId)return null;
 if(!before.directory){const after=await readControlAccess(db,actor,conversationId);return after&&!after.directory&&after.memberId===before.memberId?{viewerMemberId:after.memberId,handoff:null}:null;}
 const row=await source(db,before.directory.scope);let receipt:ReturnType<typeof checkedSource>|null=null,review:ReviewRow|null=null,itemRows:ItemRow[]=[];
 if(row){receipt=checkedSource(row,before.directory.scope);[review,itemRows]=await Promise.all([reviewByRun(db,before.directory.scope.controllerId,receipt.run.request.runId),latestItems(db,before.directory.scope.controllerId,receipt.run.request.runId)]);if(review&&review.sourceSequence!==row.sequence)throw new Error('INVALID_HANDOFF_REVIEW');
  if(itemRows.some(item=>item.sourceSequence!==row.sequence||item.itemIndex>=receipt!.input.neededInformation.length))throw new Error('INVALID_HANDOFF_ITEM');}
 const after=await readControlAccess(db,actor,conversationId);if(!sameDirectory(before,after)||actor.expectedMemberId&&actor.expectedMemberId!==after!.memberId)return null;
 if(!row||!receipt)return {viewerMemberId:after!.memberId,handoff:null};
 const controlled='schemaVersion' in receipt.input&&receipt.input.schemaVersion===2,kinds:RequirementKind[]=receipt.input.neededInformation.map(value=>controlled?value as Exclude<RequirementKind,'legacy_unspecified'>:'legacy_unspecified'),requirements=receipt.input.neededInformation.map(value=>controlled?requirementLabels[value as Exclude<RequirementKind,'legacy_unspecified'>]:value),
  state=after!.directory!.state.lifecycle==='resolved'?'resolved':after!.directory!.state.reception==='ai'||row.newerAi?'superseded':'open',items=receipt.input.neededInformation.map((_,itemIndex)=>{const item=itemRows.find(value=>value.itemIndex===itemIndex),kind=kinds[itemIndex]!;return item?publicItem(item,kind):{itemIndex,kind,revision:0,status:'pending' as const,evidence:null,updatedBy:null};});
 const handoff=v.parse(handoffBriefSchema,{runId:receipt.run.request.runId,purpose:'human_follow_up',collectionStatus:'requirements_only',collectionPolicy:controlled?'reference_only':'legacy_read_only',customerDataCopied:false,businessActionCompleted:false,
  followUpStatus:state==='resolved'?'closed':state==='superseded'?'superseded':review&&items.every(item=>item.status!=='pending')?'ready_for_human_decision':'pending',reason:receipt.input.reason,
  summary:'schemaVersion' in receipt.input?controlledSummaries[receipt.input.reason]:receipt.input.summary,neededInformation:requirements,items,state,sequence:row.sequence,requestedAt:new Date(receipt.appliedState.updatedAt).toISOString(),review:review?publicReview(review):null});
 return {viewerMemberId:after!.memberId,handoff};
}

/** Persist only that a staff member reviewed the requirements; no customer value or business completion is accepted. */
export async function acknowledgeHandoffRequirements(db:D1Database,actor:ControlActor,conversationId:string,command:AcknowledgeHandoffRequest,now=Date.now()){
 conversationId=v.parse(id,conversationId);const before=await readControlAccess(db,actor,conversationId);
 if(!before||!before.directory||actor.expectedMemberId&&actor.expectedMemberId!==before.memberId)return {outcome:'not_found' as const};
 const scope=before.directory.scope,existing=await reviewByCommand(db,scope.controllerId,command.commandId);
 if(existing){
  if(existing.runId!==command.runId||existing.sourceSequence!==command.expectedSequence||existing.reviewerUserId!==actor.actorUserId||existing.reviewerMemberId!==before.memberId)return {outcome:'conflict' as const};
  const after=await readControlAccess(db,actor,conversationId);return sameDirectory(before,after)?{outcome:'acknowledged' as const,viewerMemberId:after!.memberId,row:existing}:{outcome:'not_found' as const};
 }
 const event=await source(db,scope);if(!event)return {outcome:'conflict' as const};const receipt=checkedSource(event,scope);
 if(receipt.run.request.runId!==command.runId||event.sequence!==command.expectedSequence||event.newerAi||before.directory.state.lifecycle!=='open'||before.directory.state.reception==='ai')return {outcome:'conflict' as const};
 const row=await db.prepare(`INSERT INTO handoff_follow_up_review(controller_id,organization_id,store_id,conversation_id,run_id,source_sequence,command_id,reviewer_user_id,reviewer_member_id,reviewer_name,reviewed_at)
  SELECT source.controller_id,source.organization_id,source.store_id,source.conversation_id,?,source.sequence,?,?,reviewer.id,person.name,?
  FROM conversation_control_event source JOIN conversation_control control ON control.controller_id=source.controller_id AND control.organization_id=source.organization_id AND control.store_id=source.store_id AND control.conversation_id=source.conversation_id
  JOIN conversation ON conversation.id=control.conversation_id AND conversation.organization_id=control.organization_id AND conversation.store_id=control.store_id
  JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
  JOIN member reviewer ON reviewer.organization_id=conversation.organization_id AND reviewer.user_id=? JOIN user person ON person.id=reviewer.user_id
  WHERE source.controller_id=? AND source.organization_id=? AND source.store_id=? AND source.conversation_id=? AND source.action='request_handoff' AND source.sequence=?
   AND json_extract(source.receipt,'$.run.request.runId')=? AND control.lifecycle='open' AND control.reception<>'ai' AND reviewer.id=? AND conversation.organization_id=?
   AND NOT EXISTS(SELECT 1 FROM conversation_control_event newer WHERE newer.controller_id=source.controller_id AND newer.sequence>source.sequence AND newer.action IN ('ai_start','ai_resume','ai_listen','ai_intake_start'))
   AND ${storeAccess('store.organization_id',false)} ON CONFLICT DO NOTHING
  RETURNING run_id AS runId,source_sequence AS sourceSequence,command_id AS commandId,reviewer_user_id AS reviewerUserId,reviewer_member_id AS reviewerMemberId,reviewer_name AS reviewerName,reviewed_at AS reviewedAt`)
  .bind(command.runId,command.commandId,actor.actorUserId,now,actor.actorUserId,scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,command.expectedSequence,command.runId,before.memberId,actor.orgId,actor.actorUserId,actor.sessionId).first<ReviewRow>();
 const committed=row??await reviewByCommand(db,scope.controllerId,command.commandId);if(!committed)return {outcome:'conflict' as const};
 if(committed.runId!==command.runId||committed.sourceSequence!==command.expectedSequence||committed.reviewerUserId!==actor.actorUserId||committed.reviewerMemberId!==before.memberId)return {outcome:'conflict' as const};
 const after=await readControlAccess(db,actor,conversationId);return sameDirectory(before,after)?{outcome:'acknowledged' as const,viewerMemberId:after!.memberId,row:committed}:{outcome:'not_found' as const};
}

/** Link a later inbound message or record a non-value disposition. Values are never copied into this ledger. */
export async function changeHandoffItem(db:D1Database,actor:ControlActor,conversationId:string,command:ChangeHandoffItemRequest,now=Date.now()){
 conversationId=v.parse(id,conversationId);const before=await readControlAccess(db,actor,conversationId);
 if(!before||!before.directory||actor.expectedMemberId&&actor.expectedMemberId!==before.memberId)return {outcome:'not_found' as const};
 const scope=before.directory.scope,evidenceMessageId=command.status==='evidence_linked'?command.evidenceMessageId:null,event=await source(db,scope);if(!event)return {outcome:'conflict' as const};const receipt=checkedSource(event,scope);
 if(!('schemaVersion' in receipt.input)||receipt.input.schemaVersion!==2||receipt.run.request.runId!==command.runId||event.sequence!==command.expectedSequence||command.itemIndex>=receipt.input.neededInformation.length||event.newerAi||before.directory.state.lifecycle!=='open'||before.directory.state.reception==='ai')return {outcome:'conflict' as const};
 const kind=receipt.input.neededInformation[command.itemIndex]!,existing=await itemByCommand(db,scope.controllerId,command.commandId),matches=(row:ItemRow)=>row.runId===command.runId&&row.sourceSequence===command.expectedSequence&&row.itemIndex===command.itemIndex&&row.revision===command.expectedRevision+1&&row.status===command.status&&row.evidenceMessageId===evidenceMessageId&&row.actorUserId===actor.actorUserId&&row.actorMemberId===before.memberId;
 if(existing){if(!matches(existing))return {outcome:'conflict' as const};const after=await readControlAccess(db,actor,conversationId);return sameDirectory(before,after)?{outcome:'updated' as const,viewerMemberId:after!.memberId,row:existing,kind}:{outcome:'not_found' as const};}
 if(evidenceMessageId){const evidence=await db.prepare(`SELECT 1 ok FROM message evidence JOIN message_append appended ON appended.message_id=evidence.id AND appended.organization_id=evidence.organization_id AND appended.store_id=evidence.store_id AND appended.conversation_id=evidence.conversation_id
   WHERE evidence.id=? AND evidence.organization_id=? AND evidence.store_id=? AND evidence.conversation_id=? AND evidence.direction='inbound' AND evidence.sender_type='Customer' AND appended.sequence>?`).bind(evidenceMessageId,scope.organizationId,scope.storeId,scope.conversationId,receipt.run.admission.inputRevision).first();if(!evidence)return {outcome:'conflict' as const};}
 const row=await db.prepare(`INSERT INTO handoff_follow_up_item_event(controller_id,organization_id,store_id,conversation_id,run_id,source_sequence,item_index,revision,command_id,actor_user_id,actor_member_id,actor_name,status,evidence_message_id,created_at)
  SELECT source.controller_id,source.organization_id,source.store_id,source.conversation_id,?,source.sequence,?,?,?, ?,reviewer.id,person.name,?,?,?
  FROM conversation_control_event source JOIN conversation_control control ON control.controller_id=source.controller_id AND control.organization_id=source.organization_id AND control.store_id=source.store_id AND control.conversation_id=source.conversation_id
  JOIN conversation ON conversation.id=control.conversation_id AND conversation.organization_id=control.organization_id AND conversation.store_id=control.store_id JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
  JOIN member reviewer ON reviewer.organization_id=conversation.organization_id AND reviewer.user_id=? JOIN user person ON person.id=reviewer.user_id
  WHERE source.controller_id=? AND source.organization_id=? AND source.store_id=? AND source.conversation_id=? AND source.sequence=? AND source.action='request_handoff' AND json_extract(source.receipt,'$.run.request.runId')=? AND json_extract(source.receipt,'$.input.schemaVersion')=2
   AND ?<json_array_length(source.receipt,'$.input.neededInformation') AND ?=COALESCE((SELECT MAX(previous.revision) FROM handoff_follow_up_item_event previous WHERE previous.controller_id=source.controller_id AND previous.run_id=? AND previous.item_index=?),0)
   AND control.lifecycle='open' AND control.reception<>'ai' AND reviewer.id=? AND conversation.organization_id=? AND NOT EXISTS(SELECT 1 FROM conversation_control_event newer WHERE newer.controller_id=source.controller_id AND newer.sequence>source.sequence AND newer.action IN ('ai_start','ai_resume','ai_listen','ai_intake_start'))
   AND ${storeAccess('store.organization_id',false)} ON CONFLICT DO NOTHING RETURNING ${itemColumns.replaceAll('item.','').replace('evidence.event_at AS evidenceEventAt','NULL AS evidenceEventAt')}`)
  .bind(command.runId,command.itemIndex,command.expectedRevision+1,command.commandId,actor.actorUserId,command.status,evidenceMessageId,now,actor.actorUserId,scope.controllerId,scope.organizationId,scope.storeId,scope.conversationId,command.expectedSequence,command.runId,command.itemIndex,command.expectedRevision,command.runId,command.itemIndex,before.memberId,actor.orgId,actor.actorUserId,actor.sessionId).first<ItemRow>();
 let committed=row??await itemByCommand(db,scope.controllerId,command.commandId);if(!committed)return {outcome:'conflict' as const};
 if(row&&row.status==='evidence_linked')committed=(await itemByCommand(db,scope.controllerId,command.commandId))!;
 if(!matches(committed))return {outcome:'conflict' as const};const after=await readControlAccess(db,actor,conversationId);return sameDirectory(before,after)?{outcome:'updated' as const,viewerMemberId:after!.memberId,row:committed,kind}:{outcome:'not_found' as const};
}

