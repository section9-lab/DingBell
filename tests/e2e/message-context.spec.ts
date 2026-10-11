import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',sync:true,control:true,replies:true});
  try{await use(app);}finally{await app.close();}
}});
async function setup(page:Page,app:Application){
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');
  await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
  const storeId=crypto.randomUUID();
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'上下文验证店',clientId:'930001',apiKey:crypto.randomUUID()}})).status()).toBe(200);
  const history=await app.seedConversationHistory(storeId),sources=await app.seedMessageContext(storeId,history.id);
  await page.goto(`${app.baseURL}/workspace/messages?store=${storeId}&conversation=${history.id}`);
  return {...history,...sources};
}
test('context shows provenance, exact product and split postings in a responsive panel',async({page,application})=>{
  await page.setViewportSize({width:1440,height:1000});const sources=await setup(page,application);
  const aside=page.getByRole('complementary',{name:'会话上下文'});
  await expect(aside.getByLabel('消息上下文')).toHaveValue(sources.first);
  await expect(aside.getByText('桌面收纳盒',{exact:true})).toBeVisible();
  await expect(aside.getByText('平台状态：delivering',{exact:true})).toHaveCount(10);
  expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
  await page.screenshot({path:test.info().outputPath('context-orders-1440.png'),animations:'disabled'});
  await aside.getByRole('button',{name:'下一页包裹',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(aside.getByText('SYNTHETIC-ORDER-001-11',{exact:true})).toBeVisible();
  await expect(aside.getByText('平台状态：delivering',{exact:true})).toHaveCount(2);
  await expect(aside.getByRole('button',{name:'下一页包裹',exact:true})).toBeDisabled();
  await expect(aside.getByRole('button',{name:'上一页包裹',exact:true})).toBeFocused();
  await aside.getByRole('button',{name:'上一页包裹',exact:true}).click();
  await expect(aside.getByText('平台状态：delivering',{exact:true})).toHaveCount(10);
  await expect(aside.getByRole('button',{name:'下一页包裹',exact:true})).toBeFocused();
  await aside.getByLabel('消息上下文').selectOption(sources.second);
  await expect(aside.getByText('尚未导入匹配的 FBS 订单。',{exact:true})).toBeVisible();
  await expect(aside.getByText('平台状态：delivering',{exact:true})).toHaveCount(0);
  await aside.getByLabel('消息上下文').selectOption(sources.presale);
  await expect(aside.getByText('这条消息没有携带订单号。',{exact:true})).toBeVisible();
  await expect(aside.getByText('桌面收纳盒',{exact:true})).toBeVisible();
  await page.screenshot({path:test.info().outputPath('context-desktop.png'),animations:'disabled'});
  for(const width of [1366,390]){
    await page.setViewportSize({width,height:844});await page.getByRole('button',{name:'会话详情',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'会话详情',exact:true});await expect(dialog.getByLabel('消息上下文')).toBeVisible();
    await dialog.getByLabel('消息上下文').selectOption(sources.presale);await expect(dialog.getByText('桌面收纳盒',{exact:true})).toBeVisible();
    expect(await page.evaluate('document.documentElement.scrollWidth<=innerWidth')).toBe(true);
    expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    await page.screenshot({path:test.info().outputPath(`context-${width}.png`),animations:'disabled'});await page.keyboard.press('Escape');
    await expect(page.getByRole('button',{name:'会话详情',exact:true})).toBeFocused();
  }
  expect(application.replyRequests).toHaveLength(0);
});

test('changing context ignores a late previous response and hides stale facts on a read failure',async({page,application})=>{
  await page.setViewportSize({width:1600,height:1000});const sources=await setup(page,application);
  const aside=page.getByRole('complementary',{name:'会话上下文'});
  await expect(aside.getByText('桌面收纳盒',{exact:true})).toBeVisible();
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const pattern=`**/messages/${sources.first}/context`;
  await page.route(pattern,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response});});
  try{
    await page.reload();await started;
    await aside.getByLabel('消息上下文').selectOption(sources.second);
    await expect(aside.getByText('尚未导入匹配的 FBS 订单。',{exact:true})).toBeVisible();
    release();await page.unrouteAll({behavior:'wait'});
    await expect(aside.getByText('平台状态：delivering',{exact:true})).toHaveCount(0);
    await page.route(`**/messages/${sources.presale}/context`,route=>route.fulfill({status:503,json:{error:{code:'SERVICE_UNAVAILABLE'}}}));
    await aside.getByLabel('消息上下文').selectOption(sources.presale);
    await expect(aside.getByRole('button',{name:'重新读取商品与订单',exact:true})).toBeVisible();
    await expect(aside.getByText('桌面收纳盒',{exact:true})).toHaveCount(0);
    await page.unrouteAll({behavior:'wait'});await aside.getByRole('button',{name:'重新读取商品与订单',exact:true}).click();
    await expect(aside.getByText('桌面收纳盒',{exact:true})).toBeVisible();
  }finally{release();await page.unrouteAll({behavior:'wait'});}
  expect(application.replyRequests).toHaveLength(0);
});

test('denied context clears visible customer facts through the existing workspace authorization reset',async({page,application})=>{
  await page.setViewportSize({width:1600,height:1000});const sources=await setup(page,application);
  const aside=page.getByRole('complementary',{name:'会话上下文'});
  await expect(aside.getByText('桌面收纳盒',{exact:true})).toBeVisible();
  await page.route(`**/messages/${sources.second}/context`,route=>route.fulfill({status:404,json:{error:{code:'NOT_FOUND'}}}));
  await aside.getByLabel('消息上下文').selectOption(sources.second);
  await expect(page.getByText('桌面收纳盒',{exact:true})).toHaveCount(0);
  await expect.poll(()=>new URL(page.url()).searchParams.has('conversation')).toBe(false);
  expect(application.replyRequests).toHaveLength(0);
});

test('new messages preserve the selected order instead of falling back to another reference',async({page,application})=>{
  await page.setViewportSize({width:1600,height:1000});const sources=await setup(page,application);
  const aside=page.getByRole('complementary',{name:'会话上下文'}),choice=aside.getByLabel('消息上下文');
  await expect(choice).toHaveValue(sources.first);
  // Keep the presale selection while a newer, different order arrives first in the options.
  await choice.selectOption(sources.presale);await expect(aside.getByText('这条消息没有携带订单号。',{exact:true})).toBeVisible();
  await sources.appendSecond();
  await expect(page.getByRole('region',{name:'消息记录'})).toContainText('合成消息');
  await expect.poll(async()=>choice.locator('option').first().getAttribute('value'),{timeout:15000}).not.toBe(sources.first);
  await expect(choice).toHaveValue(sources.presale);
  // Now select the second order; another message replaces its representative source ID.
  await choice.selectOption(await choice.locator('option').first().getAttribute('value')??'');
  const latest=await sources.appendSecond(true);
  await expect(choice).toHaveValue(latest,{timeout:15000});
  await expect(aside.getByText('尚未导入匹配的 FBS 订单。',{exact:true})).toBeVisible();
});
