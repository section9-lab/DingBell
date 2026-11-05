import {test as base,expect,type Page} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {serveNode} from '../../src/platform/node/server.ts';
const password='synthetic-reconnect-password',storeId='00000000-0000-4000-8000-000000000001';
type Snapshot={stores:number;conversations:number;products:number;fbs:number;fbo:number;cursor:string;enabled:number;status:string;hasCredentials:number;credentialVersion:number};
const test=base.extend<{application:{baseURL:string;calls:()=>number;snapshot:()=>Snapshot;restart:()=>Promise<void>}}>({application:async({},use)=>{
 const directory=await mkdtemp(join(tmpdir(),'dingbell-reconnect-ui-'));let calls=0;
 const variables={APP_BASE_URL:'http://127.0.0.1:0',BETTER_AUTH_SECRET:'synthetic-reconnect-identity-secret-at-least-32',STORE_CREDENTIAL_ACTIVE_KEY:'v1',STORE_CREDENTIAL_KEYS:JSON.stringify({v1:Buffer.alloc(32,9).toString('base64')}),OUTBOUND_ENABLED:'false'};
 const options:Parameters<typeof serveNode>[0]={dataDirectory:directory,migrationsDirectory:resolve('migrations'),assetsDirectory:resolve('dist/node/client'),hostname:'127.0.0.1',port:0,variables,dependencies:{storeFetch:async(input)=>{
  calls++;const path=new URL(String(input)).pathname;
  const responses:Record<string,unknown>={'/v1/roles':{roles:[]},'/v3/chat/list':{chats:[]},'/v3/product/list':{result:{items:[]}},'/v4/posting/fbs/list':{postings:[]},'/v3/posting/fbo/list':{postings:[]},'/v1/posting/fbp/list':{postings:[],cursor:''}};
  if(!(path in responses))throw new Error('Unexpected synthetic provider request');return Response.json(responses[path]);
 }}};
 let runtime=await serveNode(options);
 try{
  const address=runtime.server.address();if(!address||typeof address==='string')throw new Error('Missing local port');const baseURL=`http://127.0.0.1:${address.port}`;variables.APP_BASE_URL=baseURL;runtime.app.env.APP_BASE_URL=baseURL;
  let db=runtime.app.database.sqlite;options.port=address.port;
  db.exec(`INSERT INTO organization(id,name,slug,created_at) VALUES('company','重连测试公司','reconnect',1);
   INSERT INTO user(id,name,email,email_verified) VALUES('owner','管理员','reconnect@example.invalid',1);
   INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('member','company','owner','owner',1);
   INSERT INTO store(id,organization_id,name,platform_store_id,status,revision,credential_version,created_at,updated_at) VALUES('${storeId}','company','Mirava','123456','disconnected',3,2,1,1);
   INSERT INTO store_coordinator(store_id,organization_id) VALUES('${storeId}','company');
   INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,imported_at) VALUES('conv','company','${storeId}','thread','BUYER_SELLER','Opened',1,1);
   INSERT INTO product(id,organization_id,store_id,listing,list_observed_at,detail_epoch,detail_generation,detail_due_at) VALUES('1','company','${storeId}','{"id":"1","offerId":"offer","sku":"1"}',1,1,1,9999999999999);
   INSERT INTO fbs_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at) VALUES('fbs-history','company','${storeId}','1','order-1',1,1,9999999999999);
   INSERT INTO fbo_posting(posting_number,organization_id,store_id,order_id,order_number,detail_epoch,detail_generation,detail_due_at) VALUES('fbo-history','company','${storeId}','2','order-2',1,1,9999999999999);`);
  for(const source of ['chat','products','fbs_postings','fbo_postings'])db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,due_at,updated_at) VALUES(?,'company',?,0,2,1,1)").run(storeId,source);
  db.prepare("INSERT INTO sync_cursor(organization_id,store_id,stream,thread_id,cursor,due_at) VALUES('company',?,'discovery','','retained-cursor',1)").run(storeId);
  db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('account','owner','credential','owner',?,1)").run(await hashPassword(password));
  const count=(table:string)=>Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  const snapshot=():Snapshot=>({stores:count('store'),conversations:count('conversation'),products:count('product'),fbs:count('fbs_posting'),fbo:count('fbo_posting'),cursor:String(db.prepare('SELECT cursor FROM sync_cursor').get()!.cursor),enabled:Number(db.prepare('SELECT SUM(enabled) AS n FROM store_sync_source').get()!.n),...db.prepare('SELECT status,credential_ciphertext IS NOT NULL AS hasCredentials,credential_version AS credentialVersion FROM store').get() as {status:string;hasCredentials:number;credentialVersion:number}});
  await use({baseURL,calls:()=>calls,snapshot,restart:async()=>{await runtime.close();runtime=await serveNode(options);db=runtime.app.database.sqlite;}});
 }finally{await runtime.close();await rm(directory,{recursive:true,force:true});}
}});
async function openStore(page:Page,baseURL:string,list=false){
 await page.goto(baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('reconnect@example.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();const company=page.getByRole('button',{name:'重连测试公司',exact:true});await expect(company).toBeVisible();await company.click();await page.goto(baseURL+'/workspace/stores'+(list?'':`?store=${storeId}`));
}
test('disconnected store reconnects through a clear action, preserves data and requires explicit checks before sync',async({page,application})=>{
 await openStore(page,application.baseURL);await expect(page.getByRole('button',{name:'重新连接',exact:true})).toBeEnabled();await expect(page.getByText('店铺已断开，需要重新连接',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'检查只读能力',exact:true})).toBeDisabled();
 const before=application.snapshot();await page.getByRole('button',{name:'重新连接',exact:true}).click();const dialog=page.getByRole('dialog',{name:'重新连接 Ozon 店铺',exact:true});await expect(dialog).toContainText('Client ID 123456');await expect(dialog.getByLabel('API Key',{exact:true})).toHaveValue('');
 await dialog.getByRole('button',{name:'保存并重新连接',exact:true}).click();await expect(dialog.getByText('请输入 API Key。',{exact:true})).toBeVisible();await expect(dialog.getByRole('alert').filter({hasText:'尚未保存'})).toBeVisible();expect(application.snapshot()).toEqual(before);
 const key='synthetic-reconnected-ozon-key';let savedKey:string|undefined;page.on('request',request=>{if(request.url().endsWith('/credentials'))savedKey=request.postDataJSON().apiKey;});await dialog.getByLabel('API Key',{exact:true}).fill(`  ${key}  `);await dialog.getByRole('button',{name:'保存并重新连接',exact:true}).click();await expect(dialog).toBeHidden();await expect(page.getByRole('button',{name:'检查只读能力',exact:true})).toBeEnabled();
 expect(application.snapshot()).toEqual({...before,status:'unverified',hasCredentials:1,credentialVersion:3});expect(application.calls()).toBe(0);await expect(page.getByRole('button',{name:'启用 FBO 包裹同步',exact:true})).toBeDisabled();expect(await page.content()).not.toContain(key);
 expect(savedKey).toBe(key);await expect(page.getByRole('status',{name:'凭证保存状态',exact:true})).toContainText('第 3 版');
 await page.getByRole('button',{name:'检查只读能力',exact:true}).click();await expect(page.getByRole('button',{name:'启用 FBO 包裹同步',exact:true})).toBeEnabled();expect(application.calls()).toBe(6);expect(application.snapshot().enabled).toBe(0);await expect(page.getByRole('button',{name:'重新连接',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'更新凭证',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'暂停连接',exact:true}).click();await page.getByRole('dialog',{name:'暂停连接',exact:true}).getByRole('button',{name:'确认暂停连接',exact:true}).click();await expect(page.getByText('连接已暂停，凭证仍已保存',{exact:true})).toBeVisible();
 const paused=application.snapshot();expect(paused.hasCredentials).toBe(1);expect(paused.credentialVersion).toBe(3);await application.restart();await page.reload();await expect(page.getByRole('status',{name:'凭证保存状态',exact:true})).toContainText('刷新或重启后可继续复用');expect(application.snapshot()).toEqual(paused);
 await page.getByRole('button',{name:'恢复连接',exact:true}).click();const resume=page.getByRole('dialog',{name:'恢复连接',exact:true});await expect(resume).toContainText('无需重新输入');await expect(resume.getByLabel('API Key',{exact:true})).toHaveCount(0);await resume.getByRole('button',{name:'确认恢复连接',exact:true}).click();await expect(resume).toBeHidden();expect(application.snapshot().hasCredentials).toBe(1);expect(application.snapshot().credentialVersion).toBe(3);expect(application.snapshot().status).toBe('unverified');expect(application.calls()).toBe(6);
 await page.getByRole('button',{name:'更新凭证',exact:true}).click();const saved=page.getByRole('dialog',{name:'更新店铺凭证',exact:true});await expect(saved.getByLabel('API Key',{exact:true})).toHaveAttribute('placeholder','已加密保存；仅更换 Key 时填写');await expect(saved.getByLabel('API Key',{exact:true})).toHaveValue('');await saved.getByRole('button',{name:'取消',exact:true}).click();
});
test('store list exposes reconnect and cancellation leaves disconnected data unchanged',async({page,application})=>{
 await openStore(page,application.baseURL,true);const before=application.snapshot();await page.getByRole('button',{name:'重新连接 Mirava',exact:true}).click();const dialog=page.getByRole('dialog',{name:'重新连接 Ozon 店铺',exact:true});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toBeHidden();expect(application.snapshot()).toEqual(before);expect(application.calls()).toBe(0);
});
test('an uncertain reconnect acknowledgement is reread without resubmitting the new key',async({page,application})=>{
 await openStore(page,application.baseURL);let writes=0;await page.route(`**/api/companies/company/stores/${storeId}/credentials`,async route=>{writes++;const response=await route.fetch();expect(response.status()).toBe(200);await route.fulfill({response,status:503,contentType:'application/json',body:JSON.stringify({error:{code:'OPERATION_UNCONFIRMED'}})});});
 await page.getByRole('button',{name:'重新连接',exact:true}).click();const dialog=page.getByRole('dialog',{name:'重新连接 Ozon 店铺',exact:true});const key='synthetic-uncertain-reconnect-key';await dialog.getByLabel('API Key',{exact:true}).fill(key);await dialog.getByRole('button',{name:'保存并重新连接',exact:true}).click();await expect(dialog).toBeHidden();await expect(page.getByRole('alert').filter({hasText:'操作结果暂未确认'})).toBeVisible();
 expect(writes).toBe(1);expect(application.snapshot().status).toBe('unverified');expect(application.snapshot().credentialVersion).toBe(3);expect(application.snapshot().enabled).toBe(0);expect(application.calls()).toBe(0);expect(await page.content()).not.toContain(key);
});
