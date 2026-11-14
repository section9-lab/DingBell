import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hashPassword} from 'better-auth/crypto';
import {createApp} from '../src/application.ts';
import {services} from '../src/modules/identity/services.ts';
import {createSqliteD1} from './fixtures/d1-sqlite.ts';

async function fixture(){
  const database=createSqliteD1();
  try{
    const DB=database.db;
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
    const facts=(id:string,offerId:string,name:string)=>JSON.stringify({id,offerId,name,sku:'70001',sources:[{sku:'70001',source:'fbs'}],price:'123.45',currency:'RUB',archived:false,createdAt:'2026-09-15T10:00:00Z'});
    await DB.batch([
      DB.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('100','company','store',?,1000,?,2000,1,1,'complete',9999999999999)").bind(listing('100','offer-100'),facts('100','offer-100','First product')),
      DB.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('200','company','store',?,3000,1,1,'pending',9999999999999)").bind(listing('200','offer-200')),
    ]);
    const posting={postingNumber:'posting-1',orderId:'9001',orderNumber:'order-1',status:'awaiting_deliver',products:[{sku:'70001',offerId:'offer-100',name:'First product',quantity:2,price:'123.45',currency:'RUB'}],orderDate:'2026-10-01T09:30:00Z',inProcessAt:'2026-10-01T10:00:00Z',shipmentDate:'2026-10-02T10:00:00Z',deliveringDate:null,trackingNumber:'TRACK-1'};
    await DB.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES ('posting-1','company','store','9001','order-1',?,4000,?,5000,1,1,'complete',9999999999999)").bind(JSON.stringify(posting),JSON.stringify(posting)).run();
    const app=createApp(),request=(path:string,who='owner')=>app.request(`${env.APP_BASE_URL}/api/companies/company/commerce${path}`,{headers:{cookie:cookies[who]??''}},env as never);
    const post=(path:string,body:unknown,who='owner')=>app.request(`${env.APP_BASE_URL}/api/companies/company/commerce${path}`,{method:'POST',headers:{cookie:cookies[who]??'','content-type':'application/json',origin:env.APP_BASE_URL},body:JSON.stringify(body)},env as never);
    return {DB,request,post,close:database.close};
  }catch(error){database.close();throw error;}
}

test('commerce read API exposes bounded product and FBS views without raw persistence envelopes',{timeout:60_000},async()=>{const f=await fixture();try{
  let response=await f.request('/products?storeId=store&limit=1');assert.equal(response.status,200);let page=await response.json() as {products:Record<string,unknown>[];nextCursor:string|null};
  assert.equal(page.products.length,1);assert.equal(page.products[0]?.name,'First product');assert.equal(page.products[0]?.price,'123.45');assert.ok(page.nextCursor);assert.equal('listing' in page.products[0]!,false);assert.equal('facts' in page.products[0]!,false);
  response=await f.request(`/products?storeId=store&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`);page=await response.json() as typeof page;assert.equal(page.products[0]?.id,'200');assert.equal(page.products[0]?.state,'pending');assert.equal(page.nextCursor,null);
  response=await f.request('/products/100?storeId=store');assert.equal(response.status,200);const product=await response.json() as {product:{sources:unknown[];hasFbsStocks:boolean}};assert.equal(product.product.sources.length,1);assert.equal(product.product.hasFbsStocks,true);
  response=await f.request('/fbs-postings?storeId=store&orderNumber=order-1');assert.equal(response.status,200);const postings=await response.json() as {postings:{postingNumber:string;productCount:number;source:string}[]};assert.equal(postings.postings.length,1);assert.partialDeepStrictEqual(postings.postings[0]!,{postingNumber:'posting-1',productCount:1,source:'details'});
  response=await f.request('/fbs-postings/posting-1?storeId=store');assert.equal(response.status,200);const detail=await response.json() as {posting:{products:{name:string;quantity:number}[];trackingNumber:string}};assert.equal(detail.posting.products.length,1);assert.partialDeepStrictEqual(detail.posting.products[0]!,{name:'First product',quantity:2});assert.equal(detail.posting.trackingNumber,'TRACK-1');
}finally{await f.close();}});

test('product filters match facts, tri-state booleans and empty values with filtered totals',{timeout:60_000},async t=>{
  const f=await fixture();t.after(f.close);
  const list=async(query:string)=>{const response=await f.request(`/products?storeId=store&${query}`);assert.equal(response.status,200);return await response.json() as {products:{id:string}[];totalProducts:number;totalPages:number};};
  let page=await list('name=First');assert.deepEqual(page.products.map(product=>product.id),['100']);assert.equal(page.totalProducts,1);assert.equal(page.totalPages,1);
  page=await list('nameEmpty=1');assert.deepEqual(page.products.map(product=>product.id),['200']);assert.equal(page.totalProducts,1);
  page=await list('priceEmpty=1');assert.deepEqual(page.products.map(product=>product.id),['200']);
  page=await list('priceMin=200');assert.equal(page.totalProducts,0);
  page=await list('priceMax=200');assert.deepEqual(page.products.map(product=>product.id),['100']);
  page=await list('state=pending');assert.deepEqual(page.products.map(product=>product.id),['200']);
  page=await list('offerId=offer-200');assert.deepEqual(page.products.map(product=>product.id),['200']);
  page=await list('sku=70001');assert.equal(page.totalProducts,2);
  page=await list('archived=yes');assert.equal(page.totalProducts,0);
  page=await list('archived=no');assert.equal(page.totalProducts,2);
  page=await list('fbs=yes');assert.equal(page.totalProducts,2);
  page=await list('fbo=yes');assert.equal(page.totalProducts,0);
  page=await list('fbo=empty');assert.equal(page.totalProducts,0);
  page=await list('sourcing=filled');assert.equal(page.totalProducts,0);
  page=await list('sourcing=empty');assert.equal(page.totalProducts,2);
  page=await list('costing=filled');assert.equal(page.totalProducts,0);
  page=await list('costing=empty');assert.equal(page.totalProducts,2);
  page=await list('listedFrom=2026-09-15&listedTo=2026-09-15');assert.deepEqual(page.products.map(product=>product.id),['100']);assert.equal(page.totalProducts,1);
  page=await list('listedEmpty=1');assert.deepEqual(page.products.map(product=>product.id),['200']);
  page=await list('listedFrom=1970-01-01&listedTo=1970-01-01');assert.equal(page.totalProducts,0);
  assert.equal((await f.request('/products?storeId=store&listedFrom=1970-01-02')).status,400);
  assert.equal((await f.request('/products?storeId=store&state=bogus')).status,400);
  assert.equal((await f.request('/products?storeId=store&archived=maybe')).status,400);
  assert.equal((await f.request('/products?storeId=store&priceMin=abc')).status,400);
});

test('FBS totals count distinct orders and all matching parcels across pagination and empty filters',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const add=async(number:string,orderId:string,orderNumber:string,at:number)=>{
  const facts={postingNumber:number,orderId,orderNumber,status:'delivered',products:[],trackingNumber:null,inProcessAt:null,shipmentDate:null,deliveringDate:null,orderDate:at===6000?'2026-10-02T00:00:00Z':'2026-10-03T00:00:00Z'};
  await f.DB.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES(?,'company','store',?,?,?,?,1,1,'pending',9999999999999)").bind(number,orderId,orderNumber,JSON.stringify(facts),at).run();
 };
 await add('posting-2','9001','order-1',6000);await add('posting-3','9002','order-2',7000);
 let cursor:string|null=null;const ids:string[]=[];
 do{const response=await f.request(`/fbs-postings?storeId=store&limit=1${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);assert.equal(response.status,200);const data=await response.json() as any;
  assert.equal(data.totalOrders,2);assert.equal(data.totalPostings,3);assert.equal(data.totalPages,3);assert.equal(data.postings.length,1);ids.push(data.postings[0].postingNumber);cursor=data.nextCursor;
 }while(cursor);
 assert.deepEqual(ids,['posting-3','posting-2','posting-1']);
 const filtered=await(await f.request('/fbs-postings?storeId=store&orderNumber=order-1&limit=1')).json() as any;assert.equal(filtered.totalOrders,1);assert.equal(filtered.totalPostings,2);assert.equal(filtered.totalPages,2);
 const empty=await(await f.request('/fbs-postings?storeId=store&orderNumber=not-found')).json() as any;assert.deepEqual({orders:empty.totalOrders,parcels:empty.totalPostings,pages:empty.totalPages,items:empty.postings,cursor:empty.nextCursor},{orders:0,parcels:0,pages:0,items:[],cursor:null});
});

test('FBS previews and product images use only unambiguous same-store SKUs and safe CDN addresses',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);const image='https://cdn1.ozone.ru/synthetic-product.png';
 await f.DB.prepare("UPDATE product SET listing=json_set(listing,'$.sku','80002') WHERE id='200'").run();
 await f.DB.prepare("UPDATE product SET facts=json_set(facts,'$.primaryImage',?,'$.images',json_array(?)) WHERE id='100'").bind(image,image).run();
 let page=await(await f.request('/fbs-postings?storeId=store')).json() as any;assert.deepEqual(page.postings[0].previewProduct,{sku:'70001',name:'First product',primaryImage:image});
 let detail=await(await f.request('/fbs-postings/posting-1?storeId=store')).json() as any;assert.equal(detail.posting.products[0].primaryImage,image);
 // A different store's same SKU must neither supply nor make this store's image ambiguous.
 await f.DB.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,created_at,updated_at) VALUES('foreign-store','company','Foreign','999',1,1)").run();
 await f.DB.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) SELECT id,organization_id,'foreign-store',listing,list_observed_at,json_set(facts,'$.primaryImage','https://cdn1.ozone.ru/foreign.png'),facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at FROM product WHERE id='100'").run();
 page=await(await f.request('/fbs-postings?storeId=store')).json() as any;assert.equal(page.postings[0].previewProduct.primaryImage,image);
 await f.DB.prepare("UPDATE product SET facts=json_set(facts,'$.primaryImage','https://untrusted.invalid/pixel.png') WHERE id='100' AND store_id='store'").run();
 detail=await(await f.request('/fbs-postings/posting-1?storeId=store')).json() as any;assert.equal(detail.posting.products[0].primaryImage,null);
 await f.DB.prepare("UPDATE product SET facts=json_set(facts,'$.primaryImage',?) WHERE id='100' AND store_id='store'").bind(image).run();
 await f.DB.prepare("UPDATE product SET listing=json_set(listing,'$.sku','70001') WHERE id='200'").run();
 page=await(await f.request('/fbs-postings?storeId=store')).json() as any;assert.equal(page.postings[0].previewProduct.primaryImage,null);
 assert.equal((await f.request('/fbs-postings?storeId=foreign-store','staff')).status,404);
});

test('order center merges FBS/FBO with scoped cursors, exact details and current snapshots',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const facts={postingNumber:'posting-1',orderId:'9002',orderNumber:'fbo-order',orderDate:'2026-10-01T08:00:00Z',status:'delivered',products:[{sku:'70001',offerId:'offer-100',name:'FBO product',quantity:1,price:'1.00',currency:'RUB'}],trackingNumber:null,inProcessAt:null,shipmentDate:null,deliveringDate:null};
 await f.DB.prepare("INSERT INTO fbo_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES('posting-1','company','store','9002','fbo-order',?,5000,1,1,9999999999999)").bind(JSON.stringify(facts)).run();
 const url='/postings?storeId=store&limit=1';
 let response=await f.request(url);assert.equal(response.status,200);const first=await response.json() as any;assert.equal(first.totalOrders,2);assert.equal(first.totalPostings,2);assert.equal(first.postings[0].fulfillmentType,'fbs');assert.ok(first.nextCursor);
 const second=await(await f.request(url+'&cursor='+first.nextCursor)).json() as any;assert.equal(second.postings[0].fulfillmentType,'fbo');assert.equal(second.nextCursor,null);
 assert.equal((await f.request(url+'&fulfillment=fbo&cursor='+first.nextCursor)).status,400);
 assert.equal((await f.request(url+'&orderNumber=fbo-order&cursor='+first.nextCursor)).status,400);
 for(const filter of ['fbs','fbo']){const data=await(await f.request(url+'&fulfillment='+filter)).json() as any;assert.equal(data.totalOrders,1);assert.equal(data.totalPostings,1);assert.equal(data.postings[0].fulfillmentType,filter);}
 const exact=await(await f.request('/postings?storeId=store&orderNumber=fbo-order')).json() as any;assert.equal(exact.postings.length,1);assert.equal(exact.postings[0].fulfillmentType,'fbo');
 // Keyword search matches order and parcel numbers, and escapes LIKE wildcards instead of matching everything.
 const partial=await(await f.request('/postings?storeId=store&q=fbo-ord')).json() as any;assert.equal(partial.totalPostings,1);assert.equal(partial.postings[0].orderNumber,'fbo-order');
 const parcel=await(await f.request('/postings?storeId=store&q=posting-1')).json() as any;assert.equal(parcel.totalPostings,2);
 assert.equal((await(await f.request('/postings?storeId=store&q=%25')).json() as any).totalPostings,0);
 assert.equal((await f.request('/postings?storeId=store&q=fbo-ord&cursor='+first.nextCursor)).status,400);
 // The range follows placement, never the 1970 observation timestamps in this fixture.
 const sameDay=await(await f.request('/postings?storeId=store&fromDate=2026-10-01&toDate=2026-10-01')).json() as any;assert.equal(sameDay.totalPostings,2);
 assert.equal((await(await f.request('/postings?storeId=store&fromDate=1970-01-01&toDate=1970-01-01')).json() as any).totalPostings,0);
 assert.equal((await f.request('/postings?storeId=store&fromDate=1970-01-01')).status,400);
 assert.equal((await f.request('/postings?storeId=store&fromDate=1970-01-02&toDate=1970-01-01')).status,400);
 assert.equal((await f.request('/postings?storeId=store&fromDate=1970-01-01&toDate=1972-01-01')).status,400);
 const detail=await(await f.request('/postings/fbo/posting-1?storeId=store')).json() as any;assert.equal(detail.posting.products[0].name,'FBO product');assert.equal(detail.posting.fulfillmentType,'fbo');
 // An older detail must not overwrite a fresher list status or supply its preview products.
 await f.DB.prepare("UPDATE fbs_posting SET list_observed_at=6000,list_facts=json_set(list_facts,'$.status','cancelled','$.products[0].name','New list product') WHERE store_id='store'").run();
 const fresh=await(await f.request('/postings/fbs/posting-1?storeId=store')).json() as any;assert.equal(fresh.posting.source,'list');assert.equal(fresh.posting.status,'cancelled');assert.equal(fresh.posting.products[0].name,'New list product');
 assert.equal((await f.request('/postings?storeId=store&fulfillment=fbp')).status,200);
 assert.equal((await f.request('/postings?storeId=store&fulfillment=partner')).status,400);
 assert.equal((await f.request('/postings?storeId=store&fulfillment=fbo&fulfillment=fbs')).status,400);
 assert.equal((await f.request(url,'staff')).status,404);assert.equal((await f.request('/postings/fbo/posting-1?storeId=store','other')).status,404);
 await f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company','store','staff-member',1)").run();assert.equal((await f.request(url,'staff')).status,200);
 await f.DB.prepare("DELETE FROM store_grant WHERE member_id='staff-member'").run();assert.equal((await f.request('/postings/fbo/posting-1?storeId=store','staff')).status,404);
});

test('business dates control display, filtering and stable pagination across all fulfillment modes',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 await f.DB.prepare("INSERT INTO company_settings(organization_id,time_zone,version,updated_at) VALUES('company','Europe/Moscow',1,1)").run();
 const add=async(mode:'fbs'|'fbo'|'fbp',number:string,id:string,orderDate:string|null,observedAt:number)=>{
  const facts={postingNumber:number,orderId:id,orderNumber:`order-${id}`,status:'delivered',products:[],orderDate,
   inProcessAt:orderDate?'2026-11-02T09:00:00Z':null,createdAt:null,shipmentDate:null,deliveringDate:null,trackingNumber:null};
  await f.DB.prepare(`INSERT INTO ${mode}_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'company','store',?,?,?,?,1,1,9999999999999)`)
   .bind(number,id,facts.orderNumber,JSON.stringify(facts),observedAt).run();
 };
 await add('fbp','newest','9100','2026-10-03T00:00:00Z',1);
 await add('fbo','boundary','9101','2026-10-01T21:00:00Z',2);
 await add('fbs','missing-date','9102',null,Date.now());
 await add('fbo','missing-date','9103',null,Date.now());
 type Page={postings:{postingNumber:string;fulfillmentType:string;orderDate:string|null}[];nextCursor:string|null;totalOrders:number;totalPostings:number;totalPages:number};
 const read=async(query:string)=>{const response=await f.request('/postings?storeId=store'+query);assert.equal(response.status,200,await response.clone().text());return await response.json() as Page;};
 let cursor:string|null=null;const seen:string[]=[];
 do {
  const page=await read('&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
  assert.equal(page.totalPostings,5);assert.equal(page.totalOrders,5);assert.equal(page.totalPages,5);
  const row=page.postings[0];seen.push(`${row.fulfillmentType}:${row.postingNumber}`);
  if(row.postingNumber==='missing-date')assert.equal(row.orderDate,null,'processing and observation dates cannot replace placement');
  cursor=page.nextCursor;
  // A fresh status-only list must retain the explicitly dated detail and not jump to the front.
  if(seen.length===1)await f.DB.prepare("UPDATE fbs_posting SET list_facts=json_remove(json_set(list_facts,'$.status','cancelled'),'$.orderDate'),list_observed_at=? WHERE posting_number='posting-1'").bind(Date.now()).run();
 }while(cursor);
 assert.deepEqual(seen,['fbp:newest','fbo:boundary','fbs:posting-1','fbs:missing-date','fbo:missing-date']);
 const day=await read('&fromDate=2026-10-02&toDate=2026-10-02');assert.deepEqual(day.postings.map(row=>row.postingNumber),['boundary']);
 assert.equal((await read('&fromDate=2026-10-01&toDate=2026-10-01')).totalPostings,1);
 assert.equal((await read('&fromDate=2026-11-02&toDate=2026-11-02')).totalPostings,0,'a sync/processing date range cannot match');
 const detailResponse=await f.request('/postings/fbs/posting-1?storeId=store');
 const detail=await detailResponse.json() as {posting:{orderDate:string|null;source:string;status:string}};
 assert.equal(detail.posting.orderDate,'2026-10-01T09:30:00Z');assert.equal(detail.posting.source,'list');assert.equal(detail.posting.status,'cancelled');
 const first=await read('&limit=1');assert.ok(first.nextCursor);
 const legacy=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString()) as Record<string,unknown>;legacy.v=1;legacy.observedAt=0;
 assert.equal((await f.request('/postings?storeId=store&cursor='+Buffer.from(JSON.stringify(legacy)).toString('base64url'))).status,400);
});

test('June-to-present filtering retains FBS/FBO business dates instead of silently counting only FBP',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const add=async(mode:'fbs'|'fbo'|'fbp',number:string,id:string,times:{orderDate?:string;createdAt?:string;inProcessAt?:string})=>{
  const facts={postingNumber:number,orderId:id,orderNumber:`order-${id}`,status:'delivered',products:[],trackingNumber:null,shipmentDate:null,deliveringDate:null,...times};
  await f.DB.prepare(`INSERT INTO ${mode}_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'company','store',?,?,?,?,1,1,9999999999999)`)
   .bind(number,id,facts.orderNumber,JSON.stringify(facts),Date.parse('2026-11-02T09:00:00Z')).run();
 };
 await add('fbs','fbs-legacy','9201',{inProcessAt:'2026-06-02T12:00:00Z'});
 await add('fbo','fbo-created','9202',{createdAt:'2026-06-01T23:00:00Z',inProcessAt:'2026-07-01T00:00:00Z'});
 await add('fbo','fbo-legacy','9203',{inProcessAt:'2026-08-01T12:00:00Z'});
 await add('fbp','fbp-dated','9204',{orderDate:'2026-07-02T12:00:00Z',inProcessAt:'2026-07-03T00:00:00Z'});
 await add('fbs','undated','9205',{});
 type Page={totalOrders:number;totalPostings:number;totalPages:number;undatedPostings:number;nextCursor:string|null;postings:{postingNumber:string;fulfillmentType:string;orderDate:string|null;orderTime:string|null;orderTimeSource:string|null}[]};
 const read=async(query:string)=>{const response=await f.request('/postings?storeId=store'+query);assert.equal(response.status,200,await response.clone().text());return await response.json() as Page;};
 const all=await read('');assert.equal(all.totalPostings,6);assert.equal(all.undatedPostings,1);
 const juneToNow=await read('&fromDate=2026-06-01&toDate=2026-11-02');assert.equal(juneToNow.totalPostings,5);assert.equal(juneToNow.totalOrders,5);assert.equal(juneToNow.undatedPostings,1);
 assert.deepEqual(new Set(juneToNow.postings.map(row=>row.fulfillmentType)),new Set(['fbs','fbo','fbp']));
 const fbs=juneToNow.postings.find(row=>row.postingNumber==='fbs-legacy');assert.equal(fbs?.orderDate,null);assert.equal(fbs?.orderTime,'2026-06-02T12:00:00Z');assert.equal(fbs?.orderTimeSource,'in_process_at');
 const fbo=juneToNow.postings.find(row=>row.postingNumber==='fbo-created');assert.equal(fbo?.orderTime,'2026-06-01T23:00:00Z');assert.equal(fbo?.orderTimeSource,'created_at');
 assert.equal(juneToNow.postings.find(row=>row.postingNumber==='fbo-legacy')?.orderTimeSource,'in_process_at');
 assert.equal(juneToNow.postings.find(row=>row.postingNumber==='fbp-dated')?.orderTimeSource,'order_date');
 assert.equal((await read('&fromDate=2026-06-01&toDate=2026-06-30')).totalPostings,2,'FBO uses creation, not its later processing timestamp');
 let cursor:string|null=null;const ids:string[]=[];
 do{const page=await read('&fromDate=2026-06-01&toDate=2026-11-02&limit=1'+(cursor?'&cursor='+cursor:''));assert.equal(page.totalPostings,5);assert.equal(page.totalPages,5);ids.push(page.postings[0].postingNumber);cursor=page.nextCursor;}while(cursor);
 assert.equal(new Set(ids).size,5);assert.equal((await read('&fromDate=2026-01-01&toDate=2026-01-02')).undatedPostings,1,'unknown count survives empty date results');
 const detail=await(await f.request('/postings/fbs/fbs-legacy?storeId=store')).json() as {posting:{orderTime:string;orderTimeSource:string;orderDate:null}};
 assert.equal(detail.posting.orderTime,fbs?.orderTime);assert.equal(detail.posting.orderTimeSource,'in_process_at');assert.equal(detail.posting.orderDate,null);
});

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

test('merchant-maintained sourcing facts stay outside platform snapshots and require an administrator',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 const first=await(await f.request('/products/100?storeId=store')).json() as any;assert.equal(first.product.sourcing,null);
 const response=await f.post('/products/100/sourcing',{storeId:'store',supplySource:'1688 · 义乌玩具厂',purchaseUrl:'https://detail.1688.com/offer/620000000001.html',purchasePrice:'38.50',purchaseCurrency:'CNY'});
 assert.equal(response.status,200);assert.partialDeepStrictEqual((await response.json() as any).sourcing,{supplySource:'1688 · 义乌玩具厂',purchaseUrl:'https://detail.1688.com/offer/620000000001.html',purchasePrice:'38.50',purchaseCurrency:'CNY',updatedByName:'owner'});
 assert.equal((await f.DB.prepare("SELECT json_extract(facts,'$.price') AS price FROM product WHERE id='100'").first() as any).price,'123.45');
 assert.partialDeepStrictEqual(((await(await f.request('/products?storeId=store')).json() as any).products.find((row:any)=>row.id==='100')).sourcing,{supplySource:'1688 · 义乌玩具厂',purchaseUrl:'https://detail.1688.com/offer/620000000001.html',purchasePrice:'38.50',purchaseCurrency:'CNY'});
 await f.post('/products/100/sourcing',{storeId:'store',supplySource:'1688 · 新供应商',purchaseUrl:'https://www.1688.com/',purchasePrice:'40',purchaseCurrency:'RUB'});
 assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM product_sourcing").first() as any).count,1);
 const updated=(await(await f.request('/products/100?storeId=store')).json() as any).product.sourcing;
 assert.equal(updated.purchasePrice,'40');assert.equal(updated.purchaseUrl,'https://www.1688.com/');
 for(const body of [{storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:'40',purchaseCurrency:null},{storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:'0',purchaseCurrency:'CNY'},
  {storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:'1,5',purchaseCurrency:'CNY'},{storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:'1.234567',purchaseCurrency:'CNY'},
  {storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:null,purchaseCurrency:'CNY'},{storeId:'store',supplySource:'x '.repeat(101),purchaseUrl:null,purchasePrice:null,purchaseCurrency:null},
  {storeId:'store',supplySource:'',purchaseUrl:null,purchasePrice:null,purchaseCurrency:null},{storeId:'store',supplySource:'ok',purchaseUrl:null,purchasePrice:null,purchaseCurrency:null,extra:'x'},
  {storeId:'store',supplySource:null,purchaseUrl:'javascript:alert(1)',purchasePrice:null,purchaseCurrency:null},{storeId:'store',supplySource:null,purchaseUrl:'detail.1688.com/offer/1',purchasePrice:null,purchaseCurrency:null},
  {storeId:'store',supplySource:null,purchaseUrl:'https://buyer:secret@1688.com/offer/1',purchasePrice:null,purchaseCurrency:null},{storeId:'store',supplySource:null,purchaseUrl:'https://1688.com/'+'a'.repeat(2050),purchasePrice:null,purchaseCurrency:null},
  {storeId:'store',supplySource:null,purchaseUrl:'https://1688.com/offer 1',purchasePrice:null,purchaseCurrency:null}])
  assert.equal((await f.post('/products/100/sourcing',body)).status,400,JSON.stringify(body));
 await f.DB.prepare("INSERT INTO store_grant(organization_id,store_id,member_id,created_at) VALUES('company','store','staff-member',1)").run();
 assert.partialDeepStrictEqual(((await(await f.request('/products?storeId=store','staff')).json() as any).products.find((row:any)=>row.id==='100')).sourcing,{supplySource:'1688 · 新供应商',purchaseUrl:'https://www.1688.com/',purchasePrice:'40',purchaseCurrency:'RUB'});
 assert.equal((await f.post('/products/100/sourcing',{storeId:'store',supplySource:'x',purchaseUrl:null,purchasePrice:null,purchaseCurrency:null},'staff')).status,403);
 assert.equal((await f.post('/products/100/sourcing',{storeId:'store',supplySource:'x',purchaseUrl:null,purchasePrice:null,purchaseCurrency:null},'other')).status,404);
 assert.equal((await f.post('/products/200/sourcing',{storeId:'foreign-store',supplySource:'x',purchaseUrl:null,purchasePrice:null,purchaseCurrency:null})).status,404);
 // A link alone is a valid record; clearing every field removes the row instead of keeping an empty one.
 const linkOnly=await f.post('/products/100/sourcing',{storeId:'store',supplySource:null,purchaseUrl:'https://detail.1688.com/offer/1.html',purchasePrice:null,purchaseCurrency:null});
 assert.equal(linkOnly.status,200);assert.equal((await linkOnly.json() as any).sourcing.purchaseUrl,'https://detail.1688.com/offer/1.html');
 assert.equal((await f.post('/products/100/sourcing',{storeId:'store',supplySource:null,purchaseUrl:null,purchasePrice:null,purchaseCurrency:null})).status,200);
 assert.equal(((await(await f.request('/products/100?storeId=store')).json() as any).product.sourcing),null);
 assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM product_sourcing").first() as any).count,0);
});

test('spreadsheet sourcing without a user account does not break product lists or details',{timeout:60_000},async t=>{
 const f=await fixture();t.after(f.close);
 await f.DB.prepare("INSERT INTO product_sourcing(organization_id,store_id,product_id,supply_source,purchase_price,purchase_currency,updated_at,updated_by) VALUES('company','store','100','成本表导入','7.00','CNY',1,'spreadsheet-import')").run();
 type Product={id:string;sourcing:{purchasePrice:string;updatedByName:string}};
 const list=await f.request('/products?storeId=store');assert.equal(list.status,200);const products=(await list.json() as {products:Product[]}).products;
 assert.equal(products.length,2);assert.equal(products[0]!.sourcing.purchasePrice,'7.00');assert.equal(products[0]!.sourcing.updatedByName,'导入记录（原操作人不可用）');
 const detail=await f.request('/products/100?storeId=store');assert.equal(detail.status,200);assert.equal((await detail.json() as {product:Product}).product.sourcing.purchasePrice,'7.00');
});
