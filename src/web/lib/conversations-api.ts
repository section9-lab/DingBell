import * as v from 'valibot';
import { ApiError, request } from './api.ts';

const id=v.pipe(v.string(),v.minLength(1),v.maxLength(256));
const timestamp=v.pipe(v.string(),v.isoTimestamp(),v.check(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value));
const cursor=v.pipe(v.string(),v.minLength(1),v.maxLength(4096));
const limit=v.pipe(v.number(),v.integer(),v.minValue(1),v.maxValue(100));
const count=v.pipe(v.number(),v.integer(),v.minValue(0),v.maxValue(Number.MAX_SAFE_INTEGER));
const messageFields={
  id,platformMessageId:id,senderId:v.nullable(id),senderType:v.string(),direction:v.picklist(['inbound','outbound','unknown']),
  isImage:v.boolean(),eventAt:timestamp,
};
const previewSchema=v.object({...messageFields,content:v.pipe(v.array(v.pipe(v.string(),v.check(value=>Array.from(value).length<=280))),v.maxLength(1)),previewTruncated:v.boolean()});
const messageSchema=v.object({...messageFields,sequence:v.pipe(count,v.minValue(1)),content:v.array(v.string()),receivedAt:timestamp,ingestMode:v.picklist(['backfill','incremental']),orderNumber:v.nullable(v.string()),sku:v.nullable(id)});
const summaryFields={
  id,store:v.object({id,name:v.string(),status:v.picklist(['unverified','verified','partial','attention','paused','disconnected'])}),
  platformThreadId:id,platformType:v.string(),platformStatus:v.string(),platformCreatedAt:timestamp,importedAt:timestamp,lastMessageAt:v.nullable(timestamp),latestMessage:v.nullable(previewSchema),
};
const queueSchema=v.picklist(['all','mine','unassigned']);
const stateFilterSchema=v.picklist(['all','needs_reply','waiting_customer','waiting_internal','resolved']);
const workflowSchema=v.pipe(v.object({version:count,lifecycle:v.picklist(['open','resolved']),workStatus:v.nullable(v.picklist(['needs_reply','waiting_customer','waiting_internal'])),assignedMemberId:v.nullable(id),assigneeName:v.nullable(v.string())}),
  v.check(value=>(value.lifecycle==='resolved'?value.workStatus===null:value.workStatus!==null)&&(value.assignedMemberId!==null||value.assigneeName===null)));
const summarySchema=v.object({...summaryFields,workflow:workflowSchema});
const detailSchema=v.object({...summaryFields,sync:v.object({enabled:v.boolean(),lastSuccessAt:v.nullable(timestamp),lastError:v.nullable(v.string()),backfillComplete:v.nullable(v.boolean())})});
const listOptions=v.pipe(v.strictObject({queue:v.optional(queueSchema),state:v.optional(stateFilterSchema),storeId:v.optional(id),searchField:v.optional(v.picklist(['thread','order'])),search:v.optional(v.pipe(v.string(),v.minLength(1),v.maxLength(256),v.check(value=>!!value.trim()))),cursor:v.optional(cursor),limit:v.optional(limit)}),v.check(value=>(value.searchField===undefined)===(value.search===undefined)));
const pageOptions=v.pipe(v.strictObject({cursor:v.optional(cursor),limit:v.optional(limit),anchorId:v.optional(id),direction:v.optional(v.picklist(['older','newer','from']))}),
  v.check(value=>(value.anchorId===undefined)===(value.direction===undefined)&&(value.anchorId===undefined||value.cursor!==undefined)));
const updatesOptions=v.strictObject({cursor,limit:v.optional(limit)});
export type ConversationQueue=v.InferOutput<typeof queueSchema>;
export type ConversationStateFilter=v.InferOutput<typeof stateFilterSchema>;
export type ConversationWorkflow=v.InferOutput<typeof workflowSchema>;
export type ConversationListOptions=v.InferOutput<typeof listOptions>;
export type ConversationPageOptions=v.InferOutput<typeof pageOptions>;
export type ConversationSummary=v.InferOutput<typeof summarySchema>;
export type ConversationDetail=v.InferOutput<typeof detailSchema>;
export type ConversationMessage=v.InferOutput<typeof messageSchema>;
export type MessagePreview=v.InferOutput<typeof previewSchema>;
const path=(companyId:string,conversationId?:string)=>`/api/companies/${encodeURIComponent(companyId)}/conversations${conversationId===undefined?'':`/${encodeURIComponent(conversationId)}`}`;
function identifier(value:string){if(!v.safeParse(id,value).success)throw new ApiError('INVALID_REQUEST');return value;}
function query(values:Record<string,string|number|undefined>){const params=new URLSearchParams();for(const [key,value]of Object.entries(values))if(value!==undefined)params.set(key,String(value));return params.size?`?${params}`:'';}
function unique(items:{id:string}[]){return new Set(items.map(item=>item.id)).size===items.length;}
function uniqueMessages(items:ConversationMessage[]){return unique(items)&&new Set(items.map(item=>item.sequence)).size===items.length;}

export async function readConversations(companyId:string,options:ConversationListOptions={},signal?:AbortSignal){
  identifier(companyId);const parsed=v.safeParse(listOptions,options);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
  const value=parsed.output;
  return request(`${path(companyId)}${query(value)}`,v.pipe(v.object({companyId:v.literal(companyId),viewerMemberId:id,counts:v.object({all:count,mine:count,unassigned:count}),
    conversations:v.pipe(v.array(summarySchema),v.maxLength(value.limit??50),v.check(items=>unique(items)),v.check(items=>!value.storeId||items.every(item=>item.store.id===value.storeId))),
    nextCursor:v.nullable(cursor),
  }),v.check(page=>page.counts.mine+page.counts.unassigned<=page.counts.all&&page.conversations.length<=page.counts[value.queue??'all']
    &&page.conversations.every(({workflow})=>(value.queue==='mine'?workflow.assignedMemberId===page.viewerMemberId:value.queue==='unassigned'?workflow.assignedMemberId===null:true)
      &&(!value.state||value.state==='all'||(value.state==='resolved'?workflow.lifecycle==='resolved':workflow.lifecycle==='open'&&workflow.workStatus===value.state))))),{signal});
}
export async function readConversation(companyId:string,conversationId:string,signal?:AbortSignal){
  identifier(companyId);identifier(conversationId);
  return request(path(companyId,conversationId),v.object({companyId:v.literal(companyId),conversation:v.pipe(detailSchema,v.check(item=>item.id===conversationId))}),{signal});
}
export async function readConversationMessages(companyId:string,conversationId:string,options:ConversationPageOptions={},signal?:AbortSignal){
  identifier(companyId);identifier(conversationId);const parsed=v.safeParse(pageOptions,options);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
  return request(`${path(companyId,conversationId)}/messages${query(parsed.output)}`,v.pipe(v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),
    viewerMemberId:id,pageCursor:cursor,updatesCursor:cursor,messages:v.pipe(v.array(messageSchema),v.maxLength(parsed.output.limit??50),v.check(uniqueMessages)),nextCursor:v.nullable(cursor),newerCursor:v.nullable(cursor),
  }),v.check(page=>page.nextCursor!==page.pageCursor&&page.newerCursor!==page.pageCursor)),{signal});
}
export async function readConversationMessageUpdates(companyId:string,conversationId:string,options:v.InferOutput<typeof updatesOptions>,signal?:AbortSignal){
  identifier(companyId);identifier(conversationId);const parsed=v.safeParse(updatesOptions,options);if(!parsed.success)throw new ApiError('INVALID_REQUEST');
  return request(`${path(companyId,conversationId)}/message-updates${query(parsed.output)}`,v.pipe(v.object({companyId:v.literal(companyId),conversationId:v.literal(conversationId),viewerMemberId:id,
    messages:v.pipe(v.array(messageSchema),v.maxLength(parsed.output.limit??50),v.check(uniqueMessages),v.check(items=>items.every((item,index)=>!index||item.sequence>items[index-1].sequence))),
    nextCursor:cursor,historyCursor:cursor,hasMore:v.boolean(),
  }),v.check(page=>(!page.hasMore||page.messages.length>0)&&(!page.messages.length||page.nextCursor!==parsed.output.cursor))),{signal});
}
