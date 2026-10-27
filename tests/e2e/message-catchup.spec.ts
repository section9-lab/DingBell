import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',sync:true,control:true,replies:true});
  try{await use(app);}finally{await app.close();}
}});
const original=(index:number)=>`原始消息 ${String(index).padStart(3,'0')}\nОригинальное сообщение ${String(index).padStart(3,'0')}`;
const record=(page:Page,index:number)=>page.getByRole('region',{name:'消息记录'}).getByText(original(index),{exact:true});
async function setup(page:Page,app:Application){
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);
  await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
  const storeId=crypto.randomUUID();expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'增量读取测试店',clientId:'910009',apiKey:crypto.randomUUID()}})).status()).toBe(200);
  await app.prepareReplyStore(storeId);const history=await app.seedConversationHistory(storeId);
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/conversations/${history.id}/commands`,{headers:{origin:app.baseURL},data:{commandId:crypto.randomUUID(),expectedVersion:0,action:'claim'}})).status()).toBe(200);
  const url=`${app.baseURL}/workspace/messages?${new URLSearchParams({store:storeId,conversation:history.id})}`;
  await page.goto(url);await expect(record(page,55)).toBeInViewport();
  return {...history,storeId,url};
}

test('live message catch-up appends without resetting the visible window or the reply draft',async({page,application:app})=>{
  const history=await setup(page,app);const draft=page.getByRole('textbox',{name:'回复原文',exact:true});await draft.fill('KEEP-UNSENT-DRAFT');
  const reads:string[]=[];page.on('request',request=>{if(request.url().includes(`/conversations/${history.id}/message`))reads.push(request.url());});
  await history.appendMessage();await expect(record(page,56)).toBeAttached({timeout:15_000});
  expect(reads.some(url=>url.includes('/message-updates?'))).toBe(true);expect(reads.some(url=>url.includes('/messages?'))).toBe(false);
  await expect(record(page,6)).toBeAttached();await expect(draft).toHaveValue('KEEP-UNSENT-DRAFT');
  expect(app.replyRequests).toHaveLength(0);await page.screenshot({path:test.info().outputPath('live-message-window.png')});
});

test('reading history holds new messages and restores the reader position across reload',async({page,application:app})=>{
  const history=await setup(page,app);await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(record(page,1)).toBeAttached();
  await record(page,3).scrollIntoViewIfNeeded();await expect(record(page,3)).toBeInViewport();
  await history.appendMessages(56,2);await expect(page.getByRole('button',{name:'显示新消息',exact:true})).toBeVisible({timeout:12_000});
  await expect(record(page,56)).toHaveCount(0);await expect(record(page,3)).toBeInViewport();
  await page.reload();await expect(record(page,3)).toBeInViewport();await expect(record(page,55)).toHaveCount(0);
  await page.getByRole('button',{name:'显示新消息',exact:true}).click();await expect(record(page,57)).toBeInViewport();await expect(record(page,6)).toBeAttached();
});

test('offline recovery drains a multi-page backlog and locates late history with bounded windows',async({page,application:app})=>{
  test.setTimeout(100_000);const history=await setup(page,app);const draft=page.getByRole('textbox',{name:'回复原文',exact:true});await draft.fill('OFFLINE-DRAFT');
  await page.context().setOffline(true);await expect(page.getByRole('heading',{name:'网络已断开',exact:true})).toBeVisible();
  await history.appendMessages(56,120);await history.appendMessages(176,1,Date.parse('2026-10-09T09:00:00Z'));
  const deliveries:number[]=[];page.on('response',async response=>{if(response.url().includes(`/conversations/${history.id}/message-updates?`)&&response.status()===200){try{for(const item of(await response.json()).messages)deliveries.push(item.sequence);}catch{}}});
  await page.context().setOffline(false);await expect(record(page,175)).toBeAttached({timeout:25_000});
  await expect(page.getByRole('button',{name:'查看较早更新',exact:true})).toBeVisible({timeout:15_000});
  expect(new Set(deliveries).size).toBe(121);await expect(page.getByRole('region',{name:'消息记录'}).getByText(/原始消息 /)).toHaveCount(100);await expect(draft).toHaveValue('OFFLINE-DRAFT');
  await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(record(page,26)).toBeAttached();await expect(record(page,75)).toBeAttached();
  await page.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(record(page,1)).toBeAttached();await expect(record(page,25)).toBeAttached();
  await page.getByRole('button',{name:'查看较早更新',exact:true}).click();await expect(record(page,176)).toBeInViewport();
  await page.getByRole('button',{name:'回到最新消息',exact:true}).click();await expect(record(page,175)).toBeInViewport();await expect(draft).toHaveValue('OFFLINE-DRAFT');expect(app.replyRequests).toHaveLength(0);
  const saved=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dingbell:conversation-position:')).map(([,value])=>value));expect(saved.length).toBe(1);expect(saved[0]).not.toContain('Оригинальное');
  await page.setViewportSize({width:1366,height:900});await page.screenshot({path:test.info().outputPath('catchup-desktop-1366.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:test.info().outputPath('catchup-mobile.png')});
});

test('a scrolled live window pauses delivery and hidden-page polling, then resumes at the saved message',async({page,application:app})=>{
  const history=await setup(page,app);await page.getByRole('region',{name:'消息记录'}).focus();await page.getByRole('region',{name:'消息记录'}).press('Home');await record(page,20).scrollIntoViewIfNeeded();await expect(record(page,20)).toBeInViewport();
  await history.appendMessage();await expect(page.getByRole('button',{name:'显示新消息',exact:true})).toBeVisible({timeout:12_000});await expect(record(page,56)).toHaveCount(0);await expect(record(page,20)).toBeInViewport();
  const calls:string[]=[];page.on('request',request=>{if(request.url().includes('/message-updates?'))calls.push(request.url());});
  await page.clock.install();await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});window.dispatchEvent(new Event('visibilitychange'));");
  const before=calls.length;await page.clock.fastForward(12_000);expect(calls.length).toBe(before);
  const identityRead=page.waitForResponse(response=>response.url().endsWith('/api/workspace-bootstrap')&&response.status()===200);
  await page.evaluate("Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});window.dispatchEvent(new Event('visibilitychange'));");await identityRead;
  await expect(record(page,20)).toBeInViewport();await expect(page.getByRole('button',{name:'显示新消息',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'显示新消息',exact:true}).click();await expect(record(page,56)).toBeInViewport();
});

test('a delayed update cannot populate another conversation and a failed read does not advance the checkpoint',async({page,application:app})=>{
  const history=await setup(page,app);let release:()=>void=()=>{};let captured=false,hold=true;
  await page.route(`**/conversations/${history.id}/message-updates?**`,async route=>{
    if(!hold){await route.continue();return;}
    hold=false;const response=await route.fetch();captured=true;await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({response}).catch(()=>{});
  });
  await history.appendMessage();await expect.poll(()=>captured,{timeout:12_000}).toBe(true);
  await page.getByRole('button',{name:`打开会话 ${history.emptyThreadId}`,exact:true}).click();await expect(page.getByText('暂无已导入消息',{exact:true})).toBeVisible();release();
  await expect(record(page,56)).toHaveCount(0);await page.unrouteAll({behavior:'wait'});
  await page.getByRole('button',{name:`打开会话 ${history.threadId}`,exact:true}).click();await expect(record(page,56)).toBeAttached({timeout:12_000});
  const checkpoint=()=>page.evaluate(id=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dingbell:conversation-position:')).map(([,value])=>JSON.parse(value)).find(value=>value.scope.conversationId===id).position.historyCursor,history.id);const before=await checkpoint();
  let failed=false;await page.route(`**/conversations/${history.id}/message-updates?**`,async route=>{if(failed){await route.continue();return;}failed=true;await route.abort('failed');});
  await history.appendMessages(57,1);await expect.poll(()=>failed,{timeout:12_000}).toBe(true);await expect(page.getByRole('region',{name:'消息记录'})).toHaveCount(0);expect(await checkpoint()).toBe(before);
  await expect(record(page,57)).toBeAttached({timeout:12_000});await expect(record(page,56)).toBeAttached();expect(app.replyRequests).toHaveLength(0);
});

test('replacement membership starts a new reading scope and revocation clears saved positions',async({page,browser,application:app})=>{
  const history=await setup(page,app),grant=(member:string)=>`${app.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/${member}`;
  expect((await page.request.post(grant('member-a'),{headers:{origin:app.baseURL},data:{expectedGranted:false,granted:true}})).status()).toBe(200);
  const context=await browser.newContext();try{
    const member=await context.newPage();await member.goto(`${app.baseURL}/login`);await member.getByLabel('邮箱',{exact:true}).fill('member@example.invalid');await member.getByLabel('密码',{exact:true}).fill(app.password);await member.getByRole('button',{name:'登录',exact:true}).click();await member.getByRole('button',{name:'测试公司 A',exact:true}).click();
    await member.goto(history.url);await record(member,55).waitFor({state:'attached'});await member.getByRole('button',{name:'查看更早消息',exact:true}).click();await expect(record(member,1)).toBeAttached();
    await app.rejoinFixtureMember(history.storeId);await expect(record(member,55)).toBeAttached({timeout:16_000});await expect(record(member,1)).toHaveCount(0);
    const positions=()=>member.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dingbell:conversation-position:')).map(([,value])=>JSON.parse(value)));
    expect((await positions()).some(value=>value.scope.memberId==='member-a-rejoined')).toBe(true);
    expect((await page.request.post(grant('member-a-rejoined'),{headers:{origin:app.baseURL},data:{expectedGranted:true,granted:false}})).status()).toBe(200);
    await expect(page.getByRole('region',{name:'消息记录'})).toBeVisible();await expect(member.getByRole('region',{name:'消息记录'})).toHaveCount(0,{timeout:15_000});await expect.poll(positions).toEqual([]);
  }finally{await context.close();}
});

test('unavailable position storage is visible while current messages and drafts remain usable',async({page,application:app})=>{
  await page.addInitScript(()=>{const write=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('dingbell:conversation-position:'))throw new DOMException('Synthetic quota','QuotaExceededError');return write.call(this,key,value);};});
  const history=await setup(page,app);await expect(page.getByText('阅读位置恢复不可用；当前消息仍可查看，请勿依赖刷新后恢复位置。',{exact:true})).toBeVisible();
  const draft=page.getByRole('textbox',{name:'回复原文',exact:true});await draft.fill('QUOTA-UNSENT-DRAFT');await history.appendMessage();await expect(record(page,56)).toBeAttached({timeout:12_000});await expect(draft).toHaveValue('QUOTA-UNSENT-DRAFT');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page).toHaveURL(`${app.baseURL}/login`);expect(await page.evaluate(()=>Object.keys(sessionStorage).some(key=>key.startsWith('dingbell:conversation-position:')))).toBe(false);
});
