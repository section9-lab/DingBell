import type {Context,Hono} from 'hono';
import * as v from 'valibot';
import {apiError,jsonResponse,type ApplicationEnv} from '../../http.ts';
import {configured,limitedBody,signedIn} from '../identity/http.ts';
import {aiReceptionCommandSchema,aiReceptionSchema} from '../../shared/ai-reception.ts';
import {supportConfigurationView} from '../ai-runs/configuration.ts';
import {selectAiBudget} from '../ai-runs/budget.ts';
import {getConversationController} from './control-bindings.ts';
import {ensureControlDirectory,readControlAccess} from './control-storage.ts';
import type {ConversationController} from './controller.ts';
import type {ControlActor,ControlScope} from './control-types.ts';

const base='/api/companies/:companyId/conversations/:id';
const validId=(value:string|undefined):value is string=>!!value&&value.length<=256&&value===value.trim()&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=v.pipe(v.string(),v.uuid());
type Read=Extract<Awaited<ReturnType<ConversationController['readAiReception']>>,{outcome:'found'}>;
function dto(scope:ControlScope,read:Read){
 const boundary=(listening:NonNullable<Read['waiting']>)=>({commandId:listening.request.commandId,controlEpoch:listening.controlEpoch,afterSequence:listening.afterSequence,resumedAt:new Date(listening.createdAt).toISOString()});
 const {state,receipt}=read;
 return v.parse(aiReceptionSchema,{companyId:scope.organizationId,conversationId:scope.conversationId,viewerMemberId:read.viewerMemberId,projectionPending:read.projectionPending,
  control:{version:state.version,controlEpoch:state.controlEpoch,sequence:state.sequence,lifecycle:state.lifecycle,reception:state.reception,updatedAt:new Date(state.updatedAt).toISOString()},
  waiting:read.waiting?boundary(read.waiting):null,
  resumption:receipt?{...boundary(receipt.listening),expectedVersion:receipt.expectedVersion,appliedVersion:receipt.appliedState.version,actorMemberId:receipt.actorMemberId}:null});
}
export function registerAiReceptionRoutes(app:Hono<ApplicationEnv>){
 for(const [method,path,commandRead]of [['get',`${base}/ai-reception`,false],['get',`${base}/ai-resumptions/:commandId`,true],['post',`${base}/ai-resumptions`,false]] as const)
 app[method](path,configured,limitedBody,signedIn,async(c:Context<ApplicationEnv>)=>{
  const invalid=()=>apiError(c,'INVALID_REQUEST','Provide only a command ID, expected version and canonical membership header.',400);
  const missing=()=>apiError(c,'NOT_FOUND','The conversation or operation is not available to this member.',404);
  if(new URL(c.req.url).search||!validId(c.req.param('companyId'))||!validId(c.req.param('id')))return invalid();
  const raw=c.req.header('X-DingBell-Member-Id');let memberId:string;
  try{memberId=decodeURIComponent(raw??'');if(!validId(memberId)||encodeURIComponent(memberId)!==raw)return invalid();}catch{return invalid();}
  const parsed=method==='post'?v.safeParse(aiReceptionCommandSchema,await c.req.json().catch(()=>null)):null;if(parsed&&!parsed.success)return invalid();
  const commandId=commandRead?c.req.param('commandId'):parsed?.success?parsed.output.commandId:undefined;if(commandRead&&!v.is(uuid,commandId))return invalid();
  if(!c.env.CONVERSATION_CONTROLLER)return apiError(c,'CONTROL_NOT_CONFIGURED','Conversation control requires a controller binding.',503);
  const identity=c.get('identitySession'),actor:ControlActor={orgId:c.req.param('companyId')!,actorUserId:identity.user.id,sessionId:identity.session.id,expectedMemberId:memberId},conversationId=c.req.param('id')!;
  try{
   const access=await readControlAccess(c.env.DB!,actor,conversationId);if(!access||access.memberId!==memberId)return missing();
   const directory=access.directory??(method==='post'?await ensureControlDirectory(c.env.DB!,actor,conversationId,Date.now()):null);
   if(!directory){
    if(method==='post')return missing();
    if(commandRead)return apiError(c,'RESUMPTION_NOT_FOUND','No receipt is currently available for this command. Keep its original ID when checking again.',404);
    return jsonResponse(c,v.parse(aiReceptionSchema,{companyId:actor.orgId,conversationId,viewerMemberId:memberId,projectionPending:false,
     control:{version:0,controlEpoch:0,sequence:0,lifecycle:'open',reception:'paused',updatedAt:new Date(0).toISOString()},waiting:null,resumption:null}));
   }
   const scope=directory.scope,controller=getConversationController(c.env,scope.controllerId);
   let read=await controller.readAiReception(scope,actor,commandId);if(read.outcome!=='found')return missing();
   if(method==='post'&&parsed?.success){
    if(read.receipt&&read.receipt.expectedVersion!==parsed.output.expectedVersion)return apiError(c,'COMMAND_CONFLICT','Keep the original command and expected version when recovering its result.',409);
    if(!read.receipt){
     const config=supportConfigurationView(c.env);
     if(!config.enabled)return apiError(c,'AI_DISABLED','Automatic reception is disabled for this deployment.',403);
     if(!config.modelConfigured||!config.pricesConfigured||config.runReservationMicros===null)return apiError(c,'AI_NOT_CONFIGURED','A reviewed model, pricing configuration and runtime are required.',503);
     if(!await selectAiBudget(c.env.DB!,scope,config.runReservationMicros))return apiError(c,'AI_BUDGET_UNAVAILABLE','An enabled production budget with sufficient full-run allowance is required.',412);
     const result=await controller.resumeAiReception(scope,actor,parsed.output);
     if(result.outcome==='not_found')return missing();
     if(result.outcome==='conflict')return apiError(c,'CONVERSATION_CHANGED','Refresh the conversation before choosing another operation.',409);
     if(result.outcome==='unavailable')return apiError(c,'AI_RECEPTION_UNAVAILABLE','Check published policies and channel availability, and wait for any prior execution to close.',412);
     read=await controller.readAiReception(scope,actor,commandId);if(read.outcome!=='found')return missing();
     if(!read.receipt)throw new Error('RESUMPTION_UNCONFIRMED');
    }
   }
   if((await readControlAccess(c.env.DB!,actor,conversationId))?.memberId!==memberId)return missing();
   if(commandRead&&!read.receipt)return apiError(c,'RESUMPTION_NOT_FOUND','No receipt is currently available for this command. Keep its original ID when checking again.',404);
   return jsonResponse(c,dto(scope,read));
  }catch{return apiError(c,method==='post'?'OPERATION_UNCONFIRMED':'CONTROL_UNAVAILABLE',method==='post'?'The operation may have completed. Read its original command result before continuing.':'The reception state is temporarily unavailable.',503);}
 });
}
