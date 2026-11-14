import {test as base,expect} from '@playwright/test';
import {startNodeBrowserApplication} from '../fixtures/node-browser.ts';
type Application=Awaited<ReturnType<typeof startNodeBrowserApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{const app=await startNodeBrowserApplication();try{await use(app);}finally{await app.close();}}});

test('a manager validates a local callback, cuts over, and a product arrives in another open page through SSE without polling',async({page,context,application:app})=>{
 test.setTimeout(120_000);
 await page.goto(app.baseURL+'/login');await page.getByRole('button',{name:'密码登录',exact:true}).click({timeout:2000}).catch(()=>{});await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
 const storeId=crypto.randomUUID(),path=`/api/companies/company-a/stores/${storeId}`;
 expect((await page.request.post(app.baseURL+'/api/companies/company-a/stores',{headers:{origin:app.baseURL},data:{id:storeId,name:'Push 本地测试店',clientId:'910001',apiKey:crypto.randomUUID()}})).status()).toBe(200);
 const store=(await(await page.request.get(app.baseURL+path)).json()).store;
 expect((await page.request.post(app.baseURL+path+'/check',{headers:{origin:app.baseURL},data:{expectedRevision:store.revision}})).status()).toBe(200);
 await page.goto(app.baseURL+`/workspace/stores?store=${storeId}`);
 const panel=page.getByRole('region',{name:'Ozon Push 同步',exact:true});await expect(panel).toBeVisible();await panel.getByLabel('通知 seller_id（可选）',{exact:true}).fill('999');await panel.getByRole('button',{name:'生成回调地址',exact:true}).click();await expect(panel.getByRole('button',{name:'发送本地模拟回调',exact:true})).toBeVisible();
 await panel.getByRole('button',{name:'发送本地模拟回调',exact:true}).click();await expect(panel.getByRole('button',{name:'切换为 Push',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'切换为 Push',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认切换',exact:true}).click();await expect(panel.getByText('Push 驱动',{exact:true})).toBeVisible();
 const products=page.getByRole('region',{name:'商品同步',exact:true});await products.getByRole('button',{name:'启用商品同步',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认启用',exact:true}).click();await expect(products.getByText('等待推送或人工回补',{exact:true})).toBeVisible();
 const other=await context.newPage();await other.goto(app.baseURL+`/workspace/products?store=${storeId}`);await expect(other.getByText('尚无已同步商品',{exact:true})).toBeVisible();
 const before=app.storeRequests.length;await panel.getByLabel('模拟通知 JSON',{exact:true}).fill(JSON.stringify({message_type:'TYPE_CREATE_OR_UPDATE_ITEM',seller_id:'999',product_id:'9000000000817031941',name:'UNTRUSTED_PUSH_NAME'}));await panel.getByRole('button',{name:'发送本地模拟回调',exact:true}).click();
 await expect(other.getByRole('row').filter({hasText:'合成测试商品'})).toBeVisible({timeout:20_000});await expect(other.getByText('UNTRUSTED_PUSH_NAME',{exact:true})).toHaveCount(0);
 await expect(panel.getByRole('row').filter({hasText:'商品更新 · 模拟'}).getByText('已完成',{exact:true})).toBeVisible({timeout:15_000});
 const reads=app.storeRequests.slice(before).filter(request=>request.path.startsWith('/v3/product/'));expect(reads.map(request=>request.path)).toEqual(['/v3/product/info/list','/v3/product/list']);expect((reads[1]!.body?.filter as {product_id:string[]}).product_id).toEqual(['9000000000817031941']);
 expect(app.replyRequests).toHaveLength(0);await other.screenshot({path:test.info().outputPath('push-product-realtime.png')});
});

test('a read-state Push updates an open message window without losing the unsent draft',async({page,application:app})=>{
 await page.goto(app.baseURL+'/login');await page.getByRole('button',{name:'密码登录',exact:true}).click({timeout:2000}).catch(()=>{});await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
 const storeId=crypto.randomUUID(),path=`/api/companies/company-a/stores/${storeId}`,headers={origin:app.baseURL};
 expect((await page.request.post(app.baseURL+'/api/companies/company-a/stores',{headers,data:{id:storeId,name:'消息状态推送测试店',clientId:'910009',apiKey:crypto.randomUUID()}})).status()).toBe(200);await app.prepareReplyStore(storeId);const history=await app.seedConversationHistory(storeId);
 const prepared=await page.request.post(app.baseURL+path+'/push',{headers,data:{operation:'prepare',expectedRevision:0,sellerId:'999'}});expect(prepared.status()).toBe(200);const callbackUrl=(await prepared.json()).push.callbackUrl;
 expect((await page.request.post(callbackUrl,{data:{message_type:'TYPE_PING'}})).status()).toBe(200);expect((await page.request.post(app.baseURL+path+'/push',{headers,data:{operation:'activate',expectedRevision:1}})).status()).toBe(200);
 expect((await page.request.post(app.baseURL+path+'/sync',{headers,data:{enabled:true,expectedEpoch:0}})).status()).toBe(200);
 expect((await page.request.post(app.baseURL+`/api/companies/company-a/conversations/${history.id}/commands`,{headers,data:{commandId:crypto.randomUUID(),expectedVersion:0,action:'claim'}})).status()).toBe(200);
 await page.goto(app.baseURL+`/workspace/messages?store=${storeId}&conversation=${history.id}`);const records=page.getByRole('region',{name:'消息记录'});await expect(records.getByText('平台未读',{exact:true})).toHaveCount(55);
 const draft=page.getByRole('textbox',{name:'回复原文',exact:true});await draft.fill('KEEP-READ-STATE-DRAFT');
 app.setPlatformRead(true);expect((await page.request.post(callbackUrl,{headers:{'X-DingBell-Local-Simulation':'1'},data:{message_type:'TYPE_MESSAGE_READ',seller_id:'999',chat_type:'BUYER_SELLER',chat_id:history.threadId,is_read:false}})).status()).toBe(200);
 await expect(records.getByText('平台已读',{exact:true})).toHaveCount(55,{timeout:15_000});await expect(draft).toHaveValue('KEEP-READ-STATE-DRAFT');expect(app.replyRequests).toHaveLength(0);
});
