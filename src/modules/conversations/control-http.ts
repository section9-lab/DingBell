import type { Context, Hono } from 'hono';
import * as v from 'valibot';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { configured, limitedBody, signedIn } from '../identity/http.ts';
import { getConversationController } from './control-bindings.ts';
import { ensureControlDirectory, listControlTransferTargets, readControlAccess, readControlAssignee } from './control-storage.ts';
import { controlCommandSchema } from './control-state.ts';
import { reconcileConversationAi } from '../ai-runs/execution.ts';
import type { ReplyView } from './reply-types.ts';
import type { ControlActor, ControlAssignee, ControlScope, StoredControlState, ControlView } from './control-types.ts';

const path = '/api/companies/:companyId/conversations/:id';
const commandSchema = v.pipe(controlCommandSchema, v.check(command => v.is(v.pipe(v.string(), v.uuid()), command.commandId)));
const replyIdSchema=v.pipe(v.string(),v.check(value=>v.is(v.pipe(v.string(),v.uuid()),value.startsWith('ai-reply:')?value.slice(9):value)));
function actorFor(c: Context<ApplicationEnv>): ControlActor {
  const identity = c.get('identitySession');
  return { orgId: c.req.param('companyId')!, actorUserId: identity.user.id, sessionId: identity.session.id };
}
function replyMemberHeader(c: Context<ApplicationEnv>): string | null {
  const raw = c.req.header('X-DingBell-Member-Id');
  if (!raw) return null;
  try {
    const value = decodeURIComponent(raw);
    return value.length > 0 && value.length <= 256 && value === value.trim() && value.isWellFormed()
      && !/[\u0000-\u001f\u007f]/.test(value) && encodeURIComponent(value) === raw ? value : null;
  } catch { return null; }
}
function validPath(c: Context<ApplicationEnv>, allowQuery = false) {
  return (allowQuery || !new URL(c.req.url).search) && ['companyId', 'id'].every(key => {
    const id = c.req.param(key);
    return id && id.trim() && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
  });
}
const invalid = (c: Context<ApplicationEnv>) => apiError(c, 'INVALID_REQUEST', 'Provide only the required conversation command fields.', 400);
const notFound = (c: Context<ApplicationEnv>) => apiError(c, 'NOT_FOUND', 'The company, store or conversation is not available.', 404);
const notConfigured = (c: Context<ApplicationEnv>) => apiError(c, 'CONTROL_NOT_CONFIGURED', 'Conversation control requires a controller binding.', 503);
const stateDTO = (state: StoredControlState) => ({ ...state, updatedAt: new Date(state.updatedAt).toISOString() });
const viewDTO = (view: ControlView, assignee: ControlAssignee | null) => ({ ...view, state: stateDTO(view.state), assignee });
function replyDTO(reply:ReplyView) {
  const attempt=reply.attempt;
  return {intentId:reply.intentId,commandId:reply.commandId,body:reply.body,...(reply.previewRequestId?{previewRequestId:reply.previewRequestId}:{}),status:reply.status,revision:reply.revision,
    createdAt:new Date(reply.createdAt).toISOString(),updatedAt:new Date(reply.updatedAt).toISOString(),reason:reply.reason,
    attempt:attempt===null?null:{id:attempt.id,status:attempt.status,startedAt:new Date(attempt.startedAt).toISOString(),
      finishedAt:attempt.finishedAt===null?null:new Date(attempt.finishedAt).toISOString(),httpStatus:attempt.httpStatus,providerResult:attempt.providerResult,errorCode:attempt.errorCode}};
}
const cursorId = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const noteCursorSchema = v.strictObject({ v: v.literal(1), kind: v.literal('notes'), orgId: cursorId, storeId: cursorId,
  conversationId: cursorId, controllerId: cursorId, beforeSequence: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)) });
function encodeNoteCursor(scope: ControlScope, beforeSequence: number) {
  const bytes = new TextEncoder().encode(JSON.stringify({ v: 1, kind: 'notes', orgId: scope.organizationId, storeId: scope.storeId,
    conversationId: scope.conversationId, controllerId: scope.controllerId, beforeSequence }));
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function decodeNoteCursor(value: string) {
  if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    if (btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) return null;
    const parsed = v.safeParse(noteCursorSchema, JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(decoded, char => char.charCodeAt(0)))));
    return parsed.success ? parsed.output : null;
  } catch { return null; }
}

export function registerConversationControlRoutes(app: Hono<ApplicationEnv>) {
  app.get(`${path}/replies`, configured, signedIn, async c => {
    if(!validPath(c))return invalid(c);
    if(!c.env.CONVERSATION_CONTROLLER)return notConfigured(c);
    const actor=actorFor(c),conversationId=c.req.param('id')!;
    try {
      const access=await readControlAccess(c.env.DB!,actor,conversationId);if(!access)return notFound(c);
      if(!access.directory)return jsonResponse(c,{companyId:actor.orgId,conversationId,viewerMemberId:access.memberId,controlVersion:0,historyReady:true,
        readiness:{allowed:false,code:'REPLY_UNAVAILABLE'},replies:[]});
      const scope=access.directory.scope,result=await getConversationController(c.env,scope.controllerId).readReplies(scope,actor);
      if(result.outcome==='not_found')return notFound(c);
      return jsonResponse(c,{companyId:actor.orgId,conversationId,viewerMemberId:result.viewerMemberId,controlVersion:result.controlVersion,
        historyReady:result.historyReady,readiness:{allowed:result.readiness.allowed,code:result.readiness.code},replies:result.replies.map(replyDTO)});
    }catch{return apiError(c,'CONTROL_UNAVAILABLE','The recent reply results are temporarily unavailable.',503);}
  });
  app.get(`${path}/replies/:intentId`, configured, signedIn, async c => {
    const intentId = c.req.param('intentId')!;
    if (!validPath(c) || !v.is(replyIdSchema, intentId)) return invalid(c);
    if (!c.env.CONVERSATION_CONTROLLER) return notConfigured(c);
    const actor = actorFor(c), conversationId = c.req.param('id')!;
    try {
      const access = await readControlAccess(c.env.DB!, actor, conversationId);
      if (!access?.directory) return notFound(c);
      const scope = access.directory.scope;
      const result = await getConversationController(c.env, scope.controllerId).readReply(scope, actor, intentId);
      if (result.outcome === 'not_found') return notFound(c);
      return jsonResponse(c, { companyId: actor.orgId, conversationId, reply: replyDTO(result.reply) });
    } catch { return apiError(c, 'CONTROL_UNAVAILABLE', 'The reply result is temporarily unavailable.', 503); }
  });
  app.get(`${path}/notes`, configured, signedIn, async c => {
    const query = new URL(c.req.url).searchParams, value = query.get('limit') ?? '20';
    if (!validPath(c, true) || [...query.keys()].some(key => !['limit', 'cursor'].includes(key))
      || query.getAll('limit').length > 1 || query.getAll('cursor').length > 1 || !/^[1-9][0-9]?$/.test(value) || Number(value) > 50) return invalid(c);
    const cursor = query.has('cursor') ? decodeNoteCursor(query.get('cursor')!) : null;
    if (query.has('cursor') && !cursor) return invalid(c);
    if (!c.env.CONVERSATION_CONTROLLER) return notConfigured(c);
    const actor = actorFor(c), conversationId = c.req.param('id')!;
    try {
      const access = await readControlAccess(c.env.DB!, actor, conversationId);
      if (!access) return notFound(c);
      if (!access.directory) return cursor ? invalid(c) : jsonResponse(c, { companyId: actor.orgId, conversationId, notes: [], nextCursor: null });
      const scope = access.directory.scope;
      if (cursor && (cursor.orgId !== scope.organizationId || cursor.storeId !== scope.storeId || cursor.conversationId !== scope.conversationId || cursor.controllerId !== scope.controllerId)) return invalid(c);
      const result = await getConversationController(c.env, scope.controllerId).readNotes(scope, actor, cursor?.beforeSequence ?? null, Number(value));
      if (result.outcome === 'not_found') return notFound(c);
      return jsonResponse(c, { companyId: actor.orgId, conversationId,
        notes: result.notes.map(note => ({ ...note, createdAt: new Date(note.createdAt).toISOString() })),
        nextCursor: result.nextBeforeSequence === null ? null : encodeNoteCursor(scope, result.nextBeforeSequence) });
    } catch { return apiError(c, 'CONTROL_UNAVAILABLE', 'The internal notes are temporarily unavailable.', 503); }
  });
  app.get(`${path}/transfer-targets`, configured, signedIn, async c => {
    const query = new URL(c.req.url).searchParams, value = query.get('offset') ?? '0';
    if (!validPath(c, true) || [...query.keys()].some(key => key !== 'offset') || query.getAll('offset').length > 1
      || !/^(0|[1-9][0-9]{0,4})$/.test(value) || Number(value) > 10000) return invalid(c);
    const actor = actorFor(c), conversationId = c.req.param('id')!;
    try {
      const page = await listControlTransferTargets(c.env.DB!, actor, conversationId, Number(value));
      return page ? jsonResponse(c, { companyId: actor.orgId, conversationId, ...page }) : notFound(c);
    } catch { return apiError(c, 'CONTROL_UNAVAILABLE', 'The eligible conversation members are temporarily unavailable.', 503); }
  });
  app.get(`${path}/control`, configured, signedIn, async c => {
    if (!validPath(c)) return invalid(c);
    if (!c.env.CONVERSATION_CONTROLLER) return notConfigured(c);
    const actor = actorFor(c), conversationId = c.req.param('id')!;
    try {
      const access = await readControlAccess(c.env.DB!, actor, conversationId);
      if (!access) return notFound(c);
      let view: ControlView;
      if (access.directory) {
        const result = await getConversationController(c.env, access.directory.scope.controllerId).read(access.directory.scope, actor);
        if (result.outcome === 'not_found') return notFound(c);
        view = result.view;
      } else {
        view = { state: { schemaVersion: 2, workStatus: 'needs_reply', version: 0, controlEpoch: 0, sequence: 0, lifecycle: 'open', reception: 'paused', assignedMemberId: null, updatedAt: 0 }, viewerMemberId: access.memberId, projectionPending: false };
      }
      const metadata = await readControlAssignee(c.env.DB!, actor, conversationId, view.state.assignedMemberId, view.viewerMemberId);
      if (!metadata) return notFound(c);
      return jsonResponse(c, { companyId: actor.orgId, conversationId, control: viewDTO(view, metadata.assignee) });
    } catch { return apiError(c, 'CONTROL_UNAVAILABLE', 'The current conversation state is temporarily unavailable.', 503); }
  });
  app.post(`${path}/commands`, configured, limitedBody, signedIn, async c => {
    if (!validPath(c)) return invalid(c);
    const parsed = v.safeParse(commandSchema, await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c);
    if (!c.env.CONVERSATION_CONTROLLER) return notConfigured(c);
    const actor = actorFor(c), conversationId = c.req.param('id')!;
    if (parsed.output.action === 'send_reply' || parsed.output.action === 'cancel_reply') {
      const memberId = replyMemberHeader(c);
      if (memberId === null) return invalid(c);
      actor.expectedMemberId = memberId;
    }
    try {
      if (parsed.output.action === 'send_reply' || parsed.output.action === 'cancel_reply') {
        const access = await readControlAccess(c.env.DB!, actor, conversationId);
        if (!access || access.memberId !== actor.expectedMemberId) return notFound(c);
      }
      const directory = await ensureControlDirectory(c.env.DB!, actor, conversationId, Date.now());
      if (!directory) return notFound(c);
      const result = await getConversationController(c.env, directory.scope.controllerId).execute(directory.scope, actor, parsed.output);
      if (result.outcome === 'not_found') return notFound(c);
      if (result.outcome === 'conflict') {
        if (result.reason === 'target') return apiError(c, 'TRANSFER_TARGET_UNAVAILABLE', 'The selected member can no longer receive this conversation. Choose another member.', 409);
        return apiError(c, result.reason === 'command' ? 'COMMAND_CONFLICT' : 'CONVERSATION_CHANGED', 'Refresh the conversation state before choosing another operation.', 409);
      }
      if (result.outcome === 'rejected') {
        if (result.code === 'REPLY_NOT_CANCELABLE') return apiError(c, result.code, 'This reply is no longer queued and cannot be canceled. Refresh its result.', 409);
        if (result.code === 'PREVIEW_UNAVAILABLE') return apiError(c, result.code, 'The original translation preview is unavailable for this member or conversation.', 412);
        if (result.code === 'OUTBOUND_DISABLED') return apiError(c, result.code, 'Outbound replies are disabled for this deployment or store.', 403);
        if (result.code === 'REPLY_UNAVAILABLE') return apiError(c, result.code, 'The conversation or store is not currently eligible for replies.', 412);
        return apiError(c, result.code, 'The store reply capability has not been verified.', 412);
      }
      if(c.env.FLUE_SUPPORT_AGENT)c.executionCtx.waitUntil(reconcileConversationAi(c.env,directory.scope));
      const metadata = await readControlAssignee(c.env.DB!, actor, conversationId, result.view.state.assignedMemberId, result.view.viewerMemberId);
      if (!metadata) return notFound(c);
      return jsonResponse(c, { companyId: actor.orgId, conversationId,
        receipt: { ...result.receipt, appliedState: stateDTO(result.receipt.appliedState) }, control: viewDTO(result.view, metadata.assignee) });
    } catch { return apiError(c, 'OPERATION_UNCONFIRMED', 'The command may have completed. Refresh the conversation state before continuing.', 503); }
  });
}
