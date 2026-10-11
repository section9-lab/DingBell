import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',sync:true,control:true,replies:true});
  try { await use(app); } finally { await app.close(); }
}});
async function login(page:Page,app:Application,email='owner@example.invalid') {
  await page.goto(`${app.baseURL}/login`); await page.getByLabel('邮箱',{exact:true}).fill(email);
  await page.getByLabel('密码',{exact:true}).fill(app.password); await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
}
const api=(app:Application)=>`${app.baseURL}/api/companies/company-a/settings`;

test('company timezone persists, renders imported timestamps and stays isolated on company switch',async({page,application})=>{
  await login(page,application);
  await page.getByRole('link',{name:'公司设置',exact:true}).click();
  const zone=page.getByLabel('公司时区',{exact:true}),save=page.getByRole('button',{name:'保存设置',exact:true});
  await expect(zone).toHaveValue('UTC'); await zone.selectOption('Asia/Singapore'); await save.click();
  await expect(page.getByRole('status').filter({hasText:'设置已保存'})).toBeVisible();
  await page.reload(); await expect(zone).toHaveValue('Asia/Singapore');
  await page.screenshot({path:test.info().outputPath('company-settings-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(save).toBeVisible(); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({path:test.info().outputPath('company-settings-mobile.png')});
  await page.setViewportSize({width:1366,height:768});
  const store=crypto.randomUUID();
  expect((await page.request.post(`${application.baseURL}/api/companies/company-a/stores`,{headers:{origin:application.baseURL},data:{id:store,name:'时区验证店',clientId:'920001',apiKey:crypto.randomUUID()}})).status()).toBe(200);
  const history=await application.seedConversationHistory(store);
  await page.goto(`${application.baseURL}/workspace/messages?store=${store}&conversation=${history.id}`);
  const timestamp=page.getByRole('region',{name:'消息记录'}).locator('time').first(); await expect(timestamp).toBeVisible();
  const iso=await timestamp.getAttribute('datetime'); expect(iso).toBeTruthy();
  const expected=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(new Date(iso!));
  await expect(timestamp).toHaveText(`平台时间 ${expected}`);
  expect((await page.request.post(`${application.baseURL}/api/companies/company-b/activate`,{headers:{origin:application.baseURL},data:{}})).status()).toBe(200);
  await page.goto(`${application.baseURL}/workspace/settings`); await expect(zone).toHaveValue('UTC');
  expect(application.replyRequests).toHaveLength(0);
});

test('concurrent editors preserve the unsaved choice and require review before retry',async({page,context,application})=>{
  await login(page,application); await page.goto(`${application.baseURL}/workspace/settings`);
  const zone=page.getByLabel('公司时区',{exact:true}),save=page.getByRole('button',{name:'保存设置',exact:true});
  await expect(zone).toHaveValue('UTC'); await zone.selectOption('Europe/Moscow');
  const other=await context.newPage(); await other.goto(`${application.baseURL}/workspace/settings`);
  await expect(other.getByLabel('公司时区',{exact:true})).toHaveValue('UTC');
  await other.getByLabel('公司时区',{exact:true}).selectOption('Asia/Singapore'); await other.getByRole('button',{name:'保存设置',exact:true}).click();
  await expect(other.getByRole('status').filter({hasText:'设置已保存'})).toBeVisible();
  await save.click(); await expect(page.getByRole('alert')).toContainText('设置已被其他人修改');
  await expect(zone).toHaveValue('Europe/Moscow'); await expect(save).toBeDisabled();
  await page.getByRole('button',{name:'读取最新设置',exact:true}).click();
  await expect(page.getByText('当前保存：Asia/Singapore · 版本 1',{exact:true})).toBeVisible();
  await expect(zone).toHaveValue('Europe/Moscow'); await expect(save).toBeDisabled();
  await page.getByRole('button',{name:'基于最新版本继续编辑',exact:true}).click(); await save.click();
  await expect(page.getByRole('status').filter({hasText:'设置已保存'})).toBeVisible();
  const data=await (await page.request.get(api(application))).json(); expect(data).toMatchObject({timeZone:'Europe/Moscow',version:2});
  await other.close();
});

test('uncertain saves require reconciliation, while members can only read settings',async({page,application})=>{
  await login(page,application); await page.goto(`${application.baseURL}/workspace/settings`);
  const zone=page.getByLabel('公司时区',{exact:true}),save=page.getByRole('button',{name:'保存设置',exact:true});
  await expect(zone).toHaveValue('UTC'); await zone.selectOption('America/New_York');
  let writes=0;
  await page.route('**/api/companies/company-a/settings',async route=>{
    if(route.request().method()==='POST') {writes++; await route.fetch(); await route.fulfill({status:503,json:{error:{code:'OPERATION_UNCONFIRMED'}}});}
    else await route.continue();
  });
  await save.click(); await expect(page.getByRole('alert')).toContainText('保存结果尚未确认'); await expect(save).toBeDisabled();
  expect(writes).toBe(1); await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:'读取最新设置',exact:true}).click();
  await expect(page.getByText('当前保存：America/New_York · 版本 1',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'基于最新版本继续编辑',exact:true}).click(); await expect(save).toBeDisabled();
  expect((await (await page.request.get(api(application))).json()).version).toBe(1);
  await page.context().clearCookies(); await login(page,application,'member@example.invalid');
  await page.goto(`${application.baseURL}/workspace/settings`); await expect(zone).toHaveValue('America/New_York');
  await expect(zone).toBeDisabled(); await expect(save).toHaveCount(0);
  await expect(page.getByText('仅公司所有者和管理员可以修改。',{exact:true})).toBeVisible();
});

test('a settings outage labels the UTC fallback and allows an explicit recovery without sending messages',async({page,application})=>{
  await login(page,application);
  await page.route('**/api/companies/company-a/settings',route=>route.fulfill({status:503,json:{error:{code:'IDENTITY_UNAVAILABLE'}}}));
  await page.goto(`${application.baseURL}/workspace/settings`);
  await expect(page.getByRole('link',{name:'时区读取失败 · UTC',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'保存设置',exact:true})).toHaveCount(0);
  await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:'读取最新设置',exact:true}).click();
  await expect(page.getByLabel('公司时区',{exact:true})).toHaveValue('UTC');
  await expect(page.getByRole('link',{name:'UTC',exact:true})).toBeVisible();
  expect(application.replyRequests).toHaveLength(0);
});

test('a read started during a save cannot overwrite the confirmed settings with an older version',async({page,application})=>{
  await page.clock.install();
  await login(page,application); await page.goto(`${application.baseURL}/workspace/settings`);
  const zone=page.getByLabel('公司时区',{exact:true}); await expect(zone).toHaveValue('UTC');
  await page.clock.fastForward(55_000);
  let releaseWrite=()=>{},releaseRead=()=>{},writing=false,reading=false,delivered=false,writes=0;
  const writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;}),readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
  await page.route('**/api/companies/company-a/settings',async route=>{
    if(route.request().method()==='POST') {
      writing=true; writes++; await writeGate; await route.fulfill({response:await route.fetch()});
    } else {
      const response=await route.fetch(); expect((await response.json()).version).toBe(0); reading=true;
      await readGate;
      try { await route.fulfill({response}); } catch { /* Cancellation after save is expected. */ }
      finally { delivered=true; }
    }
  });
  try {
    await zone.selectOption('Asia/Singapore'); await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await expect.poll(()=>writing).toBe(true); await page.clock.fastForward(6_000); await expect.poll(()=>reading).toBe(true);
    releaseWrite(); await expect(page.getByRole('status').filter({hasText:'设置已保存'})).toBeVisible();
    await expect(page.getByText('当前保存：Asia/Singapore · 版本 1',{exact:true})).toBeVisible();
    releaseRead(); await expect.poll(()=>delivered).toBe(true); await expect(zone).toBeEnabled();
    await expect(zone).toHaveValue('Asia/Singapore');
    await expect(page.getByText('当前保存：Asia/Singapore · 版本 1',{exact:true})).toBeVisible();
    expect(writes).toBe(1); expect((await (await page.request.get(api(application))).json()).version).toBe(1);
  } finally { releaseWrite();releaseRead();await page.unrouteAll({behavior:'wait'}); }
});
