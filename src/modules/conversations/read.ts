import * as v from 'valibot';
import { storeAccess, type StoreActor } from '../stores/storage.ts';
import type { ConversationDetail, ConversationListOptions, ConversationListResult, ConversationSummary, ConversationWorkflow, MessageListOptions, MessageListResult, MessagePreview, MessageUpdatesResult, MessageView } from './read-types.ts';

const identifier=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const timestamp=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(8_640_000_000_000_000));
const searchSchema=v.strictObject({field:v.picklist(['thread','order']),value:identifier});
const queueSchema=v.picklist(['all','mine','unassigned']);
const stateFilterSchema=v.picklist(['all','needs_reply','waiting_customer','waiting_internal','resolved']);
const listCursorSchema=v.strictObject({v:v.literal(2),kind:v.literal('list'),orgId:identifier,storeId:v.nullable(identifier),search:v.nullable(searchSchema),viewerMemberId:identifier,queue:queueSchema,state:stateFilterSchema,at:v.nullable(timestamp),id:identifier});
const sequence=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const messageCursorSchema=v.strictObject({v:v.literal(3),kind:v.literal('messages'),orgId:identifier,conversationId:identifier,viewerMemberId:identifier,
  snapshot:sequence,edge:v.nullable(v.strictObject({at:timestamp,id:identifier,direction:v.picklist(['older','newer']),inclusive:v.boolean()}))});
const updatesCursorSchema=v.strictObject({v:v.literal(1),kind:v.literal('message-updates'),orgId:identifier,conversationId:identifier,viewerMemberId:identifier,after:sequence,through:v.nullable(sequence)});
const workflowSchema=v.pipe(v.strictObject({version:v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER)),
  lifecycle:v.picklist(['open','resolved']),workStatus:v.nullable(v.picklist(['needs_reply','waiting_customer','waiting_internal'])),assignedMemberId:v.nullable(identifier),assigneeName:v.nullable(v.string())}),
  v.check(value=>(value.lifecycle==='resolved'?value.workStatus===null:value.workStatus!==null)&&(value.assignedMemberId!==null||value.assigneeName===null)));

export class InvalidConversationCursor extends Error {
  constructor(){super('INVALID_CONVERSATION_CURSOR');this.name='InvalidConversationCursor';}
}
function checkId(value:string){if(!v.is(identifier,value))throw new RangeError('INVALID_CONVERSATION_QUERY');}
function checkLimit(value:number){if(!Number.isSafeInteger(value)||value<1||value>100)throw new RangeError('INVALID_CONVERSATION_QUERY');}
function base64url(bytes:Uint8Array){return btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');}
function encodeCursor(value:unknown){return base64url(new TextEncoder().encode(JSON.stringify(value)));}
function decodeCursor(value:string):unknown {
  if(typeof value!=='string'||value.length>4096||!value||!/^[A-Za-z0-9_-]+$/.test(value))throw new InvalidConversationCursor();
  try {
    const bytes=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),character=>character.charCodeAt(0));
    if(base64url(bytes)!==value)throw new InvalidConversationCursor();
    return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes));
  }catch{throw new InvalidConversationCursor();}
}

interface SummaryRow {
  id:string;storeId:string;storeName:string;storeStatus:ConversationSummary['store']['status'];
  platformThreadId:string;platformType:string;platformStatus:string;platformCreatedAt:number;importedAt:number;lastMessageAt:number|null;latestMessage:string|null;
}
interface MessageRow extends Omit<MessageView,'content'|'isImage'> {content:string;isImage:number}
interface ListRow extends SummaryRow {
  viewerMemberId:string;allCount:number;mineCount:number;unassignedCount:number;
  workflowSchemaVersion:number|null;workflowVersion:number|null;workflowLifecycle:string|null;workflowStatus:string|null;assignedMemberId:string|null;assigneeName:string|null;
}
const summaryColumns=`conversation.id,store.id AS storeId,store.name AS storeName,store.status AS storeStatus,
  conversation.platform_thread_id AS platformThreadId,conversation.platform_type AS platformType,conversation.platform_status AS platformStatus,
  conversation.platform_created_at AS platformCreatedAt,conversation.imported_at AS importedAt,conversation.last_message_at AS lastMessageAt,
  (SELECT json_object('id',recent.id,'platformMessageId',recent.platform_message_id,
    'content',json(CASE WHEN json_array_length(recent.content)=0 THEN '[]' ELSE json_array(substr(json_extract(recent.content,'$[0]'),1,280)) END),
    'previewTruncated',json_array_length(recent.content)>1 OR length(COALESCE(json_extract(recent.content,'$[0]'),''))>280,'senderId',recent.sender_id,
    'senderType',recent.sender_type,'direction',recent.direction,'isImage',recent.is_image,'eventAt',recent.event_at)
   FROM message AS recent WHERE recent.organization_id=conversation.organization_id AND recent.store_id=conversation.store_id AND recent.conversation_id=conversation.id
   ORDER BY recent.event_at DESC,recent.id DESC LIMIT 1) AS latestMessage`;
const fromConversation='FROM conversation JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id';
function summary(row:SummaryRow):ConversationSummary {
  const latest=row.latestMessage===null?null:JSON.parse(row.latestMessage) as Omit<MessagePreview,'isImage'|'previewTruncated'> & {isImage:number;previewTruncated:number};
  return {id:row.id,store:{id:row.storeId,name:row.storeName,status:row.storeStatus},platformThreadId:row.platformThreadId,platformType:row.platformType,
    platformStatus:row.platformStatus,platformCreatedAt:row.platformCreatedAt,importedAt:row.importedAt,lastMessageAt:row.lastMessageAt,
    latestMessage:latest===null?null:{...latest,isImage:!!latest.isImage,previewTruncated:!!latest.previewTruncated}};
}

function workflow(row:ListRow):ConversationWorkflow {
  if(row.workflowSchemaVersion===null)return {version:0,lifecycle:'open',workStatus:'needs_reply',assignedMemberId:null,assigneeName:null};
  if(![1,2].includes(row.workflowSchemaVersion)||(row.workflowSchemaVersion===1&&row.workflowStatus!==null))throw new Error('INVALID_CONVERSATION_WORKFLOW');
  const parsed=v.safeParse(workflowSchema,{version:row.workflowVersion,lifecycle:row.workflowLifecycle,
    workStatus:row.workflowSchemaVersion===1?(row.workflowLifecycle==='open'?'needs_reply':null):row.workflowStatus,assignedMemberId:row.assignedMemberId,assigneeName:row.assigneeName});
  if(!parsed.success)throw new Error('INVALID_CONVERSATION_WORKFLOW');
  return parsed.output;
}

export async function listConversations(db:D1Database,actor:StoreActor,options:ConversationListOptions):Promise<ConversationListResult|null>{
  checkLimit(options.limit);if(options.storeId!==undefined)checkId(options.storeId);
  if(options.search!==undefined&&!v.is(searchSchema,options.search))throw new RangeError('INVALID_CONVERSATION_QUERY');
  const queue=options.queue===undefined?'all':options.queue,state=options.state===undefined?'all':options.state;
  if(!v.is(queueSchema,queue)||!v.is(stateFilterSchema,state))throw new RangeError('INVALID_CONVERSATION_QUERY');
  const where=['conversation.organization_id=?',storeAccess('store.organization_id',false)];
  const values:(string|number|null)[]=[actor.orgId,actor.actorUserId,actor.sessionId];
  if(options.storeId!==undefined){where.push('conversation.store_id=?');values.push(options.storeId);}
  if(options.search){
    if(options.search.field==='thread')where.push('conversation.platform_thread_id=?');
    else{where.push('conversation.id IN (SELECT matched.conversation_id FROM message AS matched WHERE matched.organization_id=? AND matched.order_number=?)');values.push(actor.orgId);}
    values.push(options.search.value);
  }
  if(state==='resolved')where.push("control.lifecycle='resolved'");
  else if(state!=='all'){
    where.push(`(CASE WHEN control.conversation_id IS NULL THEN 'needs_reply'
      WHEN control.schema_version=1 AND control.lifecycle='open' THEN 'needs_reply'
      WHEN control.schema_version=2 AND control.lifecycle='open' THEN control.work_status ELSE NULL END)=?`);values.push(state);
  }
  const pageWhere=[...where],pageValues=[...values];
  if(queue==='mine')pageWhere.push('control.assigned_member_id=viewer.viewerMemberId');
  else if(queue==='unassigned')pageWhere.push('control.assigned_member_id IS NULL');
  let cursor:v.InferOutput<typeof listCursorSchema>|undefined;
  if(options.cursor!==undefined){
    const parsed=v.safeParse(listCursorSchema,decodeCursor(options.cursor));if(!parsed.success)throw new InvalidConversationCursor();cursor=parsed.output;
    if(cursor.orgId!==actor.orgId||cursor.storeId!==(options.storeId??null)||cursor.search?.field!==options.search?.field||cursor.search?.value!==options.search?.value||cursor.queue!==queue||cursor.state!==state)throw new InvalidConversationCursor();
    if(cursor.at===null){pageWhere.push('(conversation.last_message_at IS NULL AND conversation.id<?)');pageValues.push(cursor.id);}
    else{pageWhere.push('(conversation.last_message_at<? OR (conversation.last_message_at=? AND conversation.id<?) OR conversation.last_message_at IS NULL)');pageValues.push(cursor.at,cursor.at,cursor.id);}
  }
  const scopedFrom=`${fromConversation} LEFT JOIN conversation_control AS control ON control.conversation_id=conversation.id
    AND control.organization_id=conversation.organization_id AND control.store_id=conversation.store_id CROSS JOIN viewer`;
  // Counts and the page share one snapshot. Expand message bodies and member names only after the page limit.
  const rows=(await db.prepare(`WITH viewer AS (
      SELECT member.id AS viewerMemberId FROM member JOIN user ON user.id=member.user_id JOIN session ON session.user_id=member.user_id
      WHERE member.organization_id=? AND member.user_id=? AND session.id=? AND user.email_verified=1 AND session.expires_at>CAST(unixepoch('subsecond')*1000 AS INTEGER)
    ),totals AS (
      SELECT COUNT(*) AS allCount,COUNT(CASE WHEN control.assigned_member_id=viewer.viewerMemberId THEN 1 END) AS mineCount,
        COUNT(CASE WHEN control.assigned_member_id IS NULL THEN 1 END) AS unassignedCount ${scopedFrom} WHERE ${where.join(' AND ')}
    ),page AS (
      SELECT conversation.id,conversation.organization_id,conversation.store_id,control.schema_version AS workflowSchemaVersion,control.version AS workflowVersion,
        control.lifecycle AS workflowLifecycle,control.work_status AS workflowStatus,control.assigned_member_id AS assignedMemberId
      ${scopedFrom} WHERE ${pageWhere.join(' AND ')} ORDER BY conversation.last_message_at DESC,conversation.id DESC LIMIT ?
    )
    SELECT ${summaryColumns},viewer.viewerMemberId,totals.allCount,totals.mineCount,totals.unassignedCount,
      page.workflowSchemaVersion,page.workflowVersion,page.workflowLifecycle,page.workflowStatus,page.assignedMemberId,assignee_user.name AS assigneeName
    FROM viewer CROSS JOIN totals LEFT JOIN page ON 1=1
    LEFT JOIN conversation ON conversation.id=page.id AND conversation.organization_id=page.organization_id AND conversation.store_id=page.store_id
    LEFT JOIN store ON store.id=conversation.store_id AND store.organization_id=conversation.organization_id
    LEFT JOIN member AS assignee ON assignee.id=page.assignedMemberId AND assignee.organization_id=conversation.organization_id
    LEFT JOIN user AS assignee_user ON assignee_user.id=assignee.user_id
    ORDER BY conversation.last_message_at DESC,conversation.id DESC`)
    .bind(actor.orgId,actor.actorUserId,actor.sessionId,...values,...pageValues,options.limit+1).all<ListRow>()).results;
  if(!rows.length)return null;
  const first=rows[0];if(cursor&&cursor.viewerMemberId!==first.viewerMemberId)throw new InvalidConversationCursor();
  const page=rows.filter(row=>row.id!==null),items=page.slice(0,options.limit).map(row=>({...summary(row),workflow:workflow(row)})),last=items.at(-1);
  return {items,viewerMemberId:first.viewerMemberId,counts:{all:first.allCount,mine:first.mineCount,unassigned:first.unassignedCount},
    nextCursor:page.length>options.limit&&last?encodeCursor({v:2,kind:'list',orgId:actor.orgId,storeId:options.storeId??null,search:options.search??null,viewerMemberId:first.viewerMemberId,queue,state,at:last.lastMessageAt,id:last.id}):null};
}

export async function findConversation(db:D1Database,actor:StoreActor,id:string):Promise<ConversationDetail|null>{
  checkId(id);
  const row=await db.prepare(`SELECT ${summaryColumns},COALESCE(source.enabled,0) AS enabled,source.last_success_at AS lastSuccessAt,source.last_error AS lastError,backfill.completed AS backfillComplete
    ${fromConversation} LEFT JOIN store_sync_source AS source ON source.store_id=store.id AND source.organization_id=store.organization_id AND source.source='chat'
    LEFT JOIN sync_cursor AS backfill ON backfill.store_id=store.id AND backfill.organization_id=store.organization_id AND backfill.conversation_id=conversation.id AND backfill.source='chat' AND backfill.stream='backfill'
    WHERE conversation.id=? AND conversation.organization_id=? AND ${storeAccess('store.organization_id',false)}`)
    .bind(id,actor.orgId,actor.actorUserId,actor.sessionId).first<SummaryRow & {enabled:number;lastSuccessAt:number|null;lastError:string|null;backfillComplete:number|null}>();
  return row?{...summary(row),sync:{enabled:!!row.enabled,lastSuccessAt:row.lastSuccessAt,lastError:row.lastError,backfillComplete:row.backfillComplete===null?null:!!row.backfillComplete}}:null;
}

type HistoryCursor=v.InferOutput<typeof messageCursorSchema>;
type UpdatesCursor=v.InferOutput<typeof updatesCursorSchema>;
interface MessagePageRow extends MessageRow {viewerMemberId:string;currentSequence:number;through:number;more:number;opposite:number}
async function readMessagePage(db:D1Database,actor:StoreActor,id:string,limit:number,mode:{kind:'history';cursor?:HistoryCursor}|{kind:'updates';cursor:UpdatesCursor}) {
  const cursor=mode.cursor;if(cursor&&(cursor.orgId!==actor.orgId||cursor.conversationId!==id))throw new InvalidConversationCursor();
  let boundary='';const values:(string|number)[]=[];
  const through=mode.kind==='history'?mode.cursor?.snapshot??null:mode.cursor.through;
  const edge=mode.kind==='history'?mode.cursor?.edge:null,ascending=edge?.direction==='newer',sort=ascending?'ASC':'DESC';
  const order=mode.kind==='history'?`eventAt ${sort},id ${sort}`:'sequence ASC';
  if(edge){boundary=`AND (message.event_at,message.id) ${ascending?'>':'<'}${edge.inclusive?'=':''} (?,?)`;values.push(edge.at,edge.id);}
  if(mode.kind==='updates'){boundary='AND appended.sequence>?';values.push(mode.cursor.after);}
  // Limit candidates before totaling UTF-8 JSON bytes. The first full message always fits the logical page,
  // even over the 900 KiB body budget; metadata/HTTP encoding means this is not an exact response-size cap.
  const rows=(await db.prepare(`WITH visible AS (
      SELECT conversation.id,conversation.organization_id AS orgId,store.id AS storeId,viewer.id AS viewerMemberId,
        conversation.message_sequence AS currentSequence,COALESCE(?,conversation.message_sequence) AS through ${fromConversation}
      JOIN member AS viewer ON viewer.organization_id=conversation.organization_id AND viewer.user_id=?
      WHERE conversation.id=? AND conversation.organization_id=? AND ${storeAccess('store.organization_id',false)}
    ),candidates AS (
      SELECT message.id,message.platform_message_id AS platformMessageId,message.sender_id AS senderId,message.sender_type AS senderType,
        message.direction,message.content,message.is_image AS isImage,message.event_at AS eventAt,message.received_at AS receivedAt,message.ingest_mode AS ingestMode,
        message.order_number AS orderNumber,message.sku,appended.sequence
      FROM message JOIN visible ON message.conversation_id=visible.id AND message.organization_id=visible.orgId AND message.store_id=visible.storeId
      JOIN message_append AS appended ON appended.message_id=message.id AND appended.conversation_id=visible.id
        AND appended.organization_id=visible.orgId AND appended.store_id=visible.storeId
      WHERE appended.sequence<=visible.through ${boundary} ORDER BY ${mode.kind==='history'?`message.event_at ${sort},message.id ${sort}`:'appended.sequence ASC'} LIMIT ?
    ),sized AS (
      SELECT *,ROW_NUMBER() OVER (ORDER BY ${order}) AS position,
        SUM(length(CAST(content AS BLOB))) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS bytes FROM candidates
    ),page AS (SELECT * FROM sized WHERE position<=? AND (position=1 OR bytes<=921600))
    SELECT page.*,visible.viewerMemberId,visible.currentSequence,visible.through,
      (SELECT COUNT(*) FROM candidates)>(SELECT COUNT(*) FROM page) AS more,
      ${mode.kind==='history'?`EXISTS(SELECT 1 FROM message AS other JOIN message_append AS committed ON committed.message_id=other.id
        AND committed.conversation_id=visible.id AND committed.organization_id=visible.orgId AND committed.store_id=visible.storeId
        WHERE other.conversation_id=visible.id AND other.organization_id=visible.orgId AND other.store_id=visible.storeId AND committed.sequence<=visible.through
          AND (other.event_at,other.id) ${ascending?'<':'>'} (SELECT eventAt,id FROM page ORDER BY eventAt ${sort},id ${sort} LIMIT 1))`:'0'} AS opposite
    FROM visible LEFT JOIN page ON 1=1 ORDER BY ${mode.kind==='history'?`page.eventAt ${sort},page.id ${sort}`:'page.sequence ASC'}`)
    .bind(through,actor.actorUserId,id,actor.orgId,actor.actorUserId,actor.sessionId,...values,limit+1,limit).all<MessagePageRow>()).results;
  if(!rows.length)return null;
  const first=rows[0];
  if(cursor&&cursor.viewerMemberId!==first.viewerMemberId||first.through>first.currentSequence||mode.kind==='updates'&&mode.cursor.after>first.through)throw new InvalidConversationCursor();
  return {rows:rows.filter(row=>row.id!==null),viewerMemberId:first.viewerMemberId,through:first.through,hasMore:!!first.more,opposite:!!first.opposite};
}
function message(row:MessageRow):MessageView {
  return {id:row.id,sequence:row.sequence,platformMessageId:row.platformMessageId,senderId:row.senderId,senderType:row.senderType,direction:row.direction,
    content:JSON.parse(row.content) as string[],isImage:!!row.isImage,eventAt:row.eventAt,receivedAt:row.receivedAt,ingestMode:row.ingestMode,orderNumber:row.orderNumber,sku:row.sku};
}
export async function listMessages(db:D1Database,actor:StoreActor,id:string,options:MessageListOptions):Promise<MessageListResult|null>{
  checkId(id);checkLimit(options.limit);let cursor:HistoryCursor|undefined;
  if(options.cursor!==undefined){const parsed=v.safeParse(messageCursorSchema,decodeCursor(options.cursor));if(!parsed.success)throw new InvalidConversationCursor();cursor=parsed.output;}
  if((options.anchorId!==undefined)!==(options.direction!==undefined)||options.anchorId!==undefined&&!cursor)throw new RangeError('INVALID_CONVERSATION_QUERY');
  if(options.anchorId!==undefined){
    checkId(options.anchorId);if(!['older','newer','from'].includes(options.direction!))throw new RangeError('INVALID_CONVERSATION_QUERY');
    if(cursor!.orgId!==actor.orgId||cursor!.conversationId!==id)throw new InvalidConversationCursor();
    const anchor=await db.prepare(`SELECT message.event_at AS at,message.id ${fromConversation}
      JOIN message ON message.conversation_id=conversation.id AND message.organization_id=conversation.organization_id AND message.store_id=store.id
      JOIN message_append AS committed ON committed.message_id=message.id AND committed.conversation_id=conversation.id
        AND committed.organization_id=conversation.organization_id AND committed.store_id=store.id
      WHERE conversation.id=? AND conversation.organization_id=? AND message.id=? AND committed.sequence<=? AND ${storeAccess('store.organization_id',false)}`)
      .bind(id,actor.orgId,options.anchorId,cursor!.snapshot,actor.actorUserId,actor.sessionId).first<{at:number;id:string}>();
    if(!anchor)return null;
    cursor={...cursor!,edge:{...anchor,direction:options.direction==='older'?'older':'newer',inclusive:options.direction==='from'}};
  }
  const page=await readMessagePage(db,actor,id,options.limit,{kind:'history',cursor});if(!page)return null;
  const ascending=cursor?.edge?.direction==='newer',items=(ascending?page.rows:page.rows.reverse()).map(message),oldest=items[0],newest=items.at(-1),scope={orgId:actor.orgId,conversationId:id,viewerMemberId:page.viewerMemberId};
  const current={v:3,kind:'messages',...scope,snapshot:page.through,edge:cursor?.edge??null};
  return {items,viewerMemberId:page.viewerMemberId,pageCursor:encodeCursor(current),
    nextCursor:(ascending?page.opposite:page.hasMore)&&oldest?encodeCursor({...current,edge:{at:oldest.eventAt,id:oldest.id,direction:'older',inclusive:false}}):null,
    newerCursor:(ascending?page.hasMore:page.opposite)&&newest?encodeCursor({...current,edge:{at:newest.eventAt,id:newest.id,direction:'newer',inclusive:false}}):null,
    updatesCursor:encodeCursor({v:1,kind:'message-updates',...scope,after:page.through,through:null})};
}
export async function listMessageUpdates(db:D1Database,actor:StoreActor,id:string,options:{cursor:string;limit:number}):Promise<MessageUpdatesResult|null>{
  checkId(id);checkLimit(options.limit);
  const parsed=v.safeParse(updatesCursorSchema,decodeCursor(options.cursor));if(!parsed.success)throw new InvalidConversationCursor();const cursor=parsed.output;
  const page=await readMessagePage(db,actor,id,options.limit,{kind:'updates',cursor});if(!page)return null;
  const after=page.hasMore?page.rows.at(-1)!.sequence:page.through;
  return {items:page.rows.map(message),viewerMemberId:page.viewerMemberId,hasMore:page.hasMore,
    historyCursor:encodeCursor({v:3,kind:'messages',orgId:actor.orgId,conversationId:id,viewerMemberId:page.viewerMemberId,snapshot:after,edge:null}),
    nextCursor:encodeCursor({...cursor,after,through:page.hasMore?page.through:null})};
}
