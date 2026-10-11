import type { Context, Hono } from 'hono';
import { apiError, jsonResponse, type ApplicationEnv } from '../../http.ts';
import { companyFor, configured, signedIn } from '../identity/http.ts';
import { findStore, type StoreActor } from '../stores/storage.ts';
import { findConversation, InvalidConversationCursor, listConversations, listMessages, listMessageUpdates } from './read.ts';
import type { ConversationListOptions, ConversationQueue, ConversationStateFilter, ConversationSummary, MessagePreview, MessageView } from './read-types.ts';
import { readMessageContext } from './context.ts';

const path='/api/companies/:companyId/conversations';
const notFound=(c:Context<ApplicationEnv>)=>apiError(c,'NOT_FOUND','The company, store or conversation is not available.',404);
async function actorFor(c:Context<ApplicationEnv>):Promise<StoreActor|null>{
  const identity=c.get('identitySession'),orgId=c.req.param('companyId')!;
  return await companyFor(c,orgId,identity.user.id)?{orgId,actorUserId:identity.user.id,sessionId:identity.session.id}:null;
}
function query(c:Context<ApplicationEnv>,allowed:string[]){
  const parameters=new URL(c.req.url).searchParams;
  for(const key of parameters.keys()) if(!allowed.includes(key)||parameters.getAll(key).length!==1)throw new RangeError('Invalid query.');
  return parameters;
}
function value(parameters:URLSearchParams,key:string,max=256){
  const result=parameters.get(key);if(result===null)return undefined;
  if(!result.trim()||result.length>max||/[\u0000-\u001f\u007f]/.test(result))throw new RangeError('Invalid query.');
  return result;
}
function paging(parameters:URLSearchParams){
  const raw=parameters.get('limit');
  if(raw!==null&&(!/^[1-9][0-9]{0,2}$/.test(raw)||Number(raw)>100))throw new RangeError('Invalid limit.');
  return {limit:raw===null?50:Number(raw),cursor:value(parameters,'cursor',4096)};
}
const time=(milliseconds:number|null)=>milliseconds===null?null:new Date(milliseconds).toISOString();
function preview(message:MessagePreview){return {...message,eventAt:new Date(message.eventAt).toISOString()};}
function summary(item:ConversationSummary){return {...item,platformCreatedAt:new Date(item.platformCreatedAt).toISOString(),importedAt:new Date(item.importedAt).toISOString(),lastMessageAt:time(item.lastMessageAt),latestMessage:item.latestMessage?preview(item.latestMessage):null};}
function messageDTO(item:MessageView){return {...item,eventAt:new Date(item.eventAt).toISOString(),receivedAt:new Date(item.receivedAt).toISOString()};}
function invalid(c:Context<ApplicationEnv>,error:unknown){
  if(error instanceof RangeError||error instanceof InvalidConversationCursor)return apiError(c,'INVALID_REQUEST','The query or pagination cursor is invalid. Refresh the list before continuing.',400);
  throw error;
}

export function registerConversationRoutes(app:Hono<ApplicationEnv>){
  app.get(`${path}/:id/messages/:messageId/context`,configured,signedIn,async c=>{
    const actor=await actorFor(c);if(!actor)return notFound(c);
    try {
      const parameters=query(c,['afterPosting']);
      const result=await readMessageContext(c.env.DB!,actor,c.req.param('id')!,c.req.param('messageId')!,value(parameters,'afterPosting'));
      return result?jsonResponse(c,result):notFound(c);
    }catch(error){return invalid(c,error);}
  });
  app.get(path,configured,signedIn,async c=>{
    const actor=await actorFor(c);if(!actor)return notFound(c);
    try {
      const parameters=query(c,['storeId','searchField','search','queue','state','cursor','limit']);
      const storeId=value(parameters,'storeId'),field=value(parameters,'searchField'),search=value(parameters,'search');
      const queue=value(parameters,'queue')??'all',state=value(parameters,'state')??'all';
      if((field===undefined)!==(search===undefined)||field!==undefined&&!['thread','order'].includes(field))throw new RangeError('Invalid search.');
      if(!['all','mine','unassigned'].includes(queue)||!['all','needs_reply','waiting_customer','waiting_internal','resolved'].includes(state))throw new RangeError('Invalid queue or state.');
      const options:ConversationListOptions={...paging(parameters),storeId,queue:queue as ConversationQueue,state:state as ConversationStateFilter,...(field&&search?{search:{field:field as 'thread'|'order',value:search}}:{})};
      if(storeId&&!await findStore(c.env.DB!,actor,storeId,false))return notFound(c);
      const result=await listConversations(c.env.DB!,actor,options);
      return result?jsonResponse(c,{companyId:actor.orgId,viewerMemberId:result.viewerMemberId,counts:result.counts,
        conversations:result.items.map(item=>({...summary(item),workflow:item.workflow})),nextCursor:result.nextCursor}):notFound(c);
    }catch(error){return invalid(c,error);}
  });
  app.get(`${path}/:id`,configured,signedIn,async c=>{
    const actor=await actorFor(c);if(!actor)return notFound(c);
    try {
      query(c,[]);
      const item=await findConversation(c.env.DB!,actor,c.req.param('id')!);
      return item?jsonResponse(c,{companyId:actor.orgId,conversation:{...summary(item),sync:{...item.sync,lastSuccessAt:time(item.sync.lastSuccessAt)}}}):notFound(c);
    }catch(error){return invalid(c,error);}
  });
  app.get(`${path}/:id/messages`,configured,signedIn,async c=>{
    const actor=await actorFor(c);if(!actor)return notFound(c);
    try {
      const params=query(c,['cursor','limit','anchorId','direction']),options={...paging(params),anchorId:params.get('anchorId')??undefined,direction:params.get('direction')??undefined},id=c.req.param('id')!;
      if(options.direction!==undefined&&!['older','newer','from'].includes(options.direction))throw new RangeError('Invalid direction.');
      const result=await listMessages(c.env.DB!,actor,id,{...options,direction:options.direction as 'older'|'newer'|'from'|undefined});
      return result?jsonResponse(c,{companyId:actor.orgId,conversationId:id,viewerMemberId:result.viewerMemberId,messages:result.items.map(messageDTO),
        nextCursor:result.nextCursor,newerCursor:result.newerCursor,pageCursor:result.pageCursor,updatesCursor:result.updatesCursor}):notFound(c);
    }catch(error){return invalid(c,error);}
  });
  app.get(`${path}/:id/message-updates`,configured,signedIn,async c=>{
    const actor=await actorFor(c);if(!actor)return notFound(c);
    try {
      const options=paging(query(c,['cursor','limit'])),id=c.req.param('id')!;
      if(options.cursor===undefined)throw new RangeError('Missing cursor.');
      const result=await listMessageUpdates(c.env.DB!,actor,id,{...options,cursor:options.cursor});
      return result?jsonResponse(c,{companyId:actor.orgId,conversationId:id,viewerMemberId:result.viewerMemberId,messages:result.items.map(messageDTO),nextCursor:result.nextCursor,historyCursor:result.historyCursor,hasMore:result.hasMore}):notFound(c);
    }catch(error){return invalid(c,error);}
  });
}
