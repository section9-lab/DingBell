import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {test} from 'node:test';
import {URL} from 'node:url';
import {hashPassword} from 'better-auth/crypto';
import {Miniflare} from 'miniflare';
import {createApp} from '../src/application.ts';
import {services} from '../src/modules/identity/services.ts';

async function fixture(){
  const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("commerce")}}',compatibilityDate:'2026-06-01',d1Databases:{DB:crypto.randomUUID()}});
  try{
    const DB=await mf.getD1Database('DB') as unknown as D1Database,dir=new URL('../migrations/',import.meta.url);
    for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())for(const statement of readFileSync(new URL(name,dir),'utf8').split('--> statement-breakpoint').map(value=>value.trim()).filter(Boolean))await DB.prepare(statement).run();
    const password='synthetic-commerce-password',hash=await hashPassword(password);
    await DB.prepare("INSERT INTO organization(id,name,slug,created_at) VALUES ('company','Company','company',1),('other-company','Other','other',1)").run();
    for(const [id,organization,role] of [['owner','company','owner'],['staff','company','member'],['other','other-company','owner']])await DB.batch([
      DB.prepare('INSERT INTO user(id,name,email,email_verified) VALUES (?,?,?,1)').bind(id,id,`${id}@example.invalid`),
      DB.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES (?,?,'credential',?,?,1)").bind(`account-${id}`,id,id,hash),
      DB.prepare('INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES (?,?,?,?,1)').bind(`${id}-member`,organization,id,role),
    ]);
    const env={DB,APP_BASE_URL:'https://commerce.example.invalid',BETTER_AUTH_SECRET:'synthetic-commerce-secret-at-least-thirty-two'};
    const cookies:Record<string,string>={};for(const id of ['owner','staff','other']){const response=await services(env)!.auth.api.signInEmail({body:{email:`${id}@example.invalid`,password},asResponse:true});cookies[id]=response.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');}
    await DB.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES ('store','company','MIRAVA Shop','5476375',1,1)").run();
    const listing=(id:string,offerId:string)=>JSON.stringify({id,offerId,sku:'70001',archived:false,hasFboStocks:false,hasFbsStocks:true});
    const facts=(id:string,offerId:string,name:string)=>JSON.stringify({id,offerId,name,sku:'70001',sources:[{sku:'70001',source:'fbs'}],price:'123.45',currency:'RUB',archived:false});
    await DB.batch([
      DB.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('100','company','store',?,1000,?,2000,1,1,'complete',9999999999999)").bind(listing('100','offer-100'),facts('100','offer-100','First product')),
      DB.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('200','company','store',?,3000,1,1,'pending',9999999999999)").bind(listing('200','offer-200')),
    ]);
    const posting={postingNumber:'posting-1',orderId:'9001',orderNumber:'order-1',status:'awaiting_deliver',products:[{sku:'70001',offerId:'offer-100',name:'First product',quantity:2,price:'123.45',currency:'RUB'}],inProcessAt:'2026-10-01T10:00:00Z',shipmentDate:'2026-10-02T10:00:00Z',deliveringDate:null,trackingNumber:'TRACK-1'};
    await DB.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('posting-1','company','store','9001','order-1',?,4000,?,5000,1,1,'complete',9999999999999)").bind(JSON.stringify(posting),JSON.stringify(posting)).run();
    const app=createApp(),request=(path:string,who='owner')=>app.request(`${env.APP_BASE_URL}/api/companies/company/commerce${path}`,{headers:{cookie:cookies[who]??''}},env as never);
    return {DB,request,close:()=>mf.dispose()};
  }catch(error){await mf.dispose().catch(()=>{});throw error;}
}

test('commerce read API exposes bounded product and FBS views without raw persistence envelopes',{timeout:60_000},async()=>{const f=await fixture();try{
  let response=await f.request('/products?storeId=store&limit=1');assert.equal(response.status,200);let page=await response.json() as {products:Record<string,unknown>[];nextCursor:string|null};
  assert.equal(page.products.length,1);assert.equal(page.products[0]?.name,'First product');assert.equal(page.products[0]?.price,'123.45');assert.ok(page.nextCursor);assert.equal('listing' in page.products[0]!,false);assert.equal('facts' in page.products[0]!,false);
  response=await f.request(`/products?storeId=store&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`);page=await response.json() as typeof page;assert.equal(page.products[0]?.id,'200');assert.equal(page.products[0]?.state,'pending');assert.equal(page.nextCursor,null);
  response=await f.request('/products/100?storeId=store');assert.equal(response.status,200);const product=await response.json() as {product:{sources:unknown[];hasFbsStocks:boolean}};assert.equal(product.product.sources.length,1);assert.equal(product.product.hasFbsStocks,true);
  response=await f.request('/fbs-postings?storeId=store&orderNumber=order-1');assert.equal(response.status,200);const postings=await response.json() as {postings:{postingNumber:string;productCount:number;source:string}[]};assert.equal(postings.postings.length,1);assert.partialDeepStrictEqual(postings.postings[0]!,{postingNumber:'posting-1',productCount:1,source:'details'});
  response=await f.request('/fbs-postings/posting-1?storeId=store');assert.equal(response.status,200);const detail=await response.json() as {posting:{products:{name:string;quantity:number}[];trackingNumber:string}};assert.equal(detail.posting.products.length,1);assert.partialDeepStrictEqual(detail.posting.products[0]!,{name:'First product',quantity:2});assert.equal(detail.posting.trackingNumber,'TRACK-1');
}finally{await f.close();}});

test('commerce reads bind cursors, company sessions and current store grants',{timeout:60_000},async()=>{const f=await fixture();try{
  assert.equal((await f.request('/products?storeId=store','anonymous')).status,401);
  assert.equal((await f.request('/products?storeId=store','staff')).status,404);
  assert.equal((await f.request('/products?storeId=store','other')).status,404);
  await f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES ('company','store','staff-member',1)").run();
  assert.equal((await f.request('/products?storeId=store','staff')).status,200);assert.equal((await f.request('/fbs-postings?storeId=store','staff')).status,200);
  const first=await (await f.request('/products?storeId=store&limit=1')).json() as {nextCursor:string|null};
  assert.equal((await f.request('/products?storeId=store&cursor=not-a-cursor')).status,400);
  assert.ok(first.nextCursor);assert.equal((await f.request(`/fbs-postings?storeId=store&orderNumber=other&cursor=${encodeURIComponent(first.nextCursor!)}`)).status,400);
  assert.equal((await f.request('/products?storeId=store&extra=1')).status,400);
  await f.DB.prepare("DELETE FROM store_grant WHERE store_id='store'").run();assert.equal((await f.request('/products?storeId=store','staff')).status,404);
}finally{await f.close();}});
