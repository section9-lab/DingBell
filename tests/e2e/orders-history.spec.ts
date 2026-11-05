import {test as base,expect,type Page} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {hashPassword} from 'better-auth/crypto';
import {serveNode} from '../../src/platform/node/server.ts';
import {capabilityCodes} from '../../src/modules/stores/ozon.ts';
import {claimSyncLease} from '../../src/modules/sync/storage.ts';
import {getDueFbsWork,getDueFboWork,getDueFbpWork,commitFbsList,commitFboList,commitFbpList} from '../../src/modules/orders/storage.ts';
import type {PostingSource} from '../../src/shared/order-history.ts';
const password='synthetic-order-history-password';
const test=base.extend<{application:{baseURL:string;advance:(source:PostingSource)=>Promise<void>}}>({application:async({},use)=>{
 const folder=await mkdtemp(join(tmpdir(),'dingbell-history-ui-')),variables={APP_BASE_URL:'http://127.0.0.1:0',BETTER_AUTH_SECRET:'synthetic-order-history-identity-secret-more-than-32',STORE_CREDENTIAL_KEYS:JSON.stringify({test:btoa('h'.repeat(32))}),STORE_CREDENTIAL_ACTIVE_KEY:'test'};
 const runtime=await serveNode({dataDirectory:folder,migrationsDirectory:resolve('migrations'),assetsDirectory:resolve('dist/node/client'),hostname:'127.0.0.1',port:0,variables});
 try{
  const address=runtime.server.address();if(!address||typeof address==='string')throw Error('Missing port');const baseURL=`http://127.0.0.1:${address.port}`;variables.APP_BASE_URL=baseURL;runtime.app.env.APP_BASE_URL=baseURL;
  // UI tests persist real HTTP intent, but never contact a real Seller API.
  runtime.app.env.STORE_COORDINATOR={getByName:()=>({wake:async()=>{}})} as never;
  const db=runtime.app.database,now=Date.now(),recent=now-30*86400000;
  await db.exec("INSERT INTO organization(id,name,slug,created_at) VALUES('history-company','历史测试公司','history-company',1); INSERT INTO user(id,name,email,email_verified) VALUES('history-owner','Owner','owner@history.invalid',1); INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('history-member','history-company','history-owner','owner',1);");
  await db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('history-account','history-owner','credential','history-owner',?,1)").bind(await hashPassword(password)).run();
  await db.prepare("INSERT INTO store(id,organization_id,name,platform_store_id,status,credential_key_version,credential_nonce,credential_ciphertext,capabilities,expires_at,created_at,updated_at) VALUES('history-store','history-company','历史订单测试店','123456','partial','synthetic','synthetic','synthetic',?,?,1,1)").bind(JSON.stringify(capabilityCodes.map(code=>({code,status:['auth','orders_fbs_read','orders_fbo_read','orders_fbp_read'].includes(code)?'available':'unknown',reason:'read_verified'}))),now+3600000).run();
  await db.exec("INSERT INTO store_coordinator(store_id,organization_id) VALUES('history-store','history-company')");
  for(const source of ['fbs_postings','fbo_postings','fbp_postings'] as const){const mode=source==='fbs_postings'?'fbs':source==='fbo_postings'?'fbo':'fbp';await db.prepare("INSERT INTO store_sync_source(store_id,organization_id,source,enabled,epoch,credential_version,due_at,updated_at) VALUES('history-store','history-company',?,1,1,1,?,1)").bind(source,now+3600000).run();await db.prepare(`INSERT INTO ${mode}_sync_window(store_id,organization_id,epoch,generation,history_start,since,"to",state,due_at,last_completed_to) VALUES('history-store','history-company',1,1,?,?,?,'waiting',?,?)`).bind(recent,recent,now,now+3600000,now).run();}
  await use({baseURL,advance:async source=>{
   await db.prepare('UPDATE store_sync_source SET due_at=0 WHERE source=?').bind(source).run();await db.prepare('UPDATE posting_history_sync SET due_at=0 WHERE source=?').bind(source).run();const lease=await claimSyncLease(db,{orgId:'history-company',storeId:'history-store',source,token:crypto.randomUUID()});if(!lease)throw Error('Missing history lease');
   const work=await (source==='fbs_postings'?getDueFbsWork:source==='fbo_postings'?getDueFboWork:getDueFbpWork)(db,lease);if(work?.kind!=='list'||work.lane!=='history')throw Error('Missing historical work');
   await (source==='fbs_postings'?commitFbsList:source==='fbo_postings'?commitFboList:commitFbpList)(db,lease,work,{postings:[{postingNumber:'old-parcel',orderId:'1',orderNumber:'old-order',status:'delivered',products:[{sku:'1',offerId:'old-offer',name:'历史商品',quantity:1,price:'12.30',currency:'RUB'}],inProcessAt:'2024-01-02T00:00:00Z',shipmentDate:null,deliveringDate:null,trackingNumber:null}],hasNext:false,cursor:null});
  }});
 }finally{await runtime.close();await rm(folder,{recursive:true,force:true});}
}});
async function login(page:Page,baseURL:string){await page.goto(baseURL+'/login');await page.getByLabel('邮箱',{exact:true}).fill('owner@history.invalid');await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'历史测试公司',exact:true}).click();await page.goto(baseURL+'/workspace/stores?store=history-store');}
for(const mode of ['FBS','FBO','FBP'] as const)test(`${mode} history has explicit UTC ranges, durable progress and independent stop/resume`,async({page,application})=>{
 const source:PostingSource=mode==='FBS'?'fbs_postings':mode==='FBO'?'fbo_postings':'fbp_postings',endpoint=`${application.baseURL}/api/companies/history-company/stores/history-store/sync/${mode.toLowerCase()}-postings`;
 await login(page,application.baseURL);const section=page.getByRole('region',{name:`${mode} 历史回补`,exact:true});await expect(section).toBeVisible();await section.getByLabel('历史起始日期（UTC）',{exact:true}).fill('2024-01-01');await section.getByRole('button',{name:'同步历史订单',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:`启动 ${mode} 历史回补`,exact:true});await expect(dialog).toContainText('2024-01-01（UTC）');await dialog.getByRole('button',{name:'确认同步历史订单',exact:true}).click();await expect(dialog).toBeHidden();await expect(section.getByRole('status')).toContainText('历史回补进行中');
 const state=async()=> (await(await page.request.get(endpoint)).json()).sync;
 const before=await state();expect(before.history).toMatchObject({state:'active',commandRevision:1,requestedFrom:'2024-01-01T00:00:00.000Z',pagesRead:0});
 const other=mode==='FBS'?'fbo':'fbs';expect((await(await page.request.get(endpoint.replace(`/${mode.toLowerCase()}-postings`,`/${other}-postings`))).json()).sync.history).toBeNull();
 await application.advance(source);await page.reload();await expect(section.getByRole('status')).toContainText('已读取 1 页');expect((await state()).postingCount).toBe(1);
 await section.getByRole('button',{name:'停止历史回补',exact:true}).click();const stop=page.getByRole('dialog',{name:`停止 ${mode} 历史回补`,exact:true});await stop.getByRole('button',{name:'确认停止历史回补',exact:true}).click();await expect(stop).toBeHidden();await expect(section.getByRole('status')).toContainText('历史回补已停止');
 expect(await state()).toMatchObject({enabled:true,postingCount:1,history:{state:'cancelled',pagesRead:1,commandRevision:2}});
 await section.getByRole('button',{name:'继续历史回补',exact:true}).click();await page.getByRole('dialog',{name:`启动 ${mode} 历史回补`,exact:true}).getByRole('button',{name:'确认同步历史订单',exact:true}).click();await expect(section.getByRole('status')).toContainText('历史回补进行中');expect((await state()).history).toMatchObject({pagesRead:1,commandRevision:3});
 const after=await state();expect([after.historyStart,after.windowSince,after.windowTo,after.lastCompletedTo]).toEqual([before.historyStart,before.windowSince,before.windowTo,before.lastCompletedTo]);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
 await page.goto(`${application.baseURL}/workspace/orders?store=history-store&fulfillment=${mode.toLowerCase()}`);await expect(page.getByRole('status',{name:'订单统计',exact:true})).toContainText('1 个订单 · 1 个包裹');await expect(page.getByText('订单 old-order',{exact:true})).toBeVisible();await expect(page.getByLabel(`${mode} 历史进度`,{exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'同步设置',exact:true})).toBeVisible();expect((await state()).history).toMatchObject({state:'active',commandRevision:3});
});
