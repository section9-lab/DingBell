import { test as base,expect,type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',control:true,replies:true,answerTest:true});try{await use(app);}finally{await app.close();}
}});
async function login(page:Page,app:Application,email='owner@example.invalid'){
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(app.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
}
async function setup(page:Page,app:Application){
  await login(page,app);const storeId=crypto.randomUUID();expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'问答验证店',clientId:'930001',apiKey:crypto.randomUUID()}})).status()).toBe(200);
  const seed=await app.answerTest({seedStoreId:storeId});await page.goto(`${app.baseURL}/workspace/messages?conversation=${seed.conversationId}`);return seed;
}
test('a manager retrieves evidence and separately reviews a simulated reply, including after reload and on mobile',async({page,application})=>{
  const seed=await setup(page,application);await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'测试 AI 回复',exact:true});await expect(panel).toBeVisible();
  await panel.getByLabel('回复策略',{exact:true}).selectOption(seed.policyId!);
  await panel.getByRole('button',{name:'检索依据',exact:true}).click();await expect(panel.getByTestId('reply-test-sources')).toContainText('26 см.');
  expect(await application.answerTest()).toEqual({embeds:1,generations:0});await panel.getByRole('button',{name:'生成测试回复',exact:true}).click();
  await expect(panel.getByTestId('reply-test-result')).toContainText('Ширина — 26 см.');await expect(panel.getByTestId('reply-test-result')).toContainText('需人工核对');
  await expect(panel.getByRole('button',{name:/发送/})).toHaveCount(0);await page.screenshot({path:test.info().outputPath('answer-test-desktop.png'),animations:'disabled'});
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'测试 AI 回复',exact:true})).toBeFocused();
  await page.reload();await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();await expect(panel.getByTestId('reply-test-result')).toContainText('Ширина — 26 см.');
  expect(await application.answerTest()).toEqual({embeds:1,generations:1});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await expect(panel.getByTestId('reply-test-result')).toBeVisible();await page.screenshot({path:test.info().outputPath('answer-test-mobile.png'),animations:'disabled'});
  expect(application.replyRequests).toHaveLength(0);
});
test('uncertain generation is read after reopening; changed messages invalidate the result without another model call',async({page,application})=>{
  const seed=await setup(page,application);await application.answerTest({mode:'unknown'});await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'测试 AI 回复',exact:true});await panel.getByLabel('回复策略',{exact:true}).selectOption(seed.policyId!);
  await panel.getByRole('button',{name:'检索依据',exact:true}).click();await panel.getByRole('button',{name:'生成测试回复',exact:true}).click();
  await expect(panel.getByText('生成结果尚未确认，请先读取结果。',{exact:true})).toBeVisible();await page.keyboard.press('Escape');await page.reload();
  await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();await expect(panel.getByText('生成结果尚未确认，请先读取结果。',{exact:true})).toBeVisible();
  expect(await application.answerTest()).toEqual({embeds:1,generations:1});await application.answerTest({mode:'ready'});await panel.getByRole('button',{name:'读取结果',exact:true}).click();
  await expect(panel.getByTestId('reply-test-result')).toContainText('26 см.');await application.answerTest({append:true});await panel.getByRole('button',{name:'读取结果',exact:true}).click();
  await expect(panel.getByText('会话、策略或知识已变化，请新建测试。',{exact:true})).toBeVisible();await expect(panel.getByTestId('reply-test-result')).toHaveCount(0);
  expect(await application.answerTest()).toEqual({embeds:1,generations:1});expect(application.replyRequests).toHaveLength(0);
});
test('ordinary members cannot see the answer-test action',async({page,context,application})=>{
  const seed=await setup(page,application);const member=await context.browser()!.newContext();try{const p=await member.newPage();await login(p,application,'member@example.invalid');
    await p.goto(`${application.baseURL}/workspace/messages?conversation=${seed.conversationId}`);await expect(p.getByRole('region',{name:'会话内容'})).toBeVisible();
    await expect(p.getByRole('button',{name:'测试 AI 回复',exact:true})).toHaveCount(0);
  }finally{await member.close();}
});
test('storage denial blocks dispatch; a lost retrieval response is recovered with the original test after reload',async({page,application})=>{
  const seed=await setup(page,application);await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('dingbell:reply-test:'))throw new DOMException('synthetic storage denial');return original.call(this,key,value);};});
  await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();const panel=page.getByRole('dialog',{name:'测试 AI 回复',exact:true});
  await panel.getByLabel('回复策略',{exact:true}).selectOption(seed.policyId!);await panel.getByRole('button',{name:'检索依据',exact:true}).click();
  await expect(panel.getByText('无法保存或恢复测试编号，已暂停新测试。请检查浏览器存储权限后刷新页面。',{exact:true})).toBeVisible();
  expect(await application.answerTest()).toEqual({embeds:0,generations:0});await page.reload();
  let requests=0;await page.route('**/reply-tests',async route=>{requests++;await route.fetch();await route.abort();});
  await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();await panel.getByLabel('回复策略',{exact:true}).selectOption(seed.policyId!);
  await panel.getByRole('button',{name:'检索依据',exact:true}).click();await expect(panel.getByText('测试请求结果尚未确认。已保留原测试编号，请先读取结果。',{exact:true})).toBeVisible();
  expect(requests).toBe(1);expect(await application.answerTest()).toEqual({embeds:1,generations:0});await page.reload();
  await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();await expect(panel.getByTestId('reply-test-sources')).toContainText('26 см.');
  expect(requests).toBe(1);expect(await application.answerTest()).toEqual({embeds:1,generations:0});expect(application.replyRequests).toHaveLength(0);
});
test('a pending generation survives closing and reload, and polling observes it without another POST',async({page,application})=>{
  const seed=await setup(page,application);await application.answerTest({mode:'pending'});await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'测试 AI 回复',exact:true});await panel.getByLabel('回复策略',{exact:true}).selectOption(seed.policyId!);
  await panel.getByRole('button',{name:'检索依据',exact:true}).click();await panel.getByRole('button',{name:'生成测试回复',exact:true}).click();
  await expect(panel.getByText('回复正在生成，可以关闭面板后再查看。',{exact:true})).toBeVisible();await page.keyboard.press('Escape');await page.reload();
  await page.getByRole('button',{name:'测试 AI 回复',exact:true}).click();await expect(panel.getByText('回复正在生成，可以关闭面板后再查看。',{exact:true})).toBeVisible();
  expect(await application.answerTest()).toEqual({embeds:1,generations:1});await application.answerTest({mode:'ready'});
  await expect(panel.getByTestId('reply-test-result')).toContainText('26 см.');expect(await application.answerTest()).toEqual({embeds:1,generations:1});expect(application.replyRequests).toHaveLength(0);
});
