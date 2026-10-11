import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';
import { checkedReplyTranslation, controlCommandSchema, normalizeControlState } from './control-state.ts';
import { deferControlRepair, projectControlEvents, readControlAccess, readControlDirectory } from './control-storage.ts';
import { decryptCredentials } from '../stores/credentials.ts';
import { reserveReply, recordReplyRateLimit } from '../sync/bindings.ts';
import { sendOzonMessage, type OzonSendResult } from '../ozon/send.ts';
import { readReplyDispatchContext, readAiReplyDispatchContext, projectReplyEvents, type ReplyDispatchContext } from './reply-storage.ts';
import { checkedReply, replyView } from './reply-state.ts';
import type { ReplyIntent, ReplySnapshot, ReplyReadResult, ReplyRejectCode, ReplyListReadResult, ReplyTranslation } from './reply-types.ts';
import { readReplyTranslation } from './reply-translation.ts';
import type { ControlBindings } from './control-bindings.ts';
import type { ControlAccess, ControlActor, ControlCommand, ControlCommandResult, ControlDirectory, ControlOutboxEvent as ControlEvent, ControlNote, ControlNotesReadResult, ControlReadResult, ControlReceipt, ControlScope, ControlState, ControlView, StoredControlState } from './control-types.ts';
import {aiStartSchema,aiResumeSchema,aiHandoffSchema,aiRunSchema,checkedAiReceipt,handoffNotice,type AiRun,type AiReceipt,type AiHandoff} from './ai-state.ts';
import {readAiAdmission} from './ai-storage.ts';
import {readAiExecution} from '../ai-runs/storage.ts';
import {reviewAiReply,reviewCompletedAiReply} from '../ai-runs/reply-intent.ts';
import {checkedAiSendReceipt,type AiSendReceipt} from './ai-reply-receipt.ts';
import type {SupportBindings} from '../ai-runs/execution.ts';
import {selectReplyPolicy} from '../reply-policies/matching.ts';
import {aiReceptionCommandSchema} from '../../shared/ai-reception.ts';
import {aiListeningRequestSchema,aiListeningSchema,checkedAiListeningReceipt,readAiListeningBoundary,isNewAiInput,type AiListening} from './ai-listening.ts';
import {aiPendingInputSchema,checkedInboundReceipt,readInboundEvent,type AiPendingInput} from './inbound.ts';
import {aiWorkSchema,aiIntakeRunSchema,aiIntakeRequestSchema,aiClassificationSchema,checkedAiIntakeReceipt,readAiIntakeAdmission,classifyDecision,aiDispatchAdmissionSchema,aiDispatchStopRequestSchema,checkedAiDispatchStopReceipt,type AiIntakeRun,type AiClassification,type AiIntakeDecision,type AiWork} from './ai-intake.ts';

const eventPrefix='event:';
const notePrefix='note:';
const replyPrefix='reply:',replyEventPrefix='reply-event:',replyDuePrefix='reply-due:';
const wakeTime=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
const aiReplyWakeSchema=v.pipe(v.strictObject({runId:v.pipe(v.string(),v.uuid()),dueAt:wakeTime,deadlineAt:wakeTime}),v.check(wake=>wake.dueAt<=wake.deadlineAt));
const historyEntrySchema=v.strictObject({id:v.pipe(v.string(),v.minLength(1),v.maxLength(256)),sequence:v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(Number.MAX_SAFE_INTEGER))});
const historySchema=v.pipe(v.strictObject({schemaVersion:v.literal(1),observedSequence:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),complete:v.boolean(),after:v.nullable(v.pipe(v.string(),v.minLength(7),v.maxLength(262),v.startsWith(replyPrefix))),recent:v.pipe(v.array(historyEntrySchema),v.maxLength(20))}),
  v.check(history=>(!history.complete||history.after===null)&&new Set(history.recent.map(item=>item.id)).size===history.recent.length&&history.recent.every((item,index)=>item.sequence<=history.observedSequence&&(index===0||item.sequence<history.recent[index-1]!.sequence))));
type ReplyHistory=v.InferOutput<typeof historySchema>;
function dueKey(snapshot:ReplySnapshot){return `${replyDuePrefix}${String(snapshot.intent.dueAt).padStart(16,'0')}:${snapshot.intent.id}`;}
async function bodyHash(body:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}
function noteKey(sequence:number){return `${notePrefix}${String(sequence).padStart(16,'0')}`;}
function sameScope(left:ControlScope,right:ControlScope) {
  return left.organizationId===right.organizationId&&left.storeId===right.storeId&&left.conversationId===right.conversationId&&left.controllerId===right.controllerId;
}
function identifier(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256;}
function noteFromReceipt(value:unknown,commandId:string,sequence:number):ControlNote {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_CONTROL_NOTE');
  const {actorUserId,actorMemberId,appliedState,authorName,...command}=value as Record<string,unknown>;
  const parsed=v.safeParse(controlCommandSchema,command);
  if(!parsed.success||parsed.output.action!=='add_note'||parsed.output.commandId!==commandId||!identifier(actorUserId)||!identifier(actorMemberId)||typeof authorName!=='string')throw new Error('INVALID_CONTROL_NOTE');
  const state=normalizeControlState(appliedState);
  if((appliedState as StoredControlState).schemaVersion!==2||state.sequence!==sequence||state.sequence<1||state.version!==parsed.output.expectedVersion+1)throw new Error('INVALID_CONTROL_NOTE');
  return {commandId,sequence,body:parsed.output.body,authorMemberId:actorMemberId,authorName,createdAt:state.updatedAt};
}

export class ConversationController extends DurableObject<ControlBindings> {
  private routed(scope:ControlScope) {
    return !!scope&&[scope.organizationId,scope.storeId,scope.conversationId,scope.controllerId].every(identifier)
      &&!!this.env.CONVERSATION_CONTROLLER&&this.ctx.id.equals(this.env.CONVERSATION_CONTROLLER.idFromName(scope.controllerId));
  }
  private async access(scope:ControlScope,actor:ControlActor,targetMemberId?:string):Promise<ControlAccess|null> {
    if(!this.env.DB||!this.routed(scope))return null;
    const access=await readControlAccess(this.env.DB,actor,scope.conversationId,targetMemberId);
    return access?.directory&&access.organizationId===scope.organizationId&&access.storeId===scope.storeId
      &&sameScope(access.directory.scope,scope)?access:null;
  }
  private async state(transaction:DurableObjectTransaction,directory:ControlDirectory):Promise<ControlState> {
    const projected=normalizeControlState(directory.state);
    const storedScope=await transaction.get<ControlScope>('scope');
    if(storedScope&&!sameScope(storedScope,directory.scope))throw new Error('CONTROL_SCOPE_MISMATCH');
    const stored=await transaction.get<StoredControlState>('state');
    if(stored!==undefined) {
      if(!storedScope)throw new Error('CONTROL_AUTHORITY_MISSING');
      const state=normalizeControlState(stored);
      if(state.version<projected.version||state.controlEpoch<projected.controlEpoch||state.sequence<projected.sequence
        ||(state.version===projected.version&&(Object.keys(projected) as (keyof ControlState)[]).some(key=>state[key]!==projected[key])))
        throw new Error('CONTROL_AUTHORITY_INCONSISTENT');
      if(stored.schemaVersion===1)await transaction.put('state',state);
      return state;
    }
    if(storedScope||(await transaction.list({prefix:'receipt:',limit:1})).size||(await transaction.list({prefix:eventPrefix,limit:1})).size||(await transaction.list({prefix:notePrefix,limit:1})).size||(await transaction.list({prefix:replyPrefix,limit:1})).size||(await transaction.list({prefix:replyEventPrefix,limit:1})).size||(await transaction.list({prefix:replyDuePrefix,limit:1})).size||await transaction.get('replyRateLimit')||await transaction.get('replyHistory'))
      throw new Error('CONTROL_AUTHORITY_MISSING');
    const initial=projected;
    if(initial.version!==0||initial.controlEpoch!==0||initial.sequence!==0||initial.lifecycle!=='open'||initial.reception!=='paused'||initial.assignedMemberId!==null||initial.workStatus!=='needs_reply')
      throw new Error('CONTROL_AUTHORITY_MISSING');
    await transaction.put('scope',directory.scope);await transaction.put('state',initial);
    return initial;
  }
  private async view(directory:ControlDirectory,memberId:string):Promise<ControlView> {
    return this.ctx.storage.transaction(async transaction=>({state:await this.state(transaction,directory),viewerMemberId:memberId,
      projectionPending:(await transaction.list({prefix:eventPrefix,limit:1})).size>0||(await transaction.list({prefix:replyEventPrefix,limit:1})).size>0}));
  }
  async read(scope:ControlScope,actor:ControlActor):Promise<ControlReadResult> {
    const access=await this.access(scope,actor);
    return access?.directory?{outcome:'found',view:await this.view(access.directory,access.memberId)}:{outcome:'not_found'};
  }
  protected aiTimeoutMs(){return 60_000;}
  /** Member-bound read of current reception and an optional historical recovery receipt. */
  async readAiReception(scope:ControlScope,actor:ControlActor,commandId?:string){
    if(commandId!==undefined)v.parse(v.pipe(v.string(),v.uuid()),commandId);
    const access=await this.access(scope,actor);
    if(!access?.directory||!actor.expectedMemberId||actor.expectedMemberId!==access.memberId)return {outcome:'not_found' as const};
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,access.directory!),value=await transaction.get('aiListening');
      const listening=value?v.parse(aiListeningSchema,value):null;
      if(listening&&!sameScope(listening.scope,scope))throw new Error('CONTROL_SCOPE_MISMATCH');
      const waiting=listening&&state.lifecycle==='open'&&state.reception==='ai'&&state.controlEpoch===listening.controlEpoch?listening:null;
      const saved=commandId===undefined?undefined:await transaction.get<ControlEvent['receipt']>(`receipt:ai-listen:${commandId}`);
      if(saved&&(saved.action!=='ai_listen'||saved.actorUserId!==actor.actorUserId||saved.actorMemberId!==access.memberId))return {outcome:'not_found' as const};
      const receipt=saved?checkedAiListeningReceipt(saved):null;
      if(receipt&&(!sameScope(receipt.listening.scope,scope)||receipt.appliedState.version>state.version||receipt.listening.controlEpoch>state.controlEpoch))throw new Error('CONTROL_RECEIPT_INCONSISTENT');
      return {outcome:'found' as const,state,waiting,receipt,viewerMemberId:access.memberId,
        projectionPending:(await transaction.list({prefix:eventPrefix,limit:1})).size>0||(await transaction.list({prefix:replyEventPrefix,limit:1})).size>0};
    });
    return (await this.access(scope,actor))?.memberId===access.memberId?result:{outcome:'not_found' as const};
  }
  /** Public command shape; the prior run is always resolved from server authority. */
  async resumeAiReception(scope:ControlScope,actor:ControlActor,value:unknown){
    const request=v.parse(aiReceptionCommandSchema,value),read=await this.readAiReception(scope,actor,request.commandId);
    if(read.outcome!=='found')return {outcome:'not_found' as const};
    if(read.receipt)return read.receipt.expectedVersion===request.expectedVersion?{outcome:'accepted' as const,receipt:read.receipt,state:read.state,canSend:false as const}:{outcome:'conflict' as const};
    return this.resumeAiForNewMessages(scope,actor,{...request,previousRunId:await this.readAiRunTarget(scope)});
  }
  /** Internal delivery of committed input. A receipt replay never reopens or reauthorizes a conversation. */
  async receiveInbound(scope:ControlScope,eventId:string){
    if(!this.env.DB||!this.routed(scope)||!identifier(eventId))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const commandId=`inbound:${eventId}`,event=await readInboundEvent(this.env.DB,scope,eventId);
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get(`receipt:${commandId}`);
      if(saved){const receipt=checkedInboundReceipt(saved);return sameScope(receipt.event.scope,scope)?{outcome:'accepted' as const,receipt,state}:{outcome:'unavailable' as const};}
      if(!event||event.sequence<=(await transaction.get<number>('inboundSequence')??0))return {outcome:'ignored' as const,state};
      const waiting=await transaction.get('aiListening'),listening=waiting?v.parse(aiListeningSchema,waiting):null;
      const runValue=state.reception==='ai'?await transaction.get('aiRun'):null,run=runValue?v.parse(aiWorkSchema,runValue):null;
      if((listening&&state.reception==='ai'&&(event.sequence<=listening.afterSequence||event.eventAt<listening.createdAt))
        ||(run&&run.controlEpoch===state.controlEpoch&&event.sequence<=run.admission.inputRevision)){
        await transaction.put('inboundSequence',event.sequence);return {outcome:'ignored' as const,state};
      }
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'unavailable' as const};
      const appliedState:ControlState={...state,lifecycle:'open',workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,
        controlEpoch:state.controlEpoch+(state.reception==='ai'||state.lifecycle==='resolved'?1:0),updatedAt:Math.max(Date.now(),state.updatedAt)};
      const receipt=checkedInboundReceipt({action:'customer_message',origin:'system',commandId,expectedVersion:state.version,actorUserId:null,actorMemberId:null,appliedState,event});
      if(state.reception==='ai'){
        await transaction.put('aiPendingInput',v.parse(aiPendingInputSchema,{schemaVersion:1,event,controlEpoch:appliedState.controlEpoch}));
        await transaction.delete('aiListening');await transaction.delete('aiDeadline');await transaction.delete('aiClassification');
      }
      await transaction.put('inboundSequence',event.sequence);await this.persistCommand(transaction,{scope,receipt});return {outcome:'accepted' as const,receipt,state:appliedState};
    });
    if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  async readPendingAiInput(scope:ControlScope):Promise<AiPendingInput|null>{
    if(!this.env.DB||!this.routed(scope))return null;
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return null;
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),value=await transaction.get('aiPendingInput');if(!value)return null;
      const pending=v.parse(aiPendingInputSchema,value);return sameScope(pending.event.scope,scope)&&state.lifecycle==='open'&&state.reception==='ai'&&state.controlEpoch===pending.controlEpoch?pending:null;
    });
  }
  /** Classifier authorization is distinct from an answer run; both use the same immutable work slot. */
  async readAiWork(scope:ControlScope,runId:string):Promise<AiWork|null>{
    if(this.env.AI_RECEPTION_ENABLED!=='true'||!this.env.DB||!this.routed(scope)||!v.is(v.pipe(v.string(),v.uuid()),runId))return null;
    const directory=await readControlDirectory(this.env.DB,scope),value=await this.ctx.storage.get('aiRun');if(!directory||!value)return null;
    const run=v.parse(aiWorkSchema,value);if(run.schemaVersion===1)return this.readAiRun(scope,runId);
    if(run.request.runId!==runId||!sameScope(run.scope,scope)||Date.now()>=run.deadlineAt)return null;
    if(JSON.stringify(await readAiIntakeAdmission(this.env.DB,scope,run.request.messageId))!==JSON.stringify(run.admission))return null;
    return this.ctx.storage.transaction(async transaction=>{const state=await this.state(transaction,directory);return state.lifecycle==='open'&&state.reception==='ai'&&state.controlEpoch===run.controlEpoch&&Date.now()<run.deadlineAt&&JSON.stringify(await transaction.get('aiRun'))===JSON.stringify(run)?run:null;});
  }
  async startAiIntake(scope:ControlScope,value:unknown){
    const request=v.parse(aiIntakeRequestSchema,value);
    if(this.env.AI_RECEPTION_ENABLED!=='true'||!this.env.DB||!this.routed(scope))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const admission=await readAiIntakeAdmission(this.env.DB,scope,request.messageId),commandId=`ai-intake:${request.runId}`;
    const listening=await this.readAiListening(scope),pending=await this.readPendingAiInput(scope),newInput=listening?await isNewAiInput(this.env.DB,listening,request.messageId):false;
    const oldValue=await this.ctx.storage.get('aiRun'),oldRun=oldValue?v.parse(aiWorkSchema,oldValue):null,execution=oldRun?await readAiExecution(this.env.DB,scope,oldRun.request.runId):null;
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get(`receipt:${commandId}`);
      if(saved){const receipt=checkedAiIntakeReceipt(saved);return receipt.action==='ai_intake_start'&&sameScope(receipt.run.scope,scope)&&JSON.stringify(receipt.run.request)===JSON.stringify(request)?{outcome:'accepted' as const,receipt,state}:{outcome:'conflict' as const};}
      if(!admission||(listening&&!newInput))return {outcome:'unavailable' as const};
      if(JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(oldValue)||await transaction.get(`receipt:ai-start:${request.runId}`)||await transaction.get(`receipt:ai-resume:${request.runId}`))return {outcome:'conflict' as const};
      const waiting=listening&&state.reception==='ai'&&state.controlEpoch===listening.controlEpoch&&JSON.stringify(await transaction.get('aiListening'))===JSON.stringify(listening)&&(oldRun?.request.runId??null)===listening.request.previousRunId;
      const queued=pending&&pending.event.messageId===request.messageId&&state.reception==='ai'&&state.controlEpoch===pending.controlEpoch&&JSON.stringify(await transaction.get('aiPendingInput'))===JSON.stringify(pending)&&(!oldRun||oldRun.controlEpoch<state.controlEpoch)&&!await transaction.get('aiClassification');
      if(state.version!==request.expectedVersion||state.lifecycle!=='open'||(!waiting&&!queued&&(state.reception!=='paused'||state.controlEpoch!==0||oldRun))||state.assignedMemberId!==null||state.workStatus!=='needs_reply'||oldRun?.request.runId===request.runId)return {outcome:'conflict' as const};
      if(execution&&(!execution.closure||JSON.stringify(execution.payload.run)!==JSON.stringify(oldRun)))return {outcome:'unavailable' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'conflict' as const};
      const now=Math.max(Date.now(),state.updatedAt),run=v.parse(aiIntakeRunSchema,{schemaVersion:2,kind:'intake',scope,request,admission,controlEpoch:state.controlEpoch+1,startedAt:now,deadlineAt:now+this.aiTimeoutMs()});
      const appliedState:ControlState={...state,reception:'ai',version:state.version+1,sequence:state.sequence+1,controlEpoch:run.controlEpoch,updatedAt:now};
      const receipt=checkedAiIntakeReceipt({action:'ai_intake_start',origin:'system',commandId,expectedVersion:state.version,actorUserId:null,actorMemberId:null,run,appliedState});
      await transaction.delete(['aiPendingInput','aiListening','aiClassification']);await transaction.put('aiRun',run);await transaction.put('aiDeadline',run.deadlineAt);await this.persistCommand(transaction,{scope,receipt});return {outcome:'accepted' as const,receipt,state:appliedState};
    });
    if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  /** Queue retries retain the original request version; current state is still checked before model work. */
  async admitAiDispatch(scope:ControlScope,value:unknown){
    const input=v.parse(aiDispatchAdmissionSchema,value);if(!this.env.DB||!this.routed(scope))return {outcome:'unavailable' as const};
    const saved=await this.ctx.storage.get(`receipt:ai-intake:${input.runId}`);
    if(saved){
      const receipt=checkedAiIntakeReceipt(saved);if(receipt.action!=='ai_intake_start'||!sameScope(receipt.run.scope,scope)||receipt.run.admission.event.eventId!==input.eventId)return {outcome:'conflict' as const};
      const value=await this.ctx.storage.get(`receipt:ai-classification:${input.runId}`),classified=value?checkedAiIntakeReceipt(value):null;
      const answerRunId=classified?.action==='ai_classification'&&classified.decision.kind==='ready'&&JSON.stringify(classified.run)===JSON.stringify(receipt.run)?classified.decision.nextRunId:null;
      return {...await this.startAiIntake(scope,receipt.run.request),answerRunId};
    }
    const inbound=await this.ctx.storage.get(`receipt:inbound:${input.eventId}`),event=await readInboundEvent(this.env.DB,scope,input.eventId),directory=await readControlDirectory(this.env.DB,scope);
    if(!inbound||!event||!directory||JSON.stringify(checkedInboundReceipt(inbound).event)!==JSON.stringify(event))return {outcome:'conflict' as const};
    const state=await this.ctx.storage.transaction(transaction=>this.state(transaction,directory));
    return {...await this.startAiIntake(scope,{runId:input.runId,expectedVersion:state.version,messageId:event.messageId}),answerRunId:null};
  }
  async stopAiDispatch(scope:ControlScope,value:unknown){
    const input=v.parse(aiDispatchStopRequestSchema,value);if(!this.env.DB||!this.routed(scope))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const recorded=await this.ctx.storage.get(`receipt:inbound:${input.eventId}`),event=recorded?checkedInboundReceipt(recorded).event:null,commandId=`ai-dispatch-stop:${input.runId}`;
    if(event&&!sameScope(event.scope,scope))return {outcome:'unavailable' as const};
    // A newer live customer input must first reach the controller; an external seller reply must not leave preparation stuck.
    const pendingNewer=event?await this.env.DB.prepare(`SELECT m.id FROM message m JOIN ingest_event e
      ON e.message_id=m.id AND e.organization_id=m.organization_id AND e.store_id=m.store_id AND e.conversation_id=m.conversation_id
      WHERE m.organization_id=? AND m.store_id=? AND m.conversation_id=? AND m.id<>? AND m.direction='inbound' AND m.ingest_mode='incremental'
       AND e.state='pending' AND e.schema_version=1 AND e.live_observed_at IS NOT NULL AND e.processed_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM message n WHERE n.organization_id=m.organization_id AND n.store_id=m.store_id AND n.conversation_id=m.conversation_id
        AND (n.event_at>m.event_at OR (n.event_at=m.event_at AND n.id>m.id)))`).bind(scope.organizationId,scope.storeId,scope.conversationId,event.messageId).first():null;
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get(`receipt:${commandId}`);
      if(saved){const receipt=checkedAiDispatchStopReceipt(saved);return sameScope(receipt.event.scope,scope)&&JSON.stringify(receipt.input)===JSON.stringify(input)?{outcome:'accepted' as const,receipt,state}:{outcome:'conflict' as const};}
      if(!event||state.lifecycle!=='open'||state.assignedMemberId!==null||state.workStatus!=='needs_reply'||(state.reception!=='ai'&&!(state.reception==='paused'&&state.controlEpoch===0))||await transaction.get('aiListening'))return {outcome:'ignored' as const,state};
      const inbound=await transaction.get(`receipt:inbound:${input.eventId}`);if(!inbound||JSON.stringify(checkedInboundReceipt(inbound).event)!==JSON.stringify(event))return {outcome:'ignored' as const,state};
      const value=await transaction.get('aiPendingInput'),pending=value?v.parse(aiPendingInputSchema,value):null,work=await transaction.get('aiRun'),run=work?v.parse(aiWorkSchema,work):null;
      const classification=await transaction.get(`receipt:ai-classification:${input.runId}`),classified=classification?checkedAiIntakeReceipt(classification):null;
      const answerId=classified?.action==='ai_classification'&&classified.decision.kind==='ready'&&classified.run.admission.event.eventId===input.eventId&&sameScope(classified.run.scope,scope)?classified.decision.nextRunId:null;
      if(run?.controlEpoch===state.controlEpoch&&run.request.runId!==input.runId&&run.request.runId!==answerId)return {outcome:'ignored' as const,state};
      if(run?.schemaVersion===1&&run.controlEpoch===state.controlEpoch){
        const delivered=await this.storedReply(transaction,`ai-reply:${run.request.runId}`);
        if(delivered?.intent.schemaVersion===2&&delivered.intent.runId===run.request.runId&&delivered.intent.state==='sent')return {outcome:'ignored' as const,state};
      }
      const classificationKey=await transaction.get('aiClassification');if(classificationKey&&classificationKey!==`ai-classification:${input.runId}`)return {outcome:'ignored' as const,state};
      if(input.targetRunId!==null&&((run?.controlEpoch===state.controlEpoch&&run.request.runId!==input.targetRunId)||(classificationKey&&input.targetRunId!==answerId)))return {outcome:'retry' as const,state};
      const current=pending?.controlEpoch===state.controlEpoch?pending.event.eventId===event.eventId:run?.controlEpoch===state.controlEpoch?run.request.messageId===event.messageId:state.controlEpoch===0;
      if(!current||[state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'ignored' as const,state};
      if(pendingNewer&&input.reason!=='disabled')return {outcome:'retry' as const,state};
      const appliedState:ControlState={...state,reception:'paused',assignedMemberId:null,workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,controlEpoch:state.controlEpoch+1,updatedAt:Math.max(Date.now(),state.updatedAt)};
      const receipt=checkedAiDispatchStopReceipt({action:'ai_dispatch_stop',origin:'system',commandId,expectedVersion:state.version,expectedEpoch:state.controlEpoch,actorUserId:null,actorMemberId:null,input,event,appliedState});
      await transaction.delete(['aiPendingInput','aiListening','aiClassification','aiDeadline']);await this.persistCommand(transaction,{scope,receipt});return {outcome:'accepted' as const,receipt,state:appliedState};
    });
    if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  private async commitClassification(directory:ControlDirectory,run:AiIntakeRun,classification:AiClassification|null,origin:'agent'|'system',fallback?:AiIntakeDecision){
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),commandId=`ai-classification:${run.request.runId}`,saved=await transaction.get(`receipt:${commandId}`);
      if(saved){const receipt=checkedAiIntakeReceipt(saved);return receipt.action==='ai_classification'&&receipt.origin===origin&&JSON.stringify(receipt.run)===JSON.stringify(run)&&JSON.stringify(receipt.classification)===JSON.stringify(classification)?{outcome:'accepted' as const,receipt,state}:{outcome:'conflict' as const};}
      if(state.lifecycle!=='open'||state.reception!=='ai'||state.controlEpoch!==run.controlEpoch||JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(run))return {outcome:'conflict' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'conflict' as const};
      const decision=classification?classifyDecision(run,classification):fallback!;
      const appliedState:ControlState={...state,reception:decision.kind==='ready'?'ai':'paused',assignedMemberId:null,workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,controlEpoch:state.controlEpoch+1,updatedAt:Math.max(Date.now(),state.updatedAt)};
      const receipt=checkedAiIntakeReceipt({action:'ai_classification',origin,commandId,expectedVersion:state.version,actorUserId:null,actorMemberId:null,run,classification,decision,appliedState});
      await transaction.delete(['aiDeadline','aiListening','aiPendingInput','aiClassification']);
      if(decision.kind==='ready'){await transaction.put('aiPendingInput',{schemaVersion:1,event:run.admission.event,controlEpoch:appliedState.controlEpoch});await transaction.put('aiClassification',commandId);}
      await this.persistCommand(transaction,{scope:directory.scope,receipt});return {outcome:'accepted' as const,receipt,state:appliedState};
    });
  }
  async recordAiClassification(scope:ControlScope,runId:string,value:unknown){
    const input=v.parse(aiClassificationSchema,value);
    if(!this.env.DB||!this.routed(scope)||!v.is(v.pipe(v.string(),v.uuid()),runId))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const saved=await this.ctx.storage.get(`receipt:ai-classification:${runId}`),historical=saved?checkedAiIntakeReceipt(saved):null;
    const work=historical?.run??await this.readAiWork(scope,runId);if(work?.schemaVersion!==2||!sameScope(work.scope,scope))return {outcome:'unavailable' as const};
    const result=await this.commitClassification(directory,work,input,'agent');if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  async readClassifiedInput(scope:ControlScope){
    if(!this.env.DB||!this.routed(scope))return null;const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return null;
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),key=await transaction.get<string>('aiClassification');if(!key)return null;
      const receipt=checkedAiIntakeReceipt(await transaction.get(`receipt:${key}`));
      if(receipt.action!=='ai_classification'||receipt.decision.kind!=='ready'||!sameScope(receipt.run.scope,scope)||state.lifecycle!=='open'||state.reception!=='ai'||state.controlEpoch!==receipt.appliedState.controlEpoch)return null;
      const d=receipt.decision;return {intakeRunId:receipt.run.request.runId,request:{runId:d.nextRunId,expectedVersion:state.version,messageId:receipt.run.request.messageId,policyId:d.policyId,stage:d.stage,language:d.language}};
    });
  }
  /** Waiting is separate from an executable run and does not reserve model budget. */
  async readAiListening(scope:ControlScope):Promise<AiListening|null>{
    if(!this.env.DB||!this.routed(scope))return null;
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return null;
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),value=await transaction.get('aiListening');if(!value)return null;
      const listening=v.parse(aiListeningSchema,value);
      return sameScope(listening.scope,scope)&&state.lifecycle==='open'&&state.reception==='ai'&&state.controlEpoch===listening.controlEpoch?listening:null;
    });
  }
  async resumeAiForNewMessages(scope:ControlScope,actor:ControlActor,value:unknown){
    const request=v.parse(aiListeningRequestSchema,value),access=await this.access(scope,actor);
    if(!access?.directory||!actor.expectedMemberId||actor.expectedMemberId!==access.memberId)return {outcome:'not_found' as const};
    const directory=access.directory,commandId=`ai-listen:${request.commandId}`,oldValue=await this.ctx.storage.get('aiRun'),oldRun=oldValue?v.parse(aiWorkSchema,oldValue):null;
    const boundary=await readAiListeningBoundary(this.env.DB!,scope),execution=oldRun?await readAiExecution(this.env.DB!,scope,oldRun.request.runId):null;
    if((await this.access(scope,actor))?.memberId!==access.memberId)return {outcome:'not_found' as const};
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get<ControlEvent['receipt']>(`receipt:${commandId}`);
      if(saved){if(saved.action!=='ai_listen')return {outcome:'conflict' as const};const receipt=checkedAiListeningReceipt(saved);return receipt.actorUserId===actor.actorUserId&&receipt.actorMemberId===access.memberId&&JSON.stringify(receipt.listening.request)===JSON.stringify(request)&&sameScope(receipt.listening.scope,scope)?{outcome:'accepted' as const,receipt,state,canSend:false as const}:{outcome:'conflict' as const};}
      if(this.env.AI_RECEPTION_ENABLED!=='true'||boundary===null)return {outcome:'unavailable' as const};
      if(state.version!==request.expectedVersion||state.lifecycle!=='open'||state.reception==='ai'||(oldRun?.request.runId??null)!==request.previousRunId||JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(oldValue)||(oldRun&&state.controlEpoch<=oldRun.controlEpoch))return {outcome:'conflict' as const};
      if(execution&&(!execution.closure||JSON.stringify(execution.payload.run)!==JSON.stringify(oldRun)))return {outcome:'unavailable' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'conflict' as const};
      const now=Math.max(Date.now(),state.updatedAt),listening=v.parse(aiListeningSchema,{schemaVersion:1,scope,request,afterSequence:boundary,createdAt:now,controlEpoch:state.controlEpoch+1});
      const appliedState:ControlState={...state,reception:'ai',assignedMemberId:null,workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,controlEpoch:listening.controlEpoch,updatedAt:now};
      const receipt=checkedAiListeningReceipt({action:'ai_listen',origin:'human',commandId,expectedVersion:state.version,actorUserId:actor.actorUserId,actorMemberId:access.memberId,appliedState,listening});
      await transaction.put('aiListening',listening);await transaction.delete('aiDeadline');await this.persistCommand(transaction,{scope,receipt});return {outcome:'accepted' as const,receipt,state:appliedState,canSend:false as const};
    });
    if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  /** Repair address only; never grants permission to execute the historical run. */
  async readAiRunTarget(scope:ControlScope):Promise<string|null>{
    if(!this.env.DB||!this.routed(scope))return null;
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return null;
    return this.ctx.storage.transaction(async transaction=>{
      await this.state(transaction,directory);const value=await transaction.get('aiRun');if(!value)return null;
      const run=v.parse(aiWorkSchema,value);return sameScope(run.scope,scope)?run.request.runId:null;
    });
  }
  /** Internal execution authorization; historical start receipts do not grant a new call. */
  async readAiRun(scope:ControlScope,runId:string):Promise<AiRun|null>{
    if(this.env.AI_RECEPTION_ENABLED!=='true'||!this.env.DB||!this.routed(scope)||!v.is(v.pipe(v.string(),v.uuid()),runId))return null;
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return null;
    const value=await this.ctx.storage.get('aiRun');if(!value)return null;
    const work=v.parse(aiWorkSchema,value);if(work.schemaVersion!==1)return null;const run=work;if(run.request.runId!==runId||!sameScope(run.scope,scope)||Date.now()>=run.deadlineAt)return null;
    const admission=await readAiAdmission(this.env.DB,scope,run.request);if(JSON.stringify(admission)!==JSON.stringify(run.admission))return null;
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory);
      return state.lifecycle==='open'&&state.reception==='ai'&&state.controlEpoch===run.controlEpoch&&Date.now()<run.deadlineAt
        &&JSON.stringify(await transaction.get('aiRun'))===JSON.stringify(run)?run:null;
    });
  }
  private aiResult(receipt:AiReceipt,state:ControlState){
    return {outcome:'accepted' as const,receipt,state,canSend:false as const,notice:receipt.action==='request_handoff'?handoffNotice(receipt):null};
  }
  /** Internal RPC only. No model argument or simulation result grants admission. */
  async startAi(scope:ControlScope,value:unknown){
    const request=v.parse(aiStartSchema,value);
    if(this.env.AI_RECEPTION_ENABLED!=='true'||!this.env.DB||!this.routed(scope))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const admission=await readAiAdmission(this.env.DB,scope,request),commandId=`ai-start:${request.runId}`;
    const selected=await selectReplyPolicy(this.env.DB,scope,request.stage);
    const listening=await this.readAiListening(scope),newInput=listening?await isNewAiInput(this.env.DB,listening,request.messageId):false;
    const pending=await this.readPendingAiInput(scope),oldValue=await this.ctx.storage.get('aiRun'),oldRun=oldValue?v.parse(aiWorkSchema,oldValue):null;
    const execution=oldRun?await readAiExecution(this.env.DB,scope,oldRun.request.runId):null;
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get<ControlReceipt|AiReceipt>(`receipt:${commandId}`);
      if(saved){if(saved.action!=='ai_start')return {outcome:'conflict' as const};const receipt=checkedAiReceipt(saved);return JSON.stringify(receipt.run.request)===JSON.stringify(request)&&sameScope(receipt.run.scope,scope)?this.aiResult(receipt,state):{outcome:'conflict' as const};}
      if(!admission||selected?.id!==admission.policyId||selected.revision!==admission.policyRevision||selected.config.mode!=='automatic')return {outcome:'unavailable' as const};
      if(listening&&!newInput)return {outcome:'unavailable' as const};
      if(JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(oldValue))return {outcome:'conflict' as const};
      const waiting=listening&&state.reception==='ai'&&state.controlEpoch===listening.controlEpoch&&JSON.stringify(await transaction.get('aiListening'))===JSON.stringify(listening)&&(oldRun?.request.runId??null)===listening.request.previousRunId&&oldRun?.request.runId!==request.runId;
      const queued=pending&&pending.event.messageId===request.messageId&&state.reception==='ai'&&state.controlEpoch===pending.controlEpoch&&JSON.stringify(await transaction.get('aiPendingInput'))===JSON.stringify(pending)&&(!oldRun||oldRun.controlEpoch<state.controlEpoch)&&oldRun?.request.runId!==request.runId;
      if(queued&&oldRun?.schemaVersion===2){
        const key=await transaction.get<string>('aiClassification'),value=key?await transaction.get(`receipt:${key}`):null,classified=value?checkedAiIntakeReceipt(value):null;
        if(classified?.action!=='ai_classification'||classified.decision.kind!=='ready'||classified.appliedState.controlEpoch!==state.controlEpoch||JSON.stringify(classified.run)!==JSON.stringify(oldRun)
          ||classified.decision.nextRunId!==request.runId||classified.decision.policyId!==request.policyId||classified.decision.stage!==request.stage||classified.decision.language!==request.language)return {outcome:'conflict' as const};
        if(classified.decision.policyRevision!==admission.policyRevision)return {outcome:'unavailable' as const};
      }
      if(queued&&execution&&(!execution.closure||JSON.stringify(execution.payload.run)!==JSON.stringify(oldRun)))return {outcome:'unavailable' as const};
      if(state.version!==request.expectedVersion||state.lifecycle!=='open'||(!waiting&&!queued&&(state.reception!=='paused'||state.controlEpoch!==0||oldRun))||state.assignedMemberId!==null||state.workStatus!=='needs_reply'||await transaction.get(`receipt:ai-resume:${request.runId}`)||await transaction.get(`receipt:ai-handoff:${request.runId}`)||await transaction.get(`receipt:ai-intake:${request.runId}`))return {outcome:'conflict' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'conflict' as const};
      const now=Math.max(Date.now(),state.updatedAt),run=v.parse(aiRunSchema,{schemaVersion:1,scope,request,admission,controlEpoch:state.controlEpoch+1,startedAt:now,deadlineAt:now+this.aiTimeoutMs()});
      const appliedState:ControlState={...state,reception:'ai',version:state.version+1,sequence:state.sequence+1,controlEpoch:run.controlEpoch,updatedAt:now};
      const receipt=checkedAiReceipt({action:'ai_start',origin:'system',commandId,expectedVersion:state.version,actorUserId:null,actorMemberId:null,appliedState,run});
      await transaction.delete('aiClassification');await transaction.delete('aiPendingInput');await transaction.delete('aiListening');await transaction.put('aiRun',run);await transaction.put('aiDeadline',run.deadlineAt);await this.persistCommand(transaction,{scope,receipt});return this.aiResult(receipt,appliedState);
    });
    await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  /** Explicit human authorization; rotating the current slot does not retire its financial repair record. */
  async resumeAi(scope:ControlScope,actor:ControlActor,value:unknown){
    const {previousRunId,...request}=v.parse(aiResumeSchema,value),access=await this.access(scope,actor);
    if(!access?.directory||!actor.expectedMemberId||actor.expectedMemberId!==access.memberId)return {outcome:'not_found' as const};
    const directory=access.directory,commandId=`ai-resume:${request.runId}`,oldValue=await this.ctx.storage.get('aiRun'),oldRun=oldValue?v.parse(aiWorkSchema,oldValue):null;
    const admission=await readAiAdmission(this.env.DB!,scope,request),execution=oldRun?await readAiExecution(this.env.DB!,scope,oldRun.request.runId):null;
    const selected=await selectReplyPolicy(this.env.DB!,scope,request.stage);
    if((await this.access(scope,actor))?.memberId!==access.memberId)return {outcome:'not_found' as const};
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get<ControlReceipt|AiReceipt>(`receipt:${commandId}`);
      if(saved){if(saved.action!=='ai_resume')return {outcome:'conflict' as const};const receipt=checkedAiReceipt(saved);return receipt.action==='ai_resume'&&receipt.actorUserId===actor.actorUserId&&receipt.actorMemberId===access.memberId&&receipt.previousRunId===previousRunId&&JSON.stringify(receipt.run.request)===JSON.stringify(request)&&sameScope(receipt.run.scope,scope)?this.aiResult(receipt,state):{outcome:'conflict' as const};}
      if(this.env.AI_RECEPTION_ENABLED!=='true'||!admission||selected?.id!==admission.policyId||selected.revision!==admission.policyRevision||selected.config.mode!=='automatic')return {outcome:'unavailable' as const};
      if(state.version!==request.expectedVersion||state.lifecycle!=='open'||state.reception==='ai'||(oldRun?.request.runId??null)!==previousRunId||JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(oldValue)
        ||(oldRun&&state.controlEpoch<=oldRun.controlEpoch)||await transaction.get(`receipt:ai-start:${request.runId}`)||await transaction.get(`receipt:ai-handoff:${request.runId}`)||await transaction.get(`receipt:ai-intake:${request.runId}`))return {outcome:'conflict' as const};
      if(execution&&(!execution.closure||JSON.stringify(execution.payload.run)!==JSON.stringify(oldRun)))return {outcome:'unavailable' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER-1))return {outcome:'conflict' as const};
      const now=Math.max(Date.now(),state.updatedAt),run=v.parse(aiRunSchema,{schemaVersion:1,scope,request,admission,controlEpoch:state.controlEpoch+1,startedAt:now,deadlineAt:now+this.aiTimeoutMs()});
      const appliedState:ControlState={...state,lifecycle:'open',reception:'ai',assignedMemberId:null,workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,controlEpoch:run.controlEpoch,updatedAt:now};
      const receipt=checkedAiReceipt({action:'ai_resume',origin:'human',commandId,expectedVersion:state.version,actorUserId:actor.actorUserId,actorMemberId:access.memberId,appliedState,run,previousRunId});
      await transaction.put('aiRun',run);await transaction.put('aiDeadline',run.deadlineAt);await this.persistCommand(transaction,{scope,receipt});return this.aiResult(receipt,appliedState);
    });
    if(result.outcome==='accepted')await this.flush(scope);return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  private async commitHandoff(directory:ControlDirectory,run:AiRun,input:AiHandoff,origin:'agent'|'system'){
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),commandId=`ai-handoff:${run.request.runId}`,saved=await transaction.get<ControlReceipt|AiReceipt>(`receipt:${commandId}`);
      if(saved){if(saved.action!=='request_handoff')return {outcome:'conflict' as const};const receipt=checkedAiReceipt(saved);return receipt.action==='request_handoff'&&receipt.origin===origin&&JSON.stringify(receipt.input)===JSON.stringify(input)&&JSON.stringify(receipt.run)===JSON.stringify(run)?this.aiResult(receipt,state):{outcome:'conflict' as const};}
      if(state.lifecycle!=='open'||state.reception!=='ai'||state.controlEpoch!==run.controlEpoch)return {outcome:'conflict' as const};
      if([state.version,state.controlEpoch,state.sequence].some(n=>n>=Number.MAX_SAFE_INTEGER))return {outcome:'conflict' as const};
      const appliedState:ControlState={...state,reception:'paused',assignedMemberId:null,workStatus:'needs_reply',version:state.version+1,sequence:state.sequence+1,controlEpoch:state.controlEpoch+1,updatedAt:Math.max(Date.now(),state.updatedAt)};
      const receipt=checkedAiReceipt({action:'request_handoff',origin,commandId,expectedVersion:state.version,actorUserId:null,actorMemberId:null,appliedState,run,input});
      await transaction.delete('aiDeadline');await this.persistCommand(transaction,{scope:directory.scope,receipt});return this.aiResult(receipt,appliedState);
    });
  }
  async requestHandoff(scope:ControlScope,runId:string,value:unknown){
    const input=v.parse(aiHandoffSchema,value);
    if(!v.is(v.pipe(v.string(),v.uuid()),runId)||!this.env.DB||!this.routed(scope))return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const historical=await this.ctx.storage.get<ControlReceipt|AiReceipt>(`receipt:ai-handoff:${runId}`);
    const valueRun=historical?.action==='request_handoff'?checkedAiReceipt(historical).run:await this.ctx.storage.get('aiRun');if(!valueRun)return {outcome:'unavailable' as const};
    const work=v.parse(aiWorkSchema,valueRun);if(work.schemaVersion!==1)return {outcome:'unavailable' as const};const run=work;if(run.request.runId!==runId||!sameScope(run.scope,scope))return {outcome:'unavailable' as const};
    // A committed receipt is historical evidence, even after policy disablement.
    if(!historical){
      if(this.env.AI_RECEPTION_ENABLED!=='true'||Date.now()>=run.deadlineAt)return {outcome:'unavailable' as const};
      const admission=await readAiAdmission(this.env.DB,scope,run.request);if(JSON.stringify(admission)!==JSON.stringify(run.admission))return {outcome:'unavailable' as const};
    }
    const result=await this.commitHandoff(directory,run,input,'agent');await this.flush(scope);
    return result.outcome==='accepted'?{...result,state:await this.ctx.storage.transaction(transaction=>this.state(transaction,directory))}:result;
  }
  private async expireAi(directory:ControlDirectory){
    const value=await this.ctx.storage.get('aiRun');if(!value)return;
    const run=v.parse(aiWorkSchema,value);if(!sameScope(run.scope,directory.scope))throw new Error('AI_SCOPE_MISMATCH');
    if(run.schemaVersion===1&&await this.ctx.storage.transaction(async transaction=>{
      const delivered=await this.storedReply(transaction,`ai-reply:${run.request.runId}`);
      if(delivered?.intent.schemaVersion!==2||delivered.intent.runId!==run.request.runId||delivered.intent.state!=='sent')return false;
      if(JSON.stringify(await transaction.get('aiRun'))===JSON.stringify(run)){
        await transaction.delete('aiDeadline');const wake=await transaction.get<{runId:string}>('aiReplyWake');
        if(wake?.runId===run.request.runId)await transaction.delete('aiReplyWake');await this.schedule(transaction);
      }
      return true;
    }))return;
    if(Date.now()<run.deadlineAt)return;
    if(run.schemaVersion===2)await this.commitClassification(directory,run,null,'system',{kind:'handoff',reason:'timeout'});else await this.commitHandoff(directory,run,{reason:'tool_failure',summary:'The automatic support run exceeded its deadline.',neededInformation:[]},'system');
    await this.ctx.storage.transaction(async transaction=>{
      if(JSON.stringify(await transaction.get('aiRun'))===JSON.stringify(run))await transaction.delete('aiDeadline');
      await this.schedule(transaction);
    });
  }
  private async history(transaction:DurableObjectTransaction,sequence:number):Promise<ReplyHistory> {
    const stored=await transaction.get('replyHistory');
    if(stored===undefined)return {schemaVersion:1,observedSequence:sequence,complete:false,after:null,recent:[]};
    const parsed=v.safeParse(historySchema,stored);if(!parsed.success||parsed.output.observedSequence>sequence)throw new Error('INVALID_REPLY_HISTORY');
    const history=parsed.output;
    if(history.observedSequence<sequence){history.complete=false;history.after=null;history.observedSequence=sequence;}
    return history;
  }
  private addHistory(history:ReplyHistory,id:string,sequence:number) {
    if(history.recent.some(item=>(item.id===id&&item.sequence!==sequence)||(item.sequence===sequence&&item.id!==id)))throw new Error('INVALID_REPLY_HISTORY');
    history.recent=[...history.recent.filter(item=>item.id!==id),{id,sequence}].sort((left,right)=>right.sequence-left.sequence).slice(0,20);
  }
  private async recoverHistory(transaction:DurableObjectTransaction,sequence:number) {
    const history=await this.history(transaction,sequence);
    if(!history.complete) {
      const batch=await transaction.list<ReplySnapshot>({prefix:replyPrefix,limit:51,...(history.after===null?{}:{startAfter:history.after})});
      const keys=[...batch.keys()].slice(0,50);
      for(const key of keys) {
        const id=key.slice(replyPrefix.length),snapshot=await this.storedReply(transaction,id);if(!snapshot)throw new Error('INVALID_REPLY_HISTORY');
        const receipt=(await transaction.get<ControlReceipt|AiSendReceipt>(`receipt:${id}`))!;
        this.addHistory(history,id,receipt.appliedState.sequence);
      }
      history.complete=batch.size<=50;history.after=history.complete?null:keys.at(-1)!;
      await transaction.put('replyHistory',history);
    }
    return history;
  }
  async readReplies(scope:ControlScope,actor:ControlActor):Promise<ReplyListReadResult> {
    const access=await this.access(scope,actor);if(!access?.directory)return {outcome:'not_found'};
    const context=this.env.OUTBOUND_ENABLED==='true'?await readReplyDispatchContext(this.env.DB!,scope,actor.actorUserId,access.memberId):null;
    if(this.env.OUTBOUND_ENABLED==='true'&&!context)return {outcome:'not_found'};
    const directory=access.directory;
    return this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),history=await this.recoverHistory(transaction,state.sequence),replies=[];
      for(const item of history.recent) {
        const snapshot=await this.storedReply(transaction,item.id),receipt=await transaction.get<ControlReceipt|AiSendReceipt>(`receipt:${item.id}`);
        if(!snapshot||!receipt||receipt.appliedState.sequence!==item.sequence)throw new Error('INVALID_REPLY_HISTORY');
        replies.push(replyView(snapshot,receipt.action==='send_reply'?receipt.previewRequestId:undefined));
      }
      const code=!history.complete||[state.version,state.sequence].some(value=>value===Number.MAX_SAFE_INTEGER)?'REPLY_UNAVAILABLE' as const:this.replyGate(context,state);
      return {outcome:'found' as const,viewerMemberId:access.memberId,controlVersion:state.version,historyReady:history.complete,readiness:{allowed:code===null,code},replies};
    });
  }
  async readReply(scope:ControlScope,actor:ControlActor,intentId:string):Promise<ReplyReadResult> {
    if(!identifier(intentId))throw new Error('INVALID_REPLY_ID');
    const access=await this.access(scope,actor);if(!access?.directory)return {outcome:'not_found'};
    const directory=access.directory;
    return this.ctx.storage.transaction(async transaction=>{
      await this.state(transaction,directory);
      const snapshot=await this.storedReply(transaction,intentId);
      const receipt=await transaction.get<Extract<ControlReceipt,{action:'send_reply'}>|AiSendReceipt>(`receipt:${intentId}`);
      return snapshot?{outcome:'found' as const,reply:replyView(snapshot,receipt?.action==='send_reply'?receipt.previewRequestId:undefined)}:{outcome:'not_found' as const};
    });
  }
  async readNotes(scope:ControlScope,actor:ControlActor,beforeSequence:number|null,limit:number):Promise<ControlNotesReadResult> {
    if((beforeSequence!==null&&(!Number.isSafeInteger(beforeSequence)||beforeSequence<1))||!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('INVALID_CONTROL_NOTES_PAGE');
    const access=await this.access(scope,actor);if(!access?.directory)return {outcome:'not_found'};
    const directory=access.directory;
    return this.ctx.storage.transaction(async transaction=>{
      await this.state(transaction,directory);
      const index=await transaction.list<string>({prefix:notePrefix,reverse:true,limit:limit+1,...(beforeSequence===null?{}:{end:noteKey(beforeSequence)})});
      const receiptKeys=[...index.values()].map(id=>{
        if(!identifier(id))throw new Error('INVALID_CONTROL_NOTE');return `receipt:${id}`;
      });
      const receipts=receiptKeys.length?await transaction.get<ControlReceipt>(receiptKeys):new Map<string,ControlReceipt>();
      const notes=[...index].map(([key,id])=>{
        const sequence=Number(key.slice(notePrefix.length));
        if(!Number.isSafeInteger(sequence)||sequence<1||key!==noteKey(sequence))throw new Error('INVALID_CONTROL_NOTE');
        return noteFromReceipt(receipts.get(`receipt:${id}`),id,sequence);
      });
      return {outcome:'found' as const,notes:notes.slice(0,limit),nextBeforeSequence:notes.length>limit?notes[limit-1]!.sequence:null};
    });
  }
  /** Internal system command: all message and channel fields come from the frozen reply. */
  async enqueueAiReply(scope:ControlScope,runId:string) {
    if(!this.env.DB||!this.routed(scope)||!v.is(v.pipe(v.string(),v.uuid()),runId))return {outcome:'unavailable' as const};
    // A historical acknowledgement does not reopen, requeue or authorize the original reply.
    const historical=await this.ctx.storage.transaction(async transaction=>{
      const saved=await transaction.get(`receipt:ai-reply:${runId}`);if(saved===undefined)return null;
      const bound=await transaction.get<ControlScope>('scope');if(!bound||!sameScope(bound,scope))return null;
      const receipt=checkedAiSendReceipt(saved);
      if(receipt.runId!==runId||!await this.storedReply(transaction,receipt.intentId))throw new Error('INVALID_REPLY_STATE');return {outcome:'accepted' as const,receipt};
    });
    if(historical)return historical;
    const prepared=await reviewCompletedAiReply(this.env,(s,id)=>this.readAiRun(s,id),scope,runId);
    if(!prepared)return {outcome:'unavailable' as const};
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return {outcome:'unavailable' as const};
    const hash=await bodyHash(prepared.body);
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory),saved=await transaction.get<AiSendReceipt>(`receipt:${prepared.id}`);
      if(saved){const receipt=checkedAiSendReceipt(saved);if(!await this.storedReply(transaction,prepared.id)||receipt.body!==prepared.body||receipt.runId!==runId)throw new Error('INVALID_REPLY_STATE');return {outcome:'accepted' as const,receipt};}
      const active=await transaction.get<AiRun>('aiRun');
      if(JSON.stringify(active)!==JSON.stringify(prepared.run)||Date.now()>=prepared.run.deadlineAt||state.lifecycle!=='open'||state.reception!=='ai'
        ||state.workStatus!=='needs_reply'||state.assignedMemberId!==null||state.controlEpoch!==prepared.run.controlEpoch)return {outcome:'conflict' as const};
      if([state.version,state.sequence].some(value=>value===Number.MAX_SAFE_INTEGER))throw new Error('CONTROL_VERSION_EXHAUSTED');
      const now=Math.max(Date.now(),state.updatedAt),appliedState:ControlState={...state,version:state.version+1,sequence:state.sequence+1,updatedAt:now};
      const receipt=checkedAiSendReceipt({action:'ai_send_reply',origin:'ai',runId,commandId:prepared.id,intentId:prepared.id,body:prepared.body,
        expectedVersion:state.version,actorUserId:null,actorMemberId:null,appliedState});
      await this.putReply(transaction,{intent:{schemaVersion:2,origin:'ai',runId,id:prepared.id,commandId:prepared.id,actorUserId:null,actorMemberId:null,
        body:prepared.body,bodyHash:hash,platformThreadId:prepared.platformThreadId,credentialVersion:prepared.credentialVersion,controlEpoch:prepared.run.controlEpoch,
        state:'queued',revision:1,createdAt:now,updatedAt:now,dueAt:Math.min(now+1_000,prepared.run.deadlineAt),lastError:null},attempt:null});
      await this.persistCommand(transaction,{scope,receipt});return {outcome:'accepted' as const,receipt};
    });
    if(result.outcome==='accepted')await this.flush(scope);return result;
  }
  /** Observation is bounded by the original run deadline and grants no send authority. */
  async wakeAiReply(scope:ControlScope,runId:string):Promise<void> {
    if(!this.routed(scope))throw new Error('AI_REPLY_UNAVAILABLE');
    const read=(s:ControlScope,id:string)=>this.readAiRun(s,id);
    const prepared=await reviewAiReply(this.env,read,scope,runId)??await reviewCompletedAiReply(this.env,read,scope,runId);
    if(!prepared)throw new Error('AI_REPLY_UNAVAILABLE');
    await this.ctx.storage.transaction(async transaction=>{
      if(JSON.stringify(await transaction.get('aiRun'))!==JSON.stringify(prepared.run)||Date.now()>=prepared.run.deadlineAt)throw new Error('AI_REPLY_UNAVAILABLE');
      await transaction.put('aiReplyWake',{runId,dueAt:Math.min(Date.now()+1_000,prepared.run.deadlineAt),deadlineAt:prepared.run.deadlineAt});await this.schedule(transaction);
    });
  }
  protected async observeAiReply(scope:ControlScope,runId:string) {
    return (await import('../ai-runs/execution.ts')).readExecutedAiRun(this.env as SupportBindings,scope,runId);
  }
  private async pollAiReply(scope:ControlScope) {
    const value=await this.ctx.storage.get('aiReplyWake');if(value===undefined)return;
    const wake=v.parse(aiReplyWakeSchema,value);if(wake.dueAt>Date.now())return;
    let retry=false;
    try{
      if(!await this.readAiRun(scope,wake.runId))return;
      const observed=await this.observeAiReply(scope,wake.runId);
      if(observed.status==='completed')retry=(await this.enqueueAiReply(scope,wake.runId)).outcome!=='accepted';
      else retry=observed.status==='pending'||observed.status==='unconfirmed';
    }catch{retry=true;}
    finally{await this.ctx.storage.transaction(async transaction=>{
      if(JSON.stringify(await transaction.get('aiReplyWake'))!==JSON.stringify(wake))return;
      if(retry&&Date.now()<wake.deadlineAt)await transaction.put('aiReplyWake',{...wake,dueAt:Math.min(Date.now()+1_000,wake.deadlineAt)});
      else await transaction.delete('aiReplyWake');await this.schedule(transaction);
    });}
  }
  async execute(scope:ControlScope,actor:ControlActor,command:ControlCommand):Promise<ControlCommandResult> {
    // Authorization precedes the receipt lookup, including retries after a lost response.
    const parsed=v.safeParse(controlCommandSchema,command);if(!parsed.success)throw new Error('INVALID_CONTROL_COMMAND');
    command=parsed.output;
    const access=await this.access(scope,actor,command.action==='transfer'?command.targetMemberId:undefined);if(!access?.directory)return {outcome:'not_found'};
    if((command.action==='send_reply'||command.action==='cancel_reply')&&actor.expectedMemberId!==undefined&&actor.expectedMemberId!==access.memberId)return {outcome:'not_found'};
    const directory=access.directory;
    let context:ReplyDispatchContext|null=null,hash='',translation:ReplyTranslation|undefined;
    if(command.action==='send_reply'&&this.env.OUTBOUND_ENABLED==='true'&&!await this.ctx.storage.get(`receipt:${command.commandId}`)) {
      context=await readReplyDispatchContext(this.env.DB!,scope,actor.actorUserId,access.memberId);
      if(!context)return {outcome:'not_found'};
      hash=await bodyHash(command.body);
      if(command.previewRequestId){
        translation=await readReplyTranslation(this.env.DB!,scope,actor,access.memberId,command.previewRequestId,hash)??undefined;
        if((await this.access(scope,actor))?.memberId!==access.memberId)return {outcome:'not_found'};
      }
    }
    const result=await this.ctx.storage.transaction(async transaction=>{
      const state=await this.state(transaction,directory);
      const receipt=await transaction.get<ControlReceipt>(`receipt:${command.commandId}`);
      if(receipt) {
        const applied=normalizeControlState(receipt.appliedState);
        if(receipt.action==='set_work_status'&&(receipt.appliedState.schemaVersion!==2||applied.lifecycle!=='open'||applied.workStatus!==receipt.workStatus))throw new Error('INVALID_CONTROL_RECEIPT');
        if(receipt.action==='transfer'&&(receipt.appliedState.schemaVersion!==2||applied.lifecycle!=='open'||applied.reception!=='human'||applied.assignedMemberId!==receipt.targetMemberId))throw new Error('INVALID_CONTROL_RECEIPT');
        if(receipt.action==='add_note')noteFromReceipt(receipt,command.commandId,applied.sequence);
        if(receipt.action==='send_reply'&&(!await this.storedReply(transaction,command.commandId)||receipt.intentId!==command.commandId))throw new Error('INVALID_CONTROL_RECEIPT');
        if(receipt.action==='cancel_reply'&&((await this.storedReply(transaction,receipt.targetIntentId))?.intent.state!=='canceled'||receipt.appliedState.schemaVersion!==2||applied.version!==receipt.expectedVersion+1))throw new Error('INVALID_CONTROL_RECEIPT');
        return receipt.actorUserId===actor.actorUserId&&receipt.actorMemberId===access.memberId&&receipt.action===command.action&&receipt.expectedVersion===command.expectedVersion
          &&(command.action!=='set_work_status'||(receipt.action==='set_work_status'&&receipt.workStatus===command.workStatus))
          &&(command.action!=='transfer'||(receipt.action==='transfer'&&receipt.targetMemberId===command.targetMemberId&&receipt.reason===command.reason))
          &&(command.action!=='add_note'||(receipt.action==='add_note'&&receipt.body===command.body))
          &&(command.action!=='send_reply'||(receipt.action==='send_reply'&&receipt.body===command.body&&receipt.previewRequestId===command.previewRequestId))
          &&(command.action!=='cancel_reply'||(receipt.action==='cancel_reply'&&receipt.targetIntentId===command.targetIntentId))
          ?{outcome:'accepted' as const,receipt}:{outcome:'conflict' as const,reason:'command' as const};
      }
      if(command.commandId.startsWith('ai-reply:')||command.commandId.startsWith('ai-start:')||command.commandId.startsWith('ai-resume:')||command.commandId.startsWith('ai-handoff:')||command.commandId.startsWith('ai-listen:')||command.commandId.startsWith('inbound:')||command.commandId.startsWith('ai-intake:')||command.commandId.startsWith('ai-classification:')||command.commandId.startsWith('ai-dispatch-stop:'))return {outcome:'conflict' as const,reason:'command' as const};
      if(command.action==='send_reply') {
        const code=this.replyGate(context,state);if(code)return {outcome:'rejected' as const,code};
        if(command.previewRequestId&&!translation)return {outcome:'rejected' as const,code:'PREVIEW_UNAVAILABLE' as const};
      }
      let cancellation:ReplySnapshot|null=null;
      if(command.action==='cancel_reply'){
        cancellation=await this.storedReply(transaction,command.targetIntentId);
        if(!cancellation)return {outcome:'not_found' as const};
        if(cancellation.intent.state!=='queued')return {outcome:'rejected' as const,code:'REPLY_NOT_CANCELABLE' as const};
        if(cancellation.intent.revision===Number.MAX_SAFE_INTEGER)throw new Error('REPLY_VERSION_EXHAUSTED');
      }
      if(command.expectedVersion!==state.version)return {outcome:'conflict' as const,reason:'version' as const};
      if((!['add_note','cancel_reply'].includes(command.action)&&state.lifecycle!==(command.action==='reopen'?'resolved':'open'))||(command.action==='claim'&&state.assignedMemberId!==null)||(command.action==='takeover'&&state.reception==='human')
        ||(command.action==='set_work_status'&&state.workStatus===command.workStatus)||(command.action==='transfer'&&state.assignedMemberId===command.targetMemberId))
        return {outcome:'conflict' as const,reason:'state' as const};
      if(command.action==='transfer'&&!access.targetEligible)return {outcome:'conflict' as const,reason:'target' as const};
      if([state.version,state.sequence,...(['add_note','send_reply','cancel_reply'].includes(command.action)?[]:[state.controlEpoch])].some(value=>value===Number.MAX_SAFE_INTEGER))throw new Error('CONTROL_VERSION_EXHAUSTED');
      const fields={...state,version:state.version+1,controlEpoch:state.controlEpoch+(['add_note','send_reply','cancel_reply'].includes(command.action)?0:1),sequence:state.sequence+1,updatedAt:Math.max(Date.now(),state.updatedAt),
        reception:command.action==='claim'||command.action==='takeover'||command.action==='transfer'?'human' as const:state.reception==='ai'&&!['add_note','send_reply','cancel_reply'].includes(command.action)?'paused' as const:state.reception,
        assignedMemberId:command.action==='transfer'?command.targetMemberId:command.action==='claim'?access.memberId:state.assignedMemberId};
      const appliedState:ControlState=command.action==='add_note'||command.action==='send_reply'||command.action==='cancel_reply'?{...state,version:fields.version,sequence:fields.sequence,updatedAt:fields.updatedAt}:command.action==='resolve'?{...fields,lifecycle:'resolved',workStatus:null}:
        {...fields,lifecycle:'open',workStatus:command.action==='set_work_status'?command.workStatus:command.action==='reopen'?'needs_reply':state.workStatus??'needs_reply'};
      const metadata={actorUserId:actor.actorUserId,actorMemberId:access.memberId,appliedState};
      const applied:ControlReceipt=command.action==='add_note'?{...command,...metadata,authorName:access.memberName}:command.action==='send_reply'?{...command,...metadata,intentId:command.commandId,...(translation?{translation}:{})}:{...command,...metadata};
      if(appliedState.controlEpoch!==state.controlEpoch){await transaction.delete('aiDeadline');await transaction.delete('aiListening');await transaction.delete('aiPendingInput');await transaction.delete('aiClassification');}
      if(applied.action==='add_note')noteFromReceipt(applied,applied.commandId,appliedState.sequence);
      if(command.action==='send_reply')await this.putReply(transaction,{intent:{schemaVersion:1,id:command.commandId,commandId:command.commandId,
        actorUserId:actor.actorUserId,actorMemberId:access.memberId,body:command.body,bodyHash:hash,platformThreadId:context!.platformThreadId,
        credentialVersion:context!.store.credentialVersion,controlEpoch:state.controlEpoch,state:'queued',revision:1,createdAt:fields.updatedAt,updatedAt:fields.updatedAt,dueAt:fields.updatedAt+1_000,lastError:null},attempt:null});
      if(cancellation)await this.putReply(transaction,{intent:{...cancellation.intent,state:'canceled',revision:cancellation.intent.revision+1,updatedAt:Math.max(fields.updatedAt,cancellation.intent.updatedAt),dueAt:null,lastError:null},attempt:null},cancellation);
      await this.persistCommand(transaction,{scope,receipt:applied});
      return {outcome:'accepted' as const,receipt:applied};
    });
    if(result.outcome==='accepted')await this.flush(scope);
    if(result.outcome==='not_found')return result;
    return {...result,view:await this.view(directory,access.memberId)};
  }
  protected async persistCommand(transaction:DurableObjectTransaction,event:ControlEvent) {
    const {receipt}=event;
    await transaction.put('state',receipt.appliedState);
    await transaction.put(`receipt:${receipt.commandId}`,receipt);
    await transaction.put(`${eventPrefix}${String(receipt.appliedState.sequence).padStart(16,'0')}`,event);
    if(receipt.action==='add_note')await transaction.put(noteKey(receipt.appliedState.sequence),receipt.commandId);
    if(receipt.action==='send_reply'||receipt.action==='ai_send_reply'||await transaction.get('replyHistory')!==undefined) {
      const history=await this.history(transaction,receipt.appliedState.sequence-1);
      history.observedSequence=receipt.appliedState.sequence;
      if(receipt.action==='send_reply'||receipt.action==='ai_send_reply')this.addHistory(history,receipt.intentId,receipt.appliedState.sequence);
      await transaction.put('replyHistory',history);
    }
    await transaction.put('projectionDue',Date.now()+1_000);
    await this.schedule(transaction);
  }
  protected async project(scope:ControlScope,events:ControlEvent[]) {
    if(!this.env.DB)throw new Error('CONTROL_DATABASE_UNAVAILABLE');
    await projectControlEvents(this.env.DB,scope,events,Date.now());
  }
  protected async projectReplies(scope:ControlScope,snapshots:ReplySnapshot[]) {
    await projectReplyEvents(this.env.DB!,scope,snapshots,Date.now());
  }
  private async schedule(transaction:DurableObjectTransaction) {
    const projection=await transaction.get<number>('projectionDue');
    const due=await transaction.list<string>({prefix:replyDuePrefix,limit:1});
    const earliest=due.size?Number([...due.keys()][0]!.slice(replyDuePrefix.length,replyDuePrefix.length+16)):undefined;
    const feedback=await transaction.get<{until:number;dueAt:number}>('replyRateLimit');
    const aiDeadline=await transaction.get<number>('aiDeadline');
    const wake=await transaction.get('aiReplyWake');
    const times=[projection,earliest,feedback?.dueAt,aiDeadline,wake===undefined?undefined:v.parse(aiReplyWakeSchema,wake).dueAt].filter((value):value is number=>value!==undefined);
    if(times.length)await transaction.setAlarm(Math.max(Date.now()+1,Math.min(...times)));else await transaction.deleteAlarm();
  }
  protected async acknowledge(keys:string[]) {
    await this.ctx.storage.transaction(async transaction=>{
      // Delete only the confirmed keys: later events may arrive during D1 I/O.
      await transaction.delete(keys);
      if((await transaction.list({prefix:eventPrefix,limit:1})).size||(await transaction.list({prefix:replyEventPrefix,limit:1})).size)await transaction.put('projectionDue',Date.now()+1);
      else await transaction.delete('projectionDue');
      await this.schedule(transaction);
    });
  }
  private async retry() {
    await this.ctx.storage.transaction(async transaction=>{
      const failures=Math.min(7,(await transaction.get<number>('projectionFailures')??0)+1);
      await transaction.put('projectionFailures',failures);
      await transaction.put('projectionDue',Date.now()+Math.min(60_000,1_000*2**(failures-1)));
      await this.schedule(transaction);
    });
  }
  private async flush(scope:ControlScope) {
    let failed=false;
    try {
      const batch=await this.ctx.storage.list<ControlEvent>({prefix:eventPrefix,limit:20});
      if(batch.size){await this.project(scope,[...batch.values()]);await this.acknowledge([...batch.keys()]);}
    } catch {failed=true;}
    try {
      const replies=await this.ctx.storage.list<ReplySnapshot>({prefix:replyEventPrefix,limit:20});
      if(replies.size){await this.projectReplies(scope,[...replies.values()]);await this.acknowledge([...replies.keys()]);}
    } catch {failed=true;}
    if(failed)await this.retry();
    else {try {await this.acknowledge([]);await this.ctx.storage.delete('projectionFailures');} catch {await this.retry();}}
    try {await deferControlRepair(this.env.DB!,scope,Math.min(Date.now()+300_000,await this.ctx.storage.getAlarm()??Infinity));} catch { /* The due directory remains a recovery path. */ }
  }
  private replyGate(context:ReplyDispatchContext|null,state:ControlState):ReplyRejectCode|null {
    if(this.env.OUTBOUND_ENABLED!=='true'||context&&!context.outboundEnabled)return 'OUTBOUND_DISABLED';
    if(!context||state.lifecycle!=='open'||state.reception!=='human'||['paused','disconnected'].includes(context.store.status)||context.platformType!=='BUYER_SELLER')return 'REPLY_UNAVAILABLE';
    if(!context.replyAvailable)return 'CAPABILITY_UNVERIFIED';
    return null;
  }
  private async storedReply(transaction:DurableObjectTransaction,id:string):Promise<ReplySnapshot|null> {
    const value=await transaction.get<ReplySnapshot>(`${replyPrefix}${id}`);if(!value)return null;
    const snapshot=checkedReply(value),receipt=await transaction.get<ControlReceipt|AiSendReceipt>(`receipt:${id}`);
    if(snapshot.intent.schemaVersion===2){
      const applied=checkedAiSendReceipt(receipt);
      if(snapshot.intent.id!==id||applied.intentId!==id||applied.runId!==snapshot.intent.runId||applied.body!==snapshot.intent.body
        ||applied.appliedState.controlEpoch!==snapshot.intent.controlEpoch)throw new Error('INVALID_REPLY_STATE');return snapshot;
    }
    if(snapshot.intent.id!==id||!receipt||receipt.action!=='send_reply'||receipt.intentId!==id||receipt.body!==snapshot.intent.body
      ||receipt.actorUserId!==snapshot.intent.actorUserId||receipt.actorMemberId!==snapshot.intent.actorMemberId
      ||receipt.appliedState.schemaVersion!==2||receipt.appliedState.lifecycle!=='open'||receipt.appliedState.reception!=='human'
      ||receipt.appliedState.controlEpoch!==snapshot.intent.controlEpoch||receipt.appliedState.version!==receipt.expectedVersion+1)throw new Error('INVALID_REPLY_STATE');
    checkedReplyTranslation(receipt.translation,receipt.previewRequestId,snapshot.intent.bodyHash);
    return snapshot;
  }
  private async putReply(transaction:DurableObjectTransaction,snapshot:ReplySnapshot,previous?:ReplySnapshot) {
    checkedReply(snapshot);
    if(previous&&previous.intent.dueAt!==null)await transaction.delete(dueKey(previous));
    await transaction.put(`${replyPrefix}${snapshot.intent.id}`,snapshot);
    await transaction.put(`${replyEventPrefix}${snapshot.intent.id}:${String(snapshot.intent.revision).padStart(16,'0')}`,snapshot);
    if(snapshot.intent.dueAt!==null)await transaction.put(dueKey(snapshot),snapshot.intent.id);
    await transaction.put('projectionDue',Date.now()+1_000);
    await this.schedule(transaction);
  }
  private async changeReply(id:string,revision:number,change:(snapshot:ReplySnapshot)=>ReplySnapshot) {
    return this.ctx.storage.transaction(async transaction=>{
      const current=await this.storedReply(transaction,id);if(!current||current.intent.revision!==revision)return false;
      const next=change(current);next.intent={...next.intent,revision:revision+1,updatedAt:Math.max(Date.now(),current.intent.updatedAt)};
      await this.putReply(transaction,next,current);return true;
    });
  }
  private async skipReply(snapshot:ReplySnapshot,reason:string) {
    await this.changeReply(snapshot.intent.id,snapshot.intent.revision,current=>({...current,intent:{...current.intent,state:'skipped',dueAt:null,lastError:reason}}));
  }
  protected async publishRateLimit(scope:ControlScope,until:number) {
    await recordReplyRateLimit(this.env,{orgId:scope.organizationId,storeId:scope.storeId},until);
  }
  private async flushRateLimit(scope:ControlScope) {
    const pending=await this.ctx.storage.get<{until:number;dueAt:number}>('replyRateLimit');
    if(!pending||pending.dueAt>Date.now())return;
    try {
      await this.publishRateLimit(scope,pending.until);
      await this.ctx.storage.transaction(async transaction=>{
        const current=await transaction.get<{until:number}>('replyRateLimit');
        if(current?.until===pending.until)await transaction.delete('replyRateLimit');
        await this.schedule(transaction);
      });
    } catch {
      await this.ctx.storage.transaction(async transaction=>{
        const current=await transaction.get<{until:number;dueAt:number}>('replyRateLimit');
        if(current)await transaction.put('replyRateLimit',{...current,dueAt:Date.now()+60_000});
        await this.schedule(transaction);
      });
    }
  }
  private async settleReply(scope:ControlScope,id:string,revision:number,result:OzonSendResult) {
    const code=result.errorCode?.toUpperCase()??null;
    await this.ctx.storage.transaction(async transaction=>{
      const current=await this.storedReply(transaction,id);if(!current||current.intent.revision!==revision)return;
      const now=Math.max(Date.now(),current.intent.updatedAt);
      if(result.httpStatus===429) {
        const previous=await transaction.get<{until:number}>('replyRateLimit');
        await transaction.put('replyRateLimit',{until:Math.max(previous?.until??0,Math.min(8_640_000_000_000_000,now+(result.retryAfterMs??60_000))),dueAt:now});
      }
      await this.putReply(transaction,{intent:{...current.intent,state:result.outcome,revision:revision+1,updatedAt:now,dueAt:null,lastError:code},
        attempt:{...current.attempt!,state:result.outcome,finishedAt:now,httpStatus:result.httpStatus,providerResult:result.providerResult,errorCode:code}},current);
      if(result.outcome==='sent'&&current.intent.schemaVersion===2){
        const run=await transaction.get<AiWork>('aiRun'),state=normalizeControlState(await transaction.get('state'));
        if(run?.request.runId===current.intent.runId&&state.reception==='ai'&&state.controlEpoch===current.intent.controlEpoch){
          await transaction.delete('aiDeadline');const wake=await transaction.get<{runId:string}>('aiReplyWake');
          if(wake?.runId===current.intent.runId)await transaction.delete('aiReplyWake');await this.schedule(transaction);
        }
      }
    });
    await this.flushRateLimit(scope);
    await this.flush(scope);
  }
  protected sendReply(credentials:{clientId:string;apiKey:string},input:{chatId:string;body:string}) {
    return sendOzonMessage(credentials,input);
  }
  private async replyContext(scope:ControlScope,intent:ReplyIntent) {
    if(intent.schemaVersion===1)return readReplyDispatchContext(this.env.DB!,scope,intent.actorUserId,intent.actorMemberId);
    const context=await readAiReplyDispatchContext(this.env.DB!,scope);
    const frozen=await reviewCompletedAiReply(this.env,(s,id)=>this.readAiRun(s,id),scope,intent.runId);
    if(!frozen||frozen.id!==intent.id||frozen.body!==intent.body||frozen.platformThreadId!==intent.platformThreadId||frozen.credentialVersion!==intent.credentialVersion
      ||frozen.run.controlEpoch!==intent.controlEpoch)return null;
    return context?.store.platformStoreId===frozen.platformStoreId&&context.platformThreadId===frozen.platformThreadId&&context.store.credentialVersion===frozen.credentialVersion?context:null;
  }
  private replyControlGate(context:ReplyDispatchContext,state:ControlState,intent:ReplyIntent) {
    if(state.controlEpoch!==intent.controlEpoch)return 'CONTROL_CHANGED';
    if(intent.schemaVersion===1)return this.replyGate(context,state);
    if(this.env.OUTBOUND_ENABLED!=='true'||this.env.AI_OUTBOUND_ENABLED!=='true'||this.env.AI_RECEPTION_ENABLED!=='true')return 'OUTBOUND_DISABLED';
    if(state.lifecycle!=='open'||state.reception!=='ai'||state.workStatus!=='needs_reply'||state.assignedMemberId!==null)return 'CONTROL_CHANGED';
    if(!context.outboundEnabled||!context.replyAvailable||context.store.platform!=='ozon'||context.platformType!=='BUYER_SELLER')return 'CAPABILITY_UNVERIFIED';
    return null;
  }
  private async deferReply(snapshot:ReplySnapshot,dueAt:number) {
    if(snapshot.intent.schemaVersion===2){
      const run=await this.ctx.storage.get<AiRun>('aiRun');
      if(run?.request.runId!==snapshot.intent.runId||Date.now()>=run.deadlineAt){await this.skipReply(snapshot,'AI_AUTHORITY_REVOKED');return;}
      dueAt=Math.min(dueAt,run.deadlineAt);
    }
    await this.changeReply(snapshot.intent.id,snapshot.intent.revision,current=>({...current,intent:{...current.intent,dueAt}}));
  }
  private async dispatchReply(scope:ControlScope) {
    const snapshot=await this.ctx.storage.transaction(async transaction=>{
      const due=await transaction.list<string>({prefix:replyDuePrefix,limit:1});if(!due.size)return null;
      const snapshot=await this.storedReply(transaction,[...due.values()][0]!);if(!snapshot)throw new Error('INVALID_REPLY_STATE');
      if([...due.keys()][0]!==dueKey(snapshot))throw new Error('INVALID_REPLY_STATE');
      return snapshot.intent.schemaVersion===2||snapshot.intent.dueAt!<=Date.now()?snapshot:null;
    });
    if(!snapshot)return;
    const {intent}=snapshot;
    if(intent.state==='sending') {
      if(intent.dueAt!>Date.now())return;
      await this.settleReply(scope,intent.id,intent.revision,{outcome:'unknown',httpStatus:null,providerResult:null,errorCode:'sending_deadline_expired'});return;
    }
    if(intent.state!=='queued')throw new Error('INVALID_REPLY_STATE');
    let context:ReplyDispatchContext|null;
    try {context=await this.replyContext(scope,intent);} catch {
      await this.deferReply(snapshot,Date.now()+60_000);return;
    }
    if(!context){await this.skipReply(snapshot,intent.schemaVersion===2?'AI_AUTHORITY_REVOKED':'ACCESS_REVOKED');return;}
    if(context.store.credentialVersion!==intent.credentialVersion){await this.skipReply(snapshot,'CREDENTIAL_CHANGED');return;}
    if(context.platformThreadId!==intent.platformThreadId){await this.skipReply(snapshot,'THREAD_CHANGED');return;}
    const localState=normalizeControlState(await this.ctx.storage.get('state'));
    const blocked=this.replyControlGate(context,localState,intent);
    if(blocked){await this.skipReply(snapshot,blocked);return;}
    if(intent.dueAt!>Date.now())return;
    const pendingRate=await this.ctx.storage.get<{until:number}>('replyRateLimit');
    if(pendingRate){await this.deferReply(snapshot,Math.max(Date.now()+60_000,pendingRate.until));return;}
    let credentials:{apiKey:string};
    try {
      if(!context.store.credentialKeyVersion||!context.store.credentialNonce||!context.store.credentialCiphertext)throw new Error('missing credentials');
      credentials=await decryptCredentials(this.env,{orgId:scope.organizationId,storeId:scope.storeId,platformStoreId:context.store.platformStoreId,credentialVersion:intent.credentialVersion},
        {keyVersion:context.store.credentialKeyVersion,nonce:context.store.credentialNonce,ciphertext:context.store.credentialCiphertext});
    } catch {await this.skipReply(snapshot,'CREDENTIALS_UNAVAILABLE');return;}
    let permit:number;
    try {permit=await reserveReply(this.env,{orgId:scope.organizationId,storeId:scope.storeId});} catch {
      await this.deferReply(snapshot,Date.now()+60_000);return;
    }
    if(permit>Date.now()) {await this.deferReply(snapshot,permit);return;}
    if(await bodyHash(intent.body)!==intent.bodyHash)throw new Error('INVALID_REPLY_STATE');
    // Re-read current company authorization after all asynchronous preparation.
    context=await this.replyContext(scope,intent);
    if(!context){await this.skipReply(snapshot,intent.schemaVersion===2?'AI_AUTHORITY_REVOKED':'ACCESS_REVOKED');return;}
    if(context.store.credentialVersion!==intent.credentialVersion){await this.skipReply(snapshot,'CREDENTIAL_CHANGED');return;}
    if(context.platformThreadId!==intent.platformThreadId){await this.skipReply(snapshot,'THREAD_CHANGED');return;}
    const currentContext=context;
    await this.ctx.blockConcurrencyWhile(async()=>{
      const started=await this.ctx.storage.transaction(async transaction=>{
        const current=await this.storedReply(transaction,intent.id);if(!current||current.intent.revision!==intent.revision)return null;
        const state=normalizeControlState(await transaction.get('state'));
        const run=intent.schemaVersion===2?await transaction.get<AiRun>('aiRun'):null;
        const reason=intent.schemaVersion===2&&(run?.request.runId!==intent.runId||Date.now()>=run.deadlineAt)?'AI_AUTHORITY_REVOKED':this.replyControlGate(currentContext,state,intent);
        const now=Date.now();
        if(reason){await this.putReply(transaction,{...current,intent:{...current.intent,state:'skipped',revision:intent.revision+1,updatedAt:now,dueAt:null,lastError:reason}},current);return null;}
        const sending:ReplySnapshot={intent:{...current.intent,state:'sending',revision:intent.revision+1,updatedAt:now,dueAt:now+10_000},
          attempt:{id:`${intent.id}:1`,intentId:intent.id,state:'sending',startedAt:now,deadlineAt:now+10_000,finishedAt:null,httpStatus:null,providerResult:null,errorCode:null}};
        await this.putReply(transaction,sending,current);return sending;
      });
      if(!started)return;
      // Start I/O inside the short guard; do not await its network promise here.
      const pending=this.sendReply({clientId:currentContext.store.platformStoreId,apiKey:credentials.apiKey},{chatId:intent.platformThreadId,body:intent.body});
      this.ctx.waitUntil(pending.then(result=>this.settleReply(scope,intent.id,started.intent.revision,result)).catch(async()=>{
        await this.settleReply(scope,intent.id,started.intent.revision,{outcome:'unknown',httpStatus:null,providerResult:null,errorCode:'settlement_unconfirmed'});
      }));
    });
  }
  async repair(scope:ControlScope):Promise<void> {
    if(!this.env.DB||!this.routed(scope))return;
    const directory=await readControlDirectory(this.env.DB,scope);if(!directory)return;
    await this.ctx.storage.transaction(transaction=>this.state(transaction,directory));
    try {await this.expireAi(directory);await this.pollAiReply(scope);await this.flushRateLimit(scope);await this.dispatchReply(scope);} finally {await this.flush(scope);}
  }
  async alarm() {
    const scope=await this.ctx.storage.get<ControlScope>('scope');
    if(scope)await this.repair(scope);
  }
}
