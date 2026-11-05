import {listOzonProducts,readOzonProductDetails} from '../products/ozon.ts';
import {listOzonFbsPostings,listOzonFboPostings,listOzonFbpPostings,readOzonFbsPosting,readOzonFboPosting,readOzonFbpPosting} from '../orders/ozon.ts';
import {importPushPosting,importPushProducts,importPushListings} from './ingest.ts';
import {listOzonChats,readOzonMessages,OzonReadError,type OzonMessage} from '../conversations/ozon.ts';
import {CredentialError,decryptCredentials} from '../stores/credentials.ts';
import {claimSyncLease,commitSyncPage,finishSyncFailure,getSyncRuntime,releaseSyncLease,syncLeaseCondition} from '../sync/storage.ts';
import type {SyncBindings,SyncBucket} from '../sync/bindings.ts';
import type {SyncCursor,SyncLease,SyncScope,NormalizedMessage} from '../sync/types.ts';
import {duePostingHistory} from '../orders/history.ts';
import {commitFbsList,commitFboList,commitFbpList} from '../orders/storage.ts';
import {enqueuePushChildren,claimPushJob,finishPushJob,readEndpoint,type PushJob} from './storage.ts';

function advance(job:PushJob,next:string|null,hasNext:boolean){const current=job.progress.cursor??null,recent=job.progress.recent??[];if(hasNext&&(!next||next===current||recent.includes(next)))throw new Error('cursor_stalled');return {...job.progress,cursor:next,recent:hasNext?[...recent,...(current?[current]:[])].slice(-8):[]};}
async function cursor(db:D1Database,lease:SyncLease,threadId:string,stream:'incremental'|'discovery'|'backfill'){
 const row=await db.prepare(`SELECT store_id AS storeId,thread_id AS threadId,stream,cursor,revision,due_at AS dueAt,completed,recent_cursors AS recentCursors FROM sync_cursor WHERE organization_id=? AND store_id=? AND thread_id=? AND stream=?`).bind(lease.orgId,lease.storeId,threadId,stream).first<Omit<SyncCursor,'recentCursors'>&{recentCursors:string}>();
 if(!row)throw new Error('sync_cursor_missing');return {...row,completed:!!row.completed,recentCursors:JSON.parse(row.recentCursors) as string[]};
}
function normalized(message:OzonMessage,chatId:string,liveObserved:boolean):NormalizedMessage{return {platformThreadId:chatId,platformMessageId:message.id,senderId:message.senderId,senderType:message.senderType,content:message.content,isImage:message.isImage,isRead:message.isRead,orderNumber:message.orderNumber,sku:message.sku,eventAt:Date.parse(message.createdAt),liveObserved,direction:['Customer','Сustomer'].includes(message.senderType)?'inbound':message.senderType==='Seller'?'outbound':'unknown'};}
export async function runPushPage(env:SyncBindings&{DB:D1Database},scope:SyncScope,options:{fetcher?:typeof fetch;onCommittedLive?:(scope:SyncScope)=>void;reserve?:(bucket:SyncBucket,now:number)=>Promise<number>}={}):Promise<void>{
 const db=env.DB,job=await claimPushJob(db,scope);if(!job)return;
 let lease:SyncLease|null=null;
 try{
  if(job.source==='none'){await finishPushJob(db,job,'ignored');return;}
  lease=await claimSyncLease(db,{...scope,source:job.source,token:crypto.randomUUID(),push:{id:job.id,generation:job.generation,token:job.token}});
  if(!lease){await finishPushJob(db,job,'pending',{nextAt:Date.now()+1000});return;}
  const runtime=await getSyncRuntime(db,scope,lease.source),endpoint=await readEndpoint(db,scope);if(!runtime||!endpoint)throw new Error('sync_authority_changed');
  const store=runtime.store;if(!store.credentialKeyVersion||!store.credentialNonce||!store.credentialCiphertext)throw new CredentialError();
  const {apiKey}=await decryptCredentials(env,{...scope,platformStoreId:store.platformStoreId,credentialVersion:lease.credentialVersion},{keyVersion:store.credentialKeyVersion,nonce:store.credentialNonce,ciphertext:store.credentialCiphertext});
  const credentials={clientId:store.platformStoreId,apiKey},signal=AbortSignal.timeout(10_000),hint=job.hint;
  const conversation=hint.chatId?await db.prepare("SELECT id FROM conversation WHERE organization_id=? AND store_id=? AND platform_thread_id=? AND platform_type='BUYER_SELLER'").bind(scope.orgId,scope.storeId,hint.chatId).first<{id:string}>():null;
  const discovery=!!hint.chatId&&(!conversation||hint.action==='closed');
  const bucket:SyncBucket=hint.kind==='reconcile'?(lease.source==='chat'?'chat-list':lease.source==='products'?'product-list':lease.source==='fbs_postings'?'fbs-list':lease.source==='fbo_postings'?'fbo-list':'fbp-list'):hint.kind==='posting'?(lease.source==='fbo_postings'?'fbo-detail':lease.source==='fbp_postings'?'fbp-detail':'fbs-detail'):hint.kind==='products'?(job.progress.phase==='listing'?'product-list':'product-details'):discovery?'chat-list':'chat-history',now=Date.now(),permit=await options.reserve?.(bucket,now)??now;
  if(permit>now){await releaseSyncLease(db,lease,permit);await finishPushJob(db,job,'pending',{nextAt:permit});return;}
  if(hint.kind==='reconcile'){
   if(hint.source==='products'){
    const page=await listOzonProducts(credentials,{lastId:job.progress.cursor??undefined,limit:100},options.fetcher,signal),hasNext=page.items.length>0,progress=advance(job,page.lastId||null,hasNext);
    if(!await importPushListings(db,lease,page.items))throw new Error('sync_authority_changed');
    if(page.items.length&&!await enqueuePushChildren(db,job,[{kind:'products',source:'products',productIds:page.items.map(item=>item.id),skus:[]}]))throw new Error('sync_authority_changed');
    await releaseSyncLease(db,lease,Date.now()+1000);await finishPushJob(db,job,hasNext?'pending':'completed',{progress,nextAt:Date.now()+1000,attempts:0});return;
   }
   if(hint.source==='chat'){
    const page=await listOzonChats(credentials,{cursor:job.progress.cursor??undefined,limit:100},options.fetcher,signal),chats=page.chats.filter(chat=>chat.type==='BUYER_SELLER'),progress=advance(job,page.cursor,page.hasNext),work=await cursor(db,lease,'','discovery');
    if(!await commitSyncPage(db,lease,{cursor:work,nextCursor:work.cursor,nextDueAt:Date.now()+60_000,completed:false,chats:chats.map(chat=>({platformThreadId:chat.id,type:chat.type,status:chat.status,createdAt:Date.parse(chat.createdAt),lastMessageId:chat.lastMessageId})),seeds:chats.map(chat=>({threadId:chat.id,stream:'incremental',cursor:null,dueAt:Date.now()}))}))throw new Error('sync_authority_changed');
    if(!await enqueuePushChildren(db,job,chats.map(chat=>({kind:'chat',source:'chat',chatId:chat.id,action:'history'}))))throw new Error('sync_authority_changed');
    await finishPushJob(db,job,page.hasNext?'pending':'completed',{progress,nextAt:Date.now()+1000,attempts:0});return;
   }
   const mode=hint.source==='fbo_postings'?'fbo':hint.source==='fbp_postings'?'fbp':'fbs',list=mode==='fbo'?listOzonFboPostings:mode==='fbp'?listOzonFbpPostings:listOzonFbsPostings;
   if(hint.reason==='posting_history'){
    const history=await duePostingHistory(db,lease,Date.now());
    if(history?.work){
     const work=history.work,page=await list(credentials,{since:work.since,to:work.to,cursor:work.cursor??undefined,limit:50},options.fetcher,signal);
     if(!await(mode==='fbo'?commitFboList:mode==='fbp'?commitFbpList:commitFbsList)(db,lease,work,page))throw new Error('sync_authority_changed');
     await finishPushJob(db,job,'pending',{nextAt:Date.now()+1000,attempts:0});return;
    }
    const status=await db.prepare('SELECT state,due_at AS dueAt FROM posting_history_sync WHERE organization_id=? AND store_id=? AND source=?').bind(scope.orgId,scope.storeId,hint.source).first<{state:string;dueAt:number}>();
    if(status?.state==='active'){await releaseSyncLease(db,lease,status.dueAt);await finishPushJob(db,job,'pending',{nextAt:Math.max(Date.now()+1000,status.dueAt)});return;}
    const pending=status?.state==='complete'?(await db.prepare(`SELECT posting_number AS id FROM ${mode}_posting WHERE organization_id=? AND store_id=? AND detail_epoch=? AND detail_state='pending' ORDER BY posting_number LIMIT 100`).bind(scope.orgId,scope.storeId,lease.epoch).all<{id:string}>()).results:[];
    if(pending.length)await enqueuePushChildren(db,job,pending.map(row=>({kind:'posting',source:hint.source,postingNumber:row.id})));
    await releaseSyncLease(db,lease,Date.now()+1000);await finishPushJob(db,job,pending.length?'pending':status?.state==='cancelled'?'ignored':'completed',{nextAt:Date.now()+1000});return;
   }
   const page=await list(credentials,{since:new Date(job.receivedAt-30*86_400_000).toISOString(),to:new Date(job.receivedAt).toISOString(),cursor:job.progress.cursor??undefined,limit:50},options.fetcher,signal),progress=advance(job,page.cursor,page.hasNext);
   if(!await enqueuePushChildren(db,job,page.postings.map(posting=>({kind:'posting',source:hint.source,postingNumber:posting.postingNumber}))))throw new Error('sync_authority_changed');
   await releaseSyncLease(db,lease,Date.now()+1000);await finishPushJob(db,job,page.hasNext?'pending':'completed',{progress,nextAt:Date.now()+1000,attempts:0});return;
  }
  if(hint.kind==='posting'){
   const read=lease.source==='fbo_postings'?readOzonFboPosting:lease.source==='fbp_postings'?readOzonFbpPosting:readOzonFbsPosting;
   const posting=await read(credentials,{postingNumber:hint.postingNumber!},options.fetcher,signal);
   if(!await importPushPosting(db,lease,posting))throw new Error('sync_authority_changed');
   await finishPushJob(db,job,'completed');return;
  }
  if(hint.kind==='products'){
   const ids=[...(hint.productIds??[])];
   for(const sku of hint.skus??[]){const matches=(await db.prepare('SELECT DISTINCT product_id AS id FROM product_sku WHERE organization_id=? AND store_id=? AND sku=? LIMIT 2').bind(scope.orgId,scope.storeId,sku).all<{id:string}>()).results;if(matches.length!==1)throw new Error('product_identity_unresolved');ids.push(matches[0]!.id);}
   const all=[...new Set(ids)],offset=job.progress.offset??0,requested=all.slice(offset,offset+100);if(!requested.length)throw new Error('product_identity_unresolved');
   if(job.progress.phase!=='listing'){
    const page=await readOzonProductDetails(credentials,{productIds:requested},options.fetcher,signal);
    if(page.items.length!==requested.length)throw new Error('product_details_missing');
    if(!await importPushProducts(db,lease,page.items))throw new Error('sync_authority_changed');
    await finishPushJob(db,job,'pending',{progress:{phase:'listing',offset},nextAt:Date.now()+1000,attempts:0});return;
   }
   const page=await listOzonProducts(credentials,{productIds:requested,limit:100},options.fetcher,signal);if(page.items.length!==requested.length)throw new Error('product_listing_missing');
   if(!await importPushListings(db,lease,page.items))throw new Error('sync_authority_changed');
   await releaseSyncLease(db,lease,Date.now()+1000);
   await finishPushJob(db,job,offset+requested.length<all.length?'pending':'completed',{progress:{offset:offset+requested.length},nextAt:Date.now()+1000,attempts:0});return;
  }
  if(discovery){
   const page=await listOzonChats(credentials,{cursor:job.progress.cursor??undefined,limit:100},options.fetcher,signal),chat=page.chats.find(chat=>chat.id===hint.chatId&&chat.type==='BUYER_SELLER');
   const progress=advance(job,page.cursor,page.hasNext);
   if(!chat){await releaseSyncLease(db,lease,Date.now()+1000);if(!page.hasNext)throw new Error('chat_not_found');await finishPushJob(db,job,'pending',{progress,nextAt:Date.now()+1000});return;}
   const work=await cursor(db,lease,'','discovery');
   const saved=await commitSyncPage(db,lease,{cursor:work,nextCursor:work.cursor,nextDueAt:Date.now()+60_000,completed:false,chats:[{platformThreadId:chat.id,type:chat.type,status:chat.status,createdAt:Date.parse(chat.createdAt),lastMessageId:chat.lastMessageId}],seeds:[{threadId:chat.id,stream:'incremental',cursor:null,dueAt:Date.now()}]});if(!saved)throw new Error('sync_authority_changed');
   await finishPushJob(db,job,hint.action==='closed'?'completed':'pending',{progress:{phase:'history'},nextAt:Date.now()+1000});return;
  }
  if(hint.kind!=='message'&&hint.kind!=='chat')throw new Error('unsupported_work');
  const chatId=hint.chatId!;
  if(hint.action==='history'){
   const guard=syncLeaseCondition(lease);
   if(job.progress.phase!=='reading')await db.prepare(`INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at,completed) SELECT organization_id,store_id,platform_thread_id,'backfill',id,NULL,0,?,0 FROM conversation WHERE id=? AND ${guard.sql} ON CONFLICT(store_id,stream,thread_id) DO UPDATE SET cursor=NULL,recent_cursors='[]',revision=sync_cursor.revision+1,due_at=excluded.due_at,completed=0`).bind(Date.now(),conversation!.id,...guard.values).run();
   const work=await cursor(db,lease,chatId,'backfill'),page=await readOzonMessages(credentials,{chatId,direction:'Backward',limit:100,fromMessageId:work.cursor??undefined},options.fetcher,signal),next=page.messages.at(-1)?.id??work.cursor;
   if(!await commitSyncPage(db,lease,{cursor:work,nextCursor:next,nextDueAt:Date.now()+1000,completed:!page.hasNext,continuing:page.hasNext,...(work.cursor===null?{canonicalHead:page.messages.find(message=>['Customer','Сustomer','Seller'].includes(message.senderType))?.id??null}:{}),messages:[...page.messages].reverse().map(message=>normalized(message,chatId,false))}))throw new Error('sync_authority_changed');
   await finishPushJob(db,job,page.hasNext?'pending':'completed',{progress:{phase:'reading'},nextAt:Date.now()+1000,attempts:0});return;
  }
  const page=await readOzonMessages(credentials,{chatId,direction:'Backward',limit:100,fromMessageId:job.progress.cursor??undefined},options.fetcher,signal);
  for(let index=1;index<page.messages.length;index++)if(Date.parse(page.messages[index-1]!.createdAt)<Date.parse(page.messages[index]!.createdAt))throw new OzonReadError('invalid_response');
  const target=hint.messageId?page.messages.find(message=>message.id===hint.messageId):undefined;
  const latestHuman=page.messages.find(message=>['Customer','Сustomer','Seller'].includes(message.senderType));
  const live=!!target&&['Customer','Сustomer'].includes(target.senderType)&&target.id===latestHuman?.id&&!job.progress.cursor&&hint.action==='new'&&!job.simulated&&Date.parse(target.createdAt)>=(endpoint.cutoverAt??Date.now())&&Date.parse(target.createdAt)<=job.receivedAt+120_000;
  const condition=syncLeaseCondition(lease);
  await db.prepare(`INSERT INTO sync_cursor(organization_id,store_id,thread_id,stream,conversation_id,cursor,revision,due_at,completed)
   SELECT organization_id,store_id,platform_thread_id,'incremental',id,NULL,0,?,0 FROM conversation WHERE id=? AND organization_id=? AND store_id=? AND ${condition.sql} ON CONFLICT DO NOTHING`).bind(Date.now(),conversation!.id,scope.orgId,scope.storeId,...condition.values).run();
  const work=await cursor(db,lease,chatId,'incremental');
  const saved=await commitSyncPage(db,lease,{cursor:work,nextCursor:work.cursor,nextDueAt:Date.now()+60_000,completed:false,ingestAsHistory:!live,...(!job.progress.cursor?{canonicalHead:latestHuman?.id??null}:{}),messages:[...page.messages].reverse().map(message=>normalized(message,chatId,live&&message.id===target?.id))});
  if(!saved)throw new Error('sync_authority_changed');
  if(hint.messageId&&!target){const progress=advance(job,page.messages.at(-1)?.id??null,page.hasNext);if(!page.hasNext)throw new Error('message_not_found');await finishPushJob(db,job,'pending',{progress,nextAt:Date.now()+1000});return;}
  await finishPushJob(db,job,'completed');
  if(live)try{options.onCommittedLive?.(scope);}catch{/* committed ingest outbox is independently repairable */}
 }catch(error){
  const code=error instanceof OzonReadError?error.code:error instanceof CredentialError?'credentials_unavailable':error instanceof Error&&['chat_not_found','message_not_found','cursor_stalled','sync_authority_changed','unsupported_work','sync_cursor_missing','product_identity_unresolved','product_details_missing','product_listing_missing'].includes(error.message)?error.message:error instanceof Error&&error.message.includes('MESSAGE_ID_CONFLICT')?'message_content_changed':'push_processing_failed';
  const attempts=job.attempts+1,wait=error instanceof OzonReadError?error.retryAfterMs??0:0;
  const fatal=['invalid_credentials','credentials_unavailable','permission_denied','invalid_request','redirect_refused','cursor_stalled','message_content_changed','unsupported_work','product_identity_unresolved'].includes(code)||attempts>=8||wait>86_400_000;
  const nextAt=Date.now()+Math.max(wait,Math.min(300_000,5000*2**Math.min(attempts-1,6)));
  if(lease&&(['invalid_credentials','credentials_unavailable','permission_denied','rate_limited'].includes(code)))await finishSyncFailure(db,lease,{code,nextDueAt:nextAt,disable:['invalid_credentials','credentials_unavailable','permission_denied'].includes(code),disableAll:['invalid_credentials','credentials_unavailable'].includes(code),...(code==='rate_limited'?{blockedUntil:nextAt}:{})});
  else if(lease)await releaseSyncLease(db,lease,nextAt);
  await finishPushJob(db,job,fatal?'failed':'retry',{code,attempts,nextAt,progress:['chat_not_found','message_not_found'].includes(code)?{}:job.progress});
 }finally{if(lease)await releaseSyncLease(db,lease,Date.now()+1000);}
}
