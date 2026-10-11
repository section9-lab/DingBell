import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',control:true,replies:true});
  try{await use(app);}finally{await app.close();}
}});
async function login(page:Page,app:Application,email='owner@example.invalid') {
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill(email);
  await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
}
async function store(page:Page,app:Application) {
  const id=crypto.randomUUID();expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{
    headers:{origin:app.baseURL},data:{id,name:'策略验证店',clientId:'930001',apiKey:crypto.randomUUID()},
  })).status()).toBe(200);return id;
}
async function draft(page:Page,name='售前接待') {
  await page.getByRole('button',{name:'新建策略',exact:true}).click();
  await page.getByLabel('策略名称',{exact:true}).fill(name);await page.getByRole('checkbox',{name:'策略验证店',exact:true}).check();
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
}
async function publish(page:Page) {
  await page.getByRole('button',{name:'检查规则',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'规则检查通过'})).toBeVisible();
  await page.getByRole('button',{name:'发布策略',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'确认发布策略'})).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'发布策略',exact:true})).toBeFocused();
  await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'确认发布策略'})).toBeVisible();
  await page.getByRole('button',{name:'确认发布',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'策略已发布'})).toBeVisible();
}
test('reviewed publications stay separate from drafts, pause and historical restoration',async({page,application})=>{
  await login(page,application);await store(page,application);
  await page.getByRole('link',{name:'回复策略',exact:true}).click();await draft(page);
  await expect(page.getByRole('button',{name:'发布策略',exact:true})).toBeDisabled();
  await publish(page);await expect(page.getByTestId('policy-effective')).toContainText('生效版本 v1');
  await page.getByLabel('策略名称',{exact:true}).fill('新草稿名称');await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
  await expect(page.getByTestId('policy-effective')).toContainText('售前接待');
  await expect(page.getByTestId('policy-effective')).not.toContainText('新草稿名称');
  await publish(page);await expect(page.getByTestId('policy-effective')).toContainText('生效版本 v2');
  await page.getByRole('button',{name:'暂停策略',exact:true}).click();await expect(page.getByTestId('policy-effective')).toContainText('已暂停');
  await page.getByRole('button',{name:'将 v1 恢复为草稿',exact:true}).click();await expect(page.getByLabel('策略名称',{exact:true})).toHaveValue('售前接待');
  await expect(page.getByTestId('policy-effective')).toContainText('新草稿名称');await publish(page);
  await expect(page.getByTestId('policy-effective')).toContainText('生效版本 v3');
  await page.setViewportSize({width:1440,height:1000});await page.evaluate('window.scrollTo(0,0)');await page.screenshot({path:test.info().outputPath('reply-policies-desktop.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({path:test.info().outputPath('reply-policies-mobile.png'),fullPage:true,animations:'disabled'});
  expect(application.replyRequests).toHaveLength(0);
});
test('concurrent editing preserves a draft and requires explicit review before retrying',async({page,context,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);await draft(page);
  await page.getByLabel('策略名称',{exact:true}).fill('本地尚未保存');
  const other=await context.newPage();await other.goto(`${application.baseURL}/workspace/reply-policies`);
  await other.getByRole('button',{name:'编辑策略：售前接待',exact:true}).click();
  await other.getByLabel('策略名称',{exact:true}).fill('另一管理员的修改');await other.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(other.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'核对最新策略'})).toBeVisible();
  await expect(page.getByLabel('策略名称',{exact:true})).toHaveValue('本地尚未保存');
  await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'读取最新策略',exact:true}).click();
  await page.getByRole('button',{name:'基于最新版本继续编辑',exact:true}).click();
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
  await other.close();
});
test('a lost publication response is recovered by reading and is never resent automatically',async({page,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);await draft(page);
  await page.getByRole('button',{name:'检查规则',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'规则检查通过'})).toBeVisible();
  let sends=0;
  await page.route('**/reply-policies/*/publish',async route=>{sends++;await route.fetch();await route.abort('failed');});
  await page.getByRole('button',{name:'发布策略',exact:true}).click();await page.getByRole('button',{name:'确认发布',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'操作结果尚未确认'})).toBeVisible();
  await expect(page.getByRole('button',{name:'发布策略',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'读取最新策略',exact:true}).click();await expect(page.getByTestId('policy-effective')).toContainText('生效版本 v1');
  expect(sends).toBe(1);expect(application.replyRequests).toHaveLength(0);
});

test('notifications validate variables independently and an invalid local draft cannot prevent pausing',async({page,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);
  await page.getByRole('tab',{name:'主动通知',exact:true}).click();await draft(page,'发货提醒');
  await publish(page);await expect(page.getByTestId('policy-effective')).toContainText('已发货');
  await page.getByLabel('通知内容',{exact:true}).fill('不支持的 {{unknown}}');
  await expect(page.getByRole('button',{name:'保存草稿',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'暂停策略',exact:true}).click();
  await expect(page.getByTestId('policy-effective')).toContainText('已暂停');
  await expect(page.getByLabel('通知内容',{exact:true})).toHaveValue('不支持的 {{unknown}}');
  await page.getByRole('tab',{name:'自动回复',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'放弃未保存的修改？'})).toBeVisible();
  await page.getByRole('button',{name:'继续编辑',exact:true}).click();
  await page.getByLabel('通知内容',{exact:true}).fill('Ваш заказ {{order_number}} отправлен.');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'草稿已保存'})).toBeVisible();
  await page.getByRole('tab',{name:'自动回复',exact:true}).click();await expect(page.getByText('还没有此类策略。新建后先保存草稿。')).toBeVisible();
  await page.getByRole('tab',{name:'主动通知',exact:true}).click();await page.getByRole('button',{name:'编辑策略：发货提醒',exact:true}).click();
  await expect(page.getByLabel('通知内容',{exact:true})).toHaveValue('Ваш заказ {{order_number}} отправлен.');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.evaluate('window.scrollTo(0,0)');await page.screenshot({path:test.info().outputPath('notification-mobile.png'),fullPage:true,animations:'disabled'});
  expect(application.replyRequests).toHaveLength(0);
});

test('members cannot configure policies and a company switch removes the previous editor',async({page,context,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);await draft(page);
  const selected=new URL(page.url()).searchParams.get('policy');expect(selected).toBeTruthy();
  const member=await context.browser()!.newContext(),staff=await member.newPage();
  try{
    await login(staff,application,'member@example.invalid');await staff.goto(`${application.baseURL}/workspace/reply-policies?policy=${selected}`);
    await expect(staff.getByRole('alert').filter({hasText:'需要管理员权限'})).toBeVisible();
    await expect(staff.getByLabel('策略名称',{exact:true})).toHaveCount(0);
    expect((await staff.request.get(`${application.baseURL}/api/companies/company-a/reply-policies/${selected}`)).status()).toBe(403);
  }finally{await member.close();}
  expect((await page.request.post(`${application.baseURL}/api/companies/company-b/activate`,{headers:{origin:application.baseURL},data:{}})).status()).toBe(200);
  await page.goto(`${application.baseURL}/workspace/reply-policies?policy=${selected}`);
  await expect(page.getByRole('alert').filter({hasText:'需要管理员权限'})).toBeVisible();await expect(page.getByLabel('策略名称',{exact:true})).toHaveCount(0);
});

test('losing membership while saving clears the cached policy editor',async({page,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);await draft(page);
  await page.getByLabel('策略名称',{exact:true}).fill('撤权后不能保留的编辑页');
  await application.removeMembership('company-a');
  await page.getByRole('button',{name:'保存草稿',exact:true}).click();
  await expect(page.getByLabel('策略名称',{exact:true})).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(0);
});

test('a delayed save acknowledgement does not navigate back after leaving the editor',async({page,application})=>{
  await login(page,application);await store(page,application);await page.goto(`${application.baseURL}/workspace/reply-policies`);await draft(page);
  await page.getByLabel('策略名称',{exact:true}).fill('保存期间离开');
  let release!:()=>void,accepted!:()=>void;
  const hold=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{accepted=resolve;});
  await page.route('**/reply-policies/*/draft',async route=>{const response=await route.fetch();accepted();await hold;await route.fulfill({response});});
  try{
    await page.getByRole('button',{name:'保存草稿',exact:true}).click();await ready;
    await page.getByRole('link',{name:'公司设置',exact:true}).click();await expect(page.getByRole('heading',{name:'公司设置',exact:true})).toBeVisible();
    const response=page.waitForResponse(value=>value.url().endsWith('/draft'));release();await response;
    await expect(page.getByRole('heading',{name:'公司设置',exact:true})).toBeVisible();
    await expect(page).toHaveURL(`${application.baseURL}/workspace/settings`);
  }finally{release();}
});
