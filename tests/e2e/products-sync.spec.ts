import { test as base, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
type State = { enabled:boolean;epoch:number;productCount:number;readyCount:number;pendingCount:number;failedCount:number };
const test=base.extend<{application:Application}>({ application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',sync:true});
  try { await use(app); } finally { await app.close(); }
} });
async function login(page:Page,app:Application,actor='owner') {
  await page.goto(`${app.baseURL}/login`);
  await page.getByLabel('邮箱',{exact:true}).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码',{exact:true}).fill(app.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
}
const url=(app:Application,id:string)=>`${app.baseURL}/api/companies/company-a/stores/${id}/sync/products`;
async function state(page:Page,app:Application,id:string):Promise<State> {
  const response=await page.request.get(url(app,id)); expect(response.status()).toBe(200); return (await response.json()).sync;
}
async function createStore(page:Page,app:Application) {
  const id=crypto.randomUUID();
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id,name:'商品同步测试店',clientId:'930001',apiKey:crypto.randomUUID()}})).ok()).toBe(true);
  await page.goto(`${app.baseURL}/workspace/stores?store=${id}`);
  await expect(page.getByRole('heading',{name:'商品同步',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'启用商品同步',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'检查只读能力',exact:true}).click();
  await expect(page.getByRole('button',{name:'启用商品同步',exact:true})).toBeEnabled();
  return id;
}
async function toggle(page:Page,enabled:boolean,source='商品') {
  const label=`${enabled?'启用':'停止'}${source}同步`;
  await page.getByRole('button',{name:label,exact:true}).click();
  const dialog=page.getByRole('dialog',{name:label,exact:true});
  await dialog.getByRole('button',{name:enabled?'确认启用':'确认停止',exact:true}).click();
  await expect(dialog).toBeHidden();
}

test('products alone import paged metadata and details when chat access is denied, then stop without losing counts',async({page,application})=>{
  application.setStoreBehavior('partial');
  await login(page,application); const id=await createStore(page,application);
  await expect(page.getByRole('button',{name:'启用会话同步',exact:true})).toBeDisabled();
  await toggle(page,true);
  await expect.poll(async()=>{const s=await state(page,application,id);return [s.productCount,s.readyCount,s.pendingCount,s.failedCount];},{timeout:25_000}).toEqual([3,3,0,0]);
  expect(application.storeRequests.some(request=>request.path==='/v3/chat/history')).toBe(false);
  expect(application.storeRequests.filter(request=>request.path==='/v3/chat/list')).toHaveLength(1);
  expect(application.storeRequests.some(request=>request.path==='/v3/product/info/list')).toBe(true);
  const panel=page.getByRole('region',{name:'商品同步',exact:true});
  await expect(panel.getByText('已有商品资料',{exact:true})).toBeVisible();
  await expect(panel.getByText('3',{exact:true}).first()).toBeVisible();
  const evidence=fileURLToPath(new URL('../../test-results/stage3c-2026-10-09/',import.meta.url)); await mkdir(evidence,{recursive:true});
  await page.screenshot({path:`${evidence}products-desktop.png`,fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844}); await panel.scrollIntoViewIfNeeded();
  await page.screenshot({path:`${evidence}products-mobile.png`,fullPage:true,animations:'disabled'});
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await toggle(page,false); await page.reload();
  expect(await state(page,application,id)).toMatchObject({enabled:false,productCount:3,readyCount:3});
});

test('chat and products have independent controls while a store pause stops both',async({page,application})=>{
  await login(page,application); const id=await createStore(page,application);
  await toggle(page,true); await toggle(page,true,'会话');
  await expect.poll(async()=>(await state(page,application,id)).readyCount,{timeout:25_000}).toBe(3);
  await toggle(page,false,'会话'); expect((await state(page,application,id)).enabled).toBe(true);
  await page.getByRole('button',{name:'暂停连接',exact:true}).click();
  await page.getByRole('dialog',{name:'暂停连接',exact:true}).getByRole('button',{name:'确认暂停连接',exact:true}).click();
  expect(await state(page,application,id)).toMatchObject({enabled:false,productCount:3,readyCount:3});
  await expect(page.getByRole('button',{name:'启用商品同步',exact:true})).toBeDisabled();
  const chat=await page.request.get(url(application,id).replace('/sync/products','/sync'));
  expect((await chat.json()).sync.enabled).toBe(false);
});

test('granted members see product progress without management controls and revocation clears the open store',async({page,browser,application})=>{
  await login(page,application); const id=await createStore(page,application);
  const grant=`${application.baseURL}/api/companies/company-a/stores/${id}/grants/member-a`;
  expect((await page.request.post(grant,{headers:{origin:application.baseURL},data:{expectedGranted:false,granted:true}})).ok()).toBe(true);
  const context=await browser.newContext();
  try {
    const member=await context.newPage(); await login(member,application,'member'); await member.goto(`${application.baseURL}/workspace/stores?store=${id}`);
    await expect(member.getByRole('heading',{name:'商品同步',exact:true})).toBeVisible();
    await expect(member.getByRole('button',{name:'启用商品同步',exact:true})).toHaveCount(0);
    expect((await member.request.post(url(application,id),{headers:{origin:application.baseURL},data:{enabled:true,expectedEpoch:0}})).status()).toBe(403);
    expect((await page.request.post(grant,{headers:{origin:application.baseURL},data:{expectedGranted:true,granted:false}})).ok()).toBe(true);
    expect((await member.request.get(url(application,id))).status()).toBe(404);
    await member.evaluate(`(() => { Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'}); document.dispatchEvent(new Event('visibilitychange',{bubbles:true})); Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'}); document.dispatchEvent(new Event('visibilitychange',{bubbles:true})); })()`);
    await expect(member.getByRole('heading',{name:'商品同步',exact:true})).toHaveCount(0);
  } finally { await context.close(); }
});
