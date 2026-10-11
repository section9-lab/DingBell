import { readdirSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { Miniflare } from 'miniflare';
import { hashPassword } from 'better-auth/crypto';
import { createApp } from '../../src/application.ts';
import { services } from '../../src/modules/identity/services.ts';

export async function conversationsFixture() {
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("synthetic conversations")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try {
    const DB=await mf.getD1Database('DB') as unknown as D1Database;
    const folder=new URL('../../migrations/',import.meta.url);
    for(const file of readdirSync(folder).filter(name=>name.endsWith('.sql')).sort()) {
      const statements=readFileSync(new URL(file,folder),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean);
      await DB.batch(statements.map(statement=>DB.prepare(statement)));
    }
    const password='synthetic-conversation-password',hash=await hashPassword(password);
    await DB.prepare("INSERT INTO organization (id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1)").run();
    for(const [id,org,role]of [['owner','company','owner'],['staff','company','member'],['other','other-company','owner']]) await DB.batch([
      DB.prepare('INSERT INTO user (id,name,email,email_verified) VALUES (?,?,?,1)').bind(id,id,`${id}@example.invalid`),
      DB.prepare("INSERT INTO account (id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").bind(`account-${id}`,id,id,hash),
      DB.prepare('INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').bind(`${id}-member`,org,id,role),
    ]);
    const env={DB,APP_BASE_URL:'https://conversations.example.invalid',BETTER_AUTH_SECRET:'synthetic-conversation-auth-secret-at-least-thirty-two'};
    const cookies:Record<string,string>={};
    for(const id of ['owner','staff','other']) {
      const result=await services(env)!.auth.api.signInEmail({body:{email:`${id}@example.invalid`,password},asResponse:true});
      cookies[id]=result.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');
    }
    await DB.batch([
      DB.prepare("INSERT INTO store (id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES ('store-a','company','可见店铺','1','paused',1,1),('store-b','company','其他店铺','2','verified',1,1),('store-c','other-company','Other','3','verified',1,1)"),
      DB.prepare("INSERT INTO store_grant (organization_id,store_id,member_id,created_at) VALUES ('company','store-a','staff-member',1)"),
      DB.prepare("INSERT INTO conversation (id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_at,imported_at) VALUES ('conv-a','company','store-a','18446744073709551615','BUYER_SELLER','Opened',100,300,400),('conv-b','company','store-b','other-thread','BUYER_SELLER','Opened',100,200,400),('conv-empty','company','store-a','empty-thread','BUYER_SELLER','Opened',100,NULL,400),('conv-c','other-company','store-c','private-thread','BUYER_SELLER','Opened',100,500,600)"),
      DB.prepare("INSERT INTO message (id,organization_id,store_id,conversation_id,platform_message_id,sender_id,sender_type,direction,content,is_image,is_read,order_number,sku,event_at,received_at,ingest_mode) VALUES ('msg-a1','company','store-a','conv-a','18446744073709551614','9007199254740993','Customer','inbound','[\"Здравствуйте\",\"<script>not HTML</script>\"]',0,0,'order-1','9007199254740993',200,400,'backfill'),('msg-a2','company','store-a','conv-a','18446744073709551615',NULL,'Seller','outbound','[\"Ответ\"]',0,1,NULL,NULL,300,400,'incremental'),('msg-b','company','store-b','conv-b','secret-message',NULL,'Customer','inbound','[\"Secret store B\"]',0,0,'private-order',NULL,200,400,'backfill')"),
    ]);
    const app=createApp();
    const request=(suffix='',actor='owner',company='company',method='GET')=>app.request(`${env.APP_BASE_URL}/api/companies/${company}/conversations${suffix}`,{method,headers:{cookie:cookies[actor]??''}},env as never);
    return {DB,env,app,cookies,request,close:()=>mf.dispose()};
  } catch (error) {
    await mf.dispose().catch(() => {});
    throw error;
  }
}
