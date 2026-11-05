import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {hashPassword} from 'better-auth/crypto';
import {serveNode} from '../../src/platform/node/server.ts';
import {capabilityCodes} from '../../src/modules/stores/ozon.ts';
import {conversationHistoryFixture} from './web-identity/conversation-history.ts';

let assets:Promise<string>|undefined;
export function browserClientAssets(){return assets??=(async()=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-browser-client-'));process.once('exit',()=>rmSync(directory,{recursive:true,force:true}));
 const child=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'build','--config','deploy/node/vite.config.ts','--outDir',directory],{cwd:resolve('.'),stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,CI:'true'}});let diagnostics='';for(const stream of[child.stdout!,child.stderr!])stream.on('data',chunk=>{diagnostics=(diagnostics+String(chunk)).slice(-5000);});const [code]=await once(child,'exit');assert.equal(code,0,diagnostics);return directory;
})();}
export async function startNodeBrowserApplication(){
 const assetsDirectory=await browserClientAssets(),directory=await mkdtemp(join(tmpdir(),'dingbell-browser-data-'));
 const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const address=probe.address();assert.ok(address&&typeof address==='object');const port=address.port;await new Promise<void>(done=>probe.close(()=>done()));
 const baseURL=`http://127.0.0.1:${port}`,password=crypto.randomUUID()+'Aa1!',now=Date.now(),storeRequests:{path:string;method:string;body:Record<string,unknown>}[]=[],replyRequests:typeof storeRequests=[];
 let readOverride:boolean|undefined,running:Awaited<ReturnType<typeof serveNode>>|undefined;
 const products=['9000000000817031941','9000000000817031942','9000000000817031943'];
 const commerceFetch=(async(input,init)=>{
  const path=new URL(String(input)).pathname,body=JSON.parse(String(init?.body??'{}'),(key:string,value:unknown,context?:{source?:string})=>key==='from_message_id'&&typeof value==='number'?context?.source:value) as Record<string,unknown>;storeRequests.push({path,method:init?.method??'GET',body});
  if(path==='/v1/chat/send/message'){replyRequests.push({path,method:'POST',body});return Response.json({result:'success'});}
  if(path==='/v1/roles')return Response.json({roles:[]});
  if(path==='/v3/product/info/list')return Response.json({items:Array.isArray(body.product_id)?body.product_id.filter(id=>products.includes(String(id))).map(id=>({id,offer_id:`SYN-${id}`,name:'合成测试商品',sku:id,sources:[{sku:id,source:'fbs'}],price:'15.5000',currency_code:'RUB',is_archived:false})):[]});
  if(path==='/v3/product/list'){
   const filter=body.filter as {product_id?:string[]}|undefined,targeted=filter?.product_id,ids=targeted?targeted.filter(id=>products.includes(id)):body.last_id?[]:products.slice(0,Number(body.limit)||100);
   return Response.json({result:{items:ids.map(id=>({product_id:id,offer_id:`SYN-${id}`,archived:false,has_fbs_stocks:true,has_fbo_stocks:false})),last_id:targeted?'':ids.length?'catalog-end':'',total:ids.length}});
  }
  if(path==='/v3/chat/list')return Response.json({chats:[{chat:{chat_id:'buyer-a',chat_type:'BUYER_SELLER',chat_status:'Opened',created_at:'2026-10-09T09:00:00Z'},last_message_id:null,unread_count:0}],has_next:false});
  if(path==='/v3/chat/history'){
   const rows=running?.app.database.sqlite.prepare(`SELECT m.* FROM message m JOIN conversation c ON c.id=m.conversation_id JOIN store s ON s.id=m.store_id WHERE c.platform_thread_id=? AND s.platform_store_id=? ORDER BY m.event_at DESC,m.id DESC LIMIT 100`).all(String(body.chat_id),new Headers(init?.headers).get('Client-Id')??'')??[];
   return Response.json({has_next:false,messages:rows.map(row=>({message_id:row.platform_message_id,created_at:new Date(Number(row.event_at)).toISOString(),user:{id:row.sender_id,type:row.sender_type},data:JSON.parse(String(row.content)),is_image:!!row.is_image,is_read:readOverride??!!row.is_read,context:{order_number:row.order_number,sku:row.sku}}))});
  }
  if(['/v4/posting/fbs/list','/v3/posting/fbo/list'].includes(path))return Response.json({postings:[],has_next:false});
  if(path==='/v1/posting/fbp/list')return Response.json({postings:[],cursor:''});
  return new Response('{}',{status:501});
 }) as typeof fetch;
 try{
  running=await serveNode({dataDirectory:directory,migrationsDirectory:resolve('migrations'),assetsDirectory,port,hostname:'127.0.0.1',variables:{APP_BASE_URL:baseURL,BETTER_AUTH_SECRET:crypto.randomUUID()+crypto.randomUUID(),STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,17).toString('base64')}),OUTBOUND_ENABLED:'true',AI_OUTBOUND_ENABLED:'false'},commerceFetch,dependencies:{storeFetch:commerceFetch,mailer:async()=>({id:'synthetic-mail'})}});
  const db=running.app.database,hash=await hashPassword(password);
  db.sqlite.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('company-a','测试公司 A','company-a',1),('company-b','测试公司 B','company-b',1)`);
  for(const [id,email,role]of[['web-owner','owner@example.invalid','owner'],['web-member','member@example.invalid','member']] as const)await db.batch([
   db.prepare('INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,1,?,?)').bind(id,id,email,now,now),
   db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,'credential',?,?,?,?)").bind('account-'+id,id,id,hash,now,now),
   db.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES(?,?,?,?,?)').bind(role==='owner'?'owner-a':'member-a','company-a',id,role,now),
  ]);
  return {baseURL,password,storeRequests,replyRequests,setPlatformRead(value:boolean){readOverride=value;},
   async prepareReplyStore(storeId:string){assert.match(storeId,/^[a-f0-9-]{36}$/);await db.prepare("UPDATE store SET status='verified',outbound_enabled=1,checked_at=?,expires_at=?,capabilities=? WHERE id=? AND organization_id='company-a'").bind(Date.now(),Date.now()+3600000,JSON.stringify(capabilityCodes.map(code=>({code,status:'available',reason:'synthetic'}))),storeId).run();},
   async seedConversationHistory(storeId:string,options:Parameters<typeof conversationHistoryFixture>[1]={}){const history=conversationHistoryFixture(storeId,options);db.sqlite.exec(history.seedSQL);return {...history,async appendMessage(){db.sqlite.exec(history.appendSQL);},async appendMessages(first:number,count:number,eventAt?:number){db.sqlite.exec(history.appendBatchSQL(first,count,eventAt));}};},
   async rejoinFixtureMember(storeId:string){assert.match(storeId,/^[a-f0-9-]{36}$/);db.sqlite.exec(`DELETE FROM member WHERE id='member-a' AND organization_id='company-a';INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member-a-rejoined','company-a','web-member','member',${Date.now()});INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company-a','${storeId}','member-a-rejoined',${Date.now()})`);},
   async close(){running!.server.closeAllConnections();await running!.close();await rm(directory,{recursive:true,force:true});},
  };
 }catch(error){running?.server.closeAllConnections();await running?.close();await rm(directory,{recursive:true,force:true});throw error;}
}
