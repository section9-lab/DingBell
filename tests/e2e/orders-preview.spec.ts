import {test as base,expect} from '@playwright/test';
import type {Page} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {serveNode} from '../../src/platform/node/server.ts';
const password='synthetic-orders-preview-password';
// The order center keeps every filter behind one collapsed panel; tests drive it the same way a user does.
async function search(page:Page,fields:{fulfillment?:string;query?:string;preset?:string}){
 await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();
 if(fields.fulfillment!==undefined)await page.getByRole('button',{name:fields.fulfillment,exact:true}).click();
 if(fields.query!==undefined)await page.getByLabel('订单号 / 包裹号',{exact:true}).fill(fields.query);
 if(fields.preset!==undefined)await page.getByRole('button',{name:fields.preset,exact:true}).click();
 await page.getByRole('button',{name:'应用筛选',exact:true}).click();
 await expect(page.getByRole('button',{name:'应用筛选',exact:true})).toBeHidden();
}
const image='https://cdn1.ozone.ru/orders-synthetic.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64');
const test=base.extend<{application:{baseURL:string;addFbp:()=>void}}> ({application:async({},use)=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-orders-preview-')),variables={APP_BASE_URL:'http://127.0.0.1:0',BETTER_AUTH_SECRET:'synthetic-orders-preview-identity-more-than-32-characters'};
 const runtime=await serveNode({dataDirectory:folder,migrationsDirectory:resolve('migrations'),assetsDirectory:resolve('dist/node/client'),hostname:'127.0.0.1',port:0,variables});
 try{
  const address=runtime.server.address();if(!address||typeof address==='string')throw new Error('Missing local port');const baseURL=`http://127.0.0.1:${address.port}`;variables.APP_BASE_URL=baseURL;runtime.app.env.APP_BASE_URL=baseURL;
  const db=runtime.app.database.sqlite;db.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('orders-company','订单测试公司','orders-company',1);
   INSERT INTO user(id,name,email,email_verified) VALUES('orders-owner','测试管理员','orders@example.invalid',1);
   INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('orders-member','orders-company','orders-owner','owner',1);
   INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('orders-store','orders-company','订单测试店','1','verified',1,1);`);
  db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('orders-account','orders-owner','credential','orders-owner',?,1)").run(await hashPassword(password));
  for(const [id,sku,url] of [['100','70001',image],['200','70003','https://cdn1.ozone.ru/broken.png']]){
   db.prepare("INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,facts,facts_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES(?,'orders-company','orders-store',?,1,?,1,1,1,'complete',9999999999999)").run(id,JSON.stringify({id,offerId:`offer-${id}`,sku}),JSON.stringify({id,offerId:`offer-${id}`,sku,primaryImage:url,images:[url]}));
  }
  for(let index=0;index<26;index++){
   const orderId=String(Math.max(1,index)),postingNumber=`posting-${String(index).padStart(2,'0')}`,product={sku:'70001',offerId:'offer-100',name:'首件测试商品',quantity:1,price:'10',currency:'RUB'};
   const facts={postingNumber,orderId,orderNumber:`order-${orderId}`,orderDate:null,status:'delivered',products:index===25?[product,{...product,sku:'70003',name:'加载失败商品'},{...product,sku:'70002',name:'未匹配商品'}]:[product],trackingNumber:null,inProcessAt:index===0?null:new Date(Date.parse('2026-10-01T10:00:00Z')+index*60_000).toISOString(),shipmentDate:null,deliveringDate:null};
   db.prepare("INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES(?,'orders-company','orders-store',?,?,?,?,1,1,'complete',9999999999999)").run(postingNumber,orderId,facts.orderNumber,JSON.stringify(facts),Date.parse('2026-11-02T10:00:00Z')+index);
  }
  for(const [postingNumber,orderId] of [['posting-25','9001'],['fbo-02','9002']]){
   const facts={postingNumber,orderId,orderNumber:`fbo-order-${orderId}`,createdAt:'2026-10-03T09:00:00Z',status:'delivered',products:[{sku:'70001',offerId:'offer-100',name:'FBO 测试商品',quantity:2,price:'20.00',currency:'RUB'}],trackingNumber:null,inProcessAt:null,shipmentDate:null,deliveringDate:null};
   db.prepare("INSERT INTO fbo_posting(posting_number,organization_id,store_id,order_id,order_number,list_facts,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES(?,'orders-company','orders-store',?,?,?,?,1,1,9999999999999)").run(postingNumber,orderId,facts.orderNumber,JSON.stringify(facts),100);
  }
  await use({baseURL,addFbp:()=>{
   for(const [postingNumber,orderId,orderNumber] of [['posting-25','25','order-25'],['fbp-only','9003','partner-order']]){
    const facts={postingNumber,orderId,orderNumber,status:'12',statusIsCode:true,substatus:'provider_specific_status',orderDate:'2026-10-01T00:00:00Z',products:[{sku:'70001',offerId:'offer-100',name:'合作仓测试商品',quantity:1,price:'12.34567890',currency:'RUB'}],trackingNumber:null,inProcessAt:null,shipmentDate:null,deliveringDate:null};
    db.prepare("INSERT INTO fbp_posting(posting_number,organization_id,store_id,order_id,order_number,detail_facts,detail_observed_at,detail_epoch,detail_generation,detail_state,detail_due_at) VALUES(?,'orders-company','orders-store',?,?,?,?,1,1,'complete',9999999999999)").run(postingNumber,orderId,orderNumber,JSON.stringify(facts),101);
   }
  }});
 }finally{await runtime.close();await rm(folder,{recursive:true,force:true});}
}});

test('order center merges modes without sync cards or polling, keeps filters and exact FBO links',async({page,application})=>{
 const syncRequests:string[]=[];page.on('request',request=>{if(/\/sync\/(fbs|fbo|fbp)-postings(?:$|\?)/.test(request.url()))syncRequests.push(request.url());});
 await page.route('https://cdn1.ozone.ru/**',route=>route.fulfill({status:200,contentType:'image/png',body:png}));
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('orders@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 const company=page.getByRole('button',{name:'订单测试公司',exact:true});await expect(company).toBeVisible();await company.click();await page.goto(application.baseURL+'/workspace/orders?store=orders-store');
 await expect(page.getByRole('heading',{name:'订单中心',exact:true})).toBeVisible();
 const counts=page.getByRole('status',{name:'订单统计',exact:true});await expect(counts).toContainText('27 个订单 · 28 个包裹');
 await expect(page.getByText(/^(FBS|FBO|FBP) ·/)).toHaveCount(0);
 await expect(page.getByRole('link',{name:/^回补 (FBS|FBO|FBP) 历史订单$/})).toHaveCount(0);
 await expect(page.getByRole('link',{name:'同步设置',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();await page.getByRole('button',{name:'FBO',exact:true}).click();await page.getByRole('button',{name:'应用筛选',exact:true}).click();await expect(counts).toContainText('2 个订单 · 2 个包裹');await expect(page).toHaveURL(/fulfillment=fbo/);
 await page.reload();await expect(page.getByRole('button',{name:'搜索与筛选',exact:true})).toContainText('1');await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();await expect(page.getByRole('button',{name:'FBO',exact:true})).toHaveAttribute('aria-pressed','true');await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'应用筛选',exact:true})).toBeHidden();
 await search(page,{query:'fbo-order-9001'});await expect(counts).toContainText('1 个订单 · 1 个包裹');
 const row=page.getByRole('row').filter({hasText:'包裹 posting-25'});await expect(row.getByText('FBO',{exact:true})).toBeVisible();await row.getByRole('button',{name:'查看详情',exact:true}).click();await expect(page).toHaveURL(/type=fbo/);
 await expect(page.getByText('FBO 测试商品',{exact:true})).toBeVisible();await expect(page.getByText('计划发货',{exact:true})).toHaveCount(0);
 await page.reload();await expect(page.getByText('FBO 测试商品',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'← 返回订单列表',exact:true}).click();await expect(counts).toContainText('1 个订单 · 1 个包裹');
 await page.getByRole('button',{name:'清除筛选',exact:true}).click();await expect(counts).toContainText('2 个订单 · 2 个包裹');
 await search(page,{fulfillment:'全部',query:''});await expect(counts).toContainText('27 个订单 · 28 个包裹');
 await page.reload();await expect(counts).toContainText('27 个订单 · 28 个包裹');await expect(page.getByText(/^(FBS|FBO|FBP) ·/)).toHaveCount(0);expect(syncRequests).toEqual([]);
});

test('FBS previews, distinct totals, page counts and exact-order filtering stay consistent',async({page,application})=>{
 await page.route('https://cdn1.ozone.ru/**',route=>route.request().url().endsWith('/broken.png')?route.fulfill({status:404,body:'missing'}):route.fulfill({status:200,contentType:'image/png',body:png}));
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('orders@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 const company=page.getByRole('button',{name:'订单测试公司',exact:true});await expect(company).toBeVisible();await company.click();await page.goto(application.baseURL+'/workspace/orders?store=orders-store');
 await search(page,{fulfillment:'FBS'});
 const counts=page.getByRole('status',{name:'订单统计',exact:true});await expect(counts).toHaveText('当前店铺已同步 25 个订单 · 26 个包裹 · 共 2 页（已同步范围，非平台全部历史）');
 await expect(page.getByText('第 1 页 / 共 2 页',{exact:true})).toBeVisible();
 const first=page.getByRole('row').filter({hasText:'包裹 posting-25'});await expect(first.getByRole('img',{name:'首件测试商品',exact:true})).toHaveAttribute('src',image);await expect(first.getByText('首件商品预览 · 共 3 项',{exact:true})).toBeVisible();
 await first.getByRole('button',{name:'查看详情',exact:true}).click();await expect(page.getByRole('heading',{name:'包裹商品',exact:true})).toBeVisible();
 await expect(page.getByRole('img',{name:'首件测试商品',exact:true})).toHaveAttribute('referrerpolicy','no-referrer');await expect(page.getByRole('img',{name:'加载失败商品，暂无图片',exact:true})).toBeVisible();await expect(page.getByRole('img',{name:'未匹配商品，暂无图片',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'← 返回订单列表',exact:true}).click();await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeEnabled();await page.getByRole('button',{name:'下一页',exact:true}).click();
 await expect(page.getByText('第 2 页 / 共 2 页',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'下一页',exact:true})).toBeDisabled();await expect(counts).toContainText('25 个订单 · 26 个包裹');await expect(page.getByRole('button',{name:'查看详情',exact:true})).toHaveCount(1);
 await search(page,{query:'posting-07'});await expect(counts).toHaveText('当前筛选匹配 1 个订单 · 1 个包裹 · 共 1 页');await expect(page.getByText('第 1 页 / 共 1 页',{exact:true})).toBeVisible();
 await search(page,{query:'does-not-exist'});await expect(counts).toHaveText('当前筛选匹配 0 个订单 · 0 个包裹 · 共 0 页');await expect(page.getByText('没有匹配订单',{exact:true})).toBeVisible();
});

test('June-to-present filters retain FBS processing and FBO creation timestamps and disclose unknown dates',async({page,application})=>{
 await page.route('https://cdn1.ozone.ru/**',route=>route.fulfill({status:200,contentType:'image/png',body:png}));
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('orders@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'订单测试公司',exact:true}).click();await page.goto(application.baseURL+'/workspace/orders?store=orders-store');
 await expect(page.getByRole('columnheader',{name:'订单时间',exact:true})).toBeVisible();
 await expect(page.getByText('同步快照',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();
 await expect(page.getByText('订单时间',{exact:true})).toHaveCount(2);
 await expect(page.getByText('同步时间',{exact:true})).toHaveCount(0);
 await page.getByLabel('开始日期',{exact:true}).fill('2026-06-01');await page.getByLabel('结束日期',{exact:true}).fill('2026-11-02');
 await page.getByRole('button',{name:'应用筛选',exact:true}).click();
 const counts=page.getByRole('status',{name:'订单统计',exact:true});await expect(counts).toContainText('27 个订单 · 27 个包裹');
 await expect(page.getByText(/另有 1 个包裹未获取到任何订单时间/)).toBeVisible();
 await expect(page.getByRole('row').filter({hasText:'包裹 fbo-02'})).toContainText('创建时间');
 await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();
 await page.getByLabel('开始日期',{exact:true}).fill('2026-10-01');await page.getByLabel('结束日期',{exact:true}).fill('2026-10-01');
 await page.getByRole('button',{name:'应用筛选',exact:true}).click();
 await expect(counts).toContainText('25 个订单 · 25 个包裹');
 await expect(page.getByRole('row').filter({hasText:'包裹 posting-25'})).toContainText('开始处理时间');
 await expect(page.getByRole('row').filter({hasText:'包裹 posting-25'})).toContainText('2026/10/01');
 await expect(page.getByRole('row').filter({hasText:'包裹 posting-00'})).toHaveCount(0);
 await page.screenshot({path:test.info().outputPath('orders-by-placement-date.png'),animations:'disabled'});
 await page.reload();await expect(counts).toContainText('25 个订单 · 25 个包裹');
 await page.getByRole('row').filter({hasText:'包裹 posting-25'}).getByRole('button',{name:'查看详情',exact:true}).click();
 await expect(page.locator('dt').filter({hasText:'订单时间'}).locator('..')).toContainText('2026/10/01');
 await expect(page.locator('dt').filter({hasText:'订单时间'}).locator('..')).toContainText('开始处理时间');
 await page.getByRole('button',{name:'← 返回订单列表',exact:true}).click();
 await search(page,{query:'posting-00',preset:'全部时间'});
 const missing=page.getByRole('row').filter({hasText:'包裹 posting-00'});await expect(missing).toContainText('未获取订单时间');
 await missing.getByRole('button',{name:'查看详情',exact:true}).click();
 await expect(page.locator('dt').filter({hasText:'订单时间'}).locator('..')).toContainText('未获取订单时间');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
});

test('FBP filters and deep links show real status codes and suppress proven legacy FBS duplicates',async({page,application})=>{
 application.addFbp();await page.route('https://cdn1.ozone.ru/**',route=>route.fulfill({status:200,contentType:'image/png',body:png}));
 await page.goto(application.baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('orders@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'订单测试公司',exact:true}).click();await page.goto(application.baseURL+'/workspace/orders?store=orders-store');
 const counts=page.getByRole('status',{name:'订单统计',exact:true});await expect(counts).toContainText('28 个订单 · 29 个包裹');await search(page,{fulfillment:'FBS'});await expect(counts).toContainText('24 个订单 · 25 个包裹');
 await search(page,{fulfillment:'FBP'});await expect(counts).toContainText('2 个订单 · 2 个包裹');await expect(page).toHaveURL(/fulfillment=fbp/);await page.reload();await page.getByRole('button',{name:'搜索与筛选',exact:true}).click();await expect(page.getByRole('button',{name:'FBP',exact:true})).toHaveAttribute('aria-pressed','true');await page.keyboard.press('Escape');
 await page.getByRole('row').filter({hasText:'包裹 posting-25'}).getByRole('button',{name:'查看详情',exact:true}).click();await expect(page).toHaveURL(/type=fbp/);await expect(page.getByRole('heading',{name:'包裹商品',exact:true})).toBeVisible();await expect(page.getByText('未识别状态（平台码 12）',{exact:true})).toBeVisible();await expect(page.getByText('合作仓测试商品',{exact:true})).toBeVisible();await expect(page.getByText('provider_specific_status',{exact:true})).toBeVisible();await expect(page.getByText('12.34567890 RUB',{exact:true})).toBeVisible();await expect(page.getByText('计划发货',{exact:true})).toHaveCount(0);
 await page.reload();await expect(page.getByText('合作仓测试商品',{exact:true})).toBeVisible();await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
});
