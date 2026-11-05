import { test as base,expect,type Page,type Route } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
import { signOut } from './support/session.ts';
type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{
  const application=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',sync:true,control:true,replies:true,preview:true});
  try{await use(application);}finally{await application.close();}
}});
async function login(page:Page,app:Application,actor='owner'){
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
}
const commands=(app:Application,id:string)=>`${app.baseURL}/api/companies/company-a/conversations/${id}/commands`;
const previews=(app:Application,id:string)=>`${app.baseURL}/api/companies/company-a/conversations/${id}/reply-previews`;
const messages=(app:Application,storeId:string,id:string)=>`${app.baseURL}/workspace/messages?${new URLSearchParams({store:storeId,conversation:id})}`;
async function seed(page:Page,app:Application){
  const storeId=crypto.randomUUID();const response=await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'俄语翻译测试店',clientId:'910007',apiKey:crypto.randomUUID()}});expect(response.status()).toBe(200);
  await app.prepareReplyStore(storeId);const history=await app.seedConversationHistory(storeId);
  for(const id of [history.id,history.emptyId])expect((await page.request.post(commands(app,id),{headers:{origin:app.baseURL},data:{commandId:crypto.randomUUID(),expectedVersion:0,action:'claim'}})).status()).toBe(200);
  return {storeId,...history};
}
type Request={requestId:string;source:string;sourceRevision:number};
function observed(page:Page){
  const previews:{body:Request;memberId:string}[]=[],sends:{body:string;action:string;commandId:string;previewRequestId?:string}[]=[];
  page.on('request',request=>{if(request.method()!=='POST')return;
    if(request.url().endsWith('/reply-previews'))previews.push({body:request.postDataJSON(),memberId:request.headers()['x-dingbell-member-id']!});
    if(request.url().endsWith('/commands')&&request.postDataJSON().action==='send_reply')sends.push(request.postDataJSON());
  });return {previews,sends};
}
const original=(page:Page)=>page.getByRole('textbox',{name:'回复原文',exact:true});
const translate=(page:Page)=>page.getByRole('button',{name:'翻译成俄语',exact:true});
const translated=(page:Page)=>page.getByRole('textbox',{name:'俄语译文',exact:true});
const send=(page:Page)=>page.getByRole('button',{name:'发送',exact:true});
const checkTranslation=(page:Page)=>page.getByRole('button',{name:'核对翻译结果',exact:true});
async function capture(page:Page,name:string){await page.screenshot({path:test.info().outputPath(`${name}.png`),fullPage:true,animations:'disabled'});}

test('translated Russian is edited in place and only an explicit send submits it, including mobile keyboard input',async({page,application:app})=>{
  await page.setViewportSize({width:1366,height:768});await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));
  const seen=observed(page),source='请确认商品规格。';await original(page).fill(source);
  await expect(translate(page)).toBeVisible();await translate(page).click();
  await expect(translated(page)).toHaveValue('Пожалуйста, подтвердите характеристики товара.');
  expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);expect((await app.previewState()).requests).toHaveLength(1);
  await capture(page,'translation-inline-desktop');await page.setViewportSize({width:390,height:844});
  await translated(page).fill('Пожалуйста, проверьте размер товара. '.repeat(30).slice(0,1000));
  await expect(send(page)).toBeInViewport();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);await capture(page,'translation-long-mobile');
  const edited='  Здравствуйте!\nПожалуйста, подтвердите размер.  ';await translated(page).fill(edited);
  await translated(page).dispatchEvent('compositionstart');await translated(page).dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await translated(page).dispatchEvent('compositionend');
  expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);await expect(translated(page)).toHaveValue(edited);
  await expect(send(page)).toBeInViewport();expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture(page,'translation-inline-mobile');await send(page).focus();await page.keyboard.press('Enter');
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(seen.sends).toHaveLength(1);expect(seen.sends[0]!.body).toBe(edited);
  expect(seen.sends[0]!.previewRequestId).toBe(seen.previews[0]!.body.requestId);
  expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});expect((await app.previewState()).requests).toHaveLength(1);
});

test('lost translated send responses preserve the translation reference and recover without another model or message',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page);
  await original(page).fill('请核对商品。');await translate(page).click();await expect(translated(page)).toBeVisible();
  const edited='  Пожалуйста, проверьте товар.  ';await translated(page).fill(edited);
  const lose=async(route:Route)=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');};
  await page.route(commands(app,history.id),lose);await send(page).click();
  await expect(page.getByRole('button',{name:'核对提交',exact:true})).toBeEnabled();
  expect(seen.sends).toHaveLength(1);expect(seen.sends[0]!.previewRequestId).toBe(seen.previews[0]!.body.requestId);
  await page.unroute(commands(app,history.id),lose);await page.reload();await expect(page.getByRole('button',{name:'核对提交',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'核对提交',exact:true}).click();
  await expect(page.getByRole('button',{name:'核对提交',exact:true})).toHaveCount(0);
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});
  expect(seen.sends).toHaveLength(1);expect((await app.previewState()).requests).toHaveLength(1);
});

test('a late translation for an earlier source never becomes the sendable text',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page),source='原文 A：请确认规格。';
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const delayed=async(route:Route)=>{const response=await route.fetch();await gate;await route.fulfill({response});};await page.route(previews(app,history.id),delayed);
  try{
    await original(page).fill(source);await translate(page).click();await expect.poll(async()=>(await app.previewState()).requests.length).toBe(1);
    await original(page).fill('原文 B：请确认颜色。');
    const returned=page.waitForResponse(response=>response.url()===previews(app,history.id));release();await returned;
    await page.unroute(previews(app,history.id),delayed);
    await expect(page.getByText('原文已修改，译文未更新。请重新翻译，或直接发送原文。',{exact:true})).toBeVisible();
    await expect(translated(page)).toHaveCount(0);await expect(original(page)).toHaveValue('原文 B：请确认颜色。');
    expect(seen.previews).toHaveLength(1);expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);
    await send(page).click();await expect.poll(()=>app.replyRequests.length).toBe(1);
    expect(seen.sends).toHaveLength(1);expect(seen.sends[0]!.body).toBe('原文 B：请确认颜色。');expect(seen.sends[0]!.previewRequestId).toBeUndefined();
    expect((await app.previewState()).requests).toHaveLength(1);
  }finally{release();await page.unroute(previews(app,history.id),delayed);}
});

test('lost translation responses recover after refresh and only an explicit original request retry may submit again',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page),source='已接受但响应丢失的原文。';
  const lose=async(route:Route)=>{const accepted=await route.fetch();expect(accepted.status()).toBe(200);await route.abort('failed');};await page.route(previews(app,history.id),lose);
  await original(page).fill(source);await translate(page).click();await expect(checkTranslation(page)).toBeVisible();expect(seen.previews).toHaveLength(1);
  const frozen=seen.previews[0]!;await page.reload();await expect(checkTranslation(page)).toBeVisible();await expect(original(page)).toHaveValue(source);
  await page.unroute(previews(app,history.id),lose);
  await checkTranslation(page).click();await expect(translated(page)).toBeVisible();expect(seen.previews).toHaveLength(1);expect((await app.previewState()).requests).toHaveLength(1);
  await page.goto(messages(app,history.storeId,history.emptyId));const drop=async(route:Route)=>route.abort('failed');await page.route(previews(app,history.emptyId),drop);
  await original(page).fill('从未到达服务器的第二份原文。');await translate(page).click();await expect(checkTranslation(page)).toBeEnabled();expect(seen.previews).toHaveLength(2);
  const second=seen.previews[1]!;await page.reload();await checkTranslation(page).click();
  await expect(page.getByRole('button',{name:'重试原翻译',exact:true})).toBeEnabled();expect(seen.previews).toHaveLength(2);await page.unroute(previews(app,history.emptyId),drop);
  await page.getByRole('button',{name:'重试原翻译',exact:true}).click();await expect(translated(page)).toBeVisible();expect(seen.previews).toHaveLength(3);expect(seen.previews[2]).toEqual(second);expect(seen.previews[0]).toEqual(frozen);
  expect((await app.previewState()).requests).toHaveLength(2);expect(app.replyRequests).toHaveLength(0);
});

test('pending translation stays in its conversation and membership and logout clears the local original',async({page,browser,application:app})=>{
  await login(page,app);const history=await seed(page,app);const grant=`${app.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grant,{headers:{origin:app.baseURL},data:{expectedGranted:false,granted:true}})).status()).toBe(200);
  const context=await browser.newContext();try{
    const member=await context.newPage();await login(member,app,'member');await member.goto(messages(app,history.storeId,history.id));const seen=observed(member),privateSource='PRIVATE-OLD-MEMBER-TRANSLATION';
    const drop=async(route:Route)=>route.abort('failed');await member.route(previews(app,history.id),drop);await original(member).fill(privateSource);await translate(member).click();await expect(checkTranslation(member)).toBeVisible();
    await member.goto(messages(app,history.storeId,history.emptyId));await expect(member.getByText(privateSource,{exact:true})).toHaveCount(0);await expect(checkTranslation(member)).toHaveCount(0);
    await app.rejoinFixtureMember(history.storeId);await member.goto(messages(app,history.storeId,history.id));await expect(original(member)).toHaveValue('');await expect(checkTranslation(member)).toHaveCount(0);await expect(member.getByText(privateSource,{exact:true})).toHaveCount(0);
    await member.unroute(previews(app,history.id),drop);await original(member).fill('新成员的新翻译原文。');await translate(member).click();await expect(translated(member)).toBeVisible();expect(seen.previews[0]!.memberId).toBe('member-a');expect(seen.previews[1]!.memberId).toBe('member-a-rejoined');
    await member.route(previews(app,history.id),drop);const logoutSource='PRIVATE-LOGOUT-TRANSLATION';await original(member).fill(logoutSource);await translate(member).click();await expect(checkTranslation(member)).toBeVisible();
    await signOut(member);await expect(member).toHaveURL(`${app.baseURL}/login`);expect(await member.evaluate(`Object.values(sessionStorage).some(value=>value.includes(${JSON.stringify(logoutSource)})||value.includes(${JSON.stringify(privateSource)}))`)).toBe(false);
    expect(app.replyRequests).toHaveLength(0);
  }finally{await context.close();}
});

test('budget and browser storage failures preserve the original send path without silently starting translation',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page);await original(page).fill('预算不足时仍可发送的原文。');
  await app.setPreviewBudget(false);await translate(page).click();await expect(page.getByText('翻译额度暂不可用，可以直接发送原文。',{exact:true})).toBeVisible();expect((await app.previewState()).requests).toHaveLength(0);
  await expect(send(page)).toBeEnabled();
  await app.setPreviewBudget(true);const disabled=async(route:Route)=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'TRANSLATION_DISABLED',message:'Synthetic disabled deployment'}})});await page.route(previews(app,history.id),disabled);
  await translate(page).click();await expect(page.getByText('此工作区尚未开启俄语翻译，可以直接发送原文。',{exact:true})).toBeVisible();await page.unroute(previews(app,history.id),disabled);
  await app.setPreviewBehavior('failed');await translate(page).click();await expect(page.getByText('未能生成俄语译文，可以直接发送原文。',{exact:true})).toBeVisible();await expect(translated(page)).toHaveCount(0);expect((await app.previewState()).requests).toHaveLength(1);
  const before=seen.previews.length;await page.evaluate(`(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===window.sessionStorage)throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);};})()`);
  await translate(page).click();await expect(page.getByText('浏览器无法可靠保存翻译请求，尚未提交。请检查浏览器存储设置。',{exact:true})).toBeVisible();expect(seen.previews).toHaveLength(before);expect((await app.previewState()).requests).toHaveLength(1);
  await expect(send(page)).toBeEnabled();expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);
});

test('edited Russian survives a rejected send and is resubmitted without another translation',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));
  const seen=observed(page),source='中文草稿保持不变。',edited='  Исправленный ответ.\nПожалуйста, проверьте размер.  ';
  await original(page).fill(source);await translate(page).click();await expect(translated(page)).toBeVisible();
  await translated(page).fill(edited);
  const changeBeforeSend=async(route:Route)=>{
    const current=await page.request.get(`${app.baseURL}/api/companies/company-a/conversations/${history.id}/control`);
    expect(current.status()).toBe(200);const version=(await current.json()).control.state.version;
    const changed=await page.request.post(commands(app,history.id),{headers:{origin:app.baseURL},data:{commandId:crypto.randomUUID(),expectedVersion:version,action:'set_work_status',workStatus:'waiting_customer'}});
    expect(changed.status()).toBe(200);const rejected=await route.fetch();expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error.code).toBe('CONVERSATION_CHANGED');await route.fulfill({response:rejected});
  };
  await page.route(commands(app,history.id),changeBeforeSend);
  try{
    await send(page).click();
    // 被服务器拒绝时编辑器保留刚才提交的确切文本，不会丢字，也不会自动重发。
    await expect(original(page)).toHaveValue(edited);expect(app.replyRequests).toHaveLength(0);expect(seen.sends).toHaveLength(1);
  }finally{await page.unroute(commands(app,history.id),changeBeforeSend);}
  await expect(send(page)).toBeEnabled({timeout:25_000});
  await send(page).click();
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(seen.sends).toHaveLength(2);
  expect(seen.sends.map(value=>value.body)).toEqual([edited,edited]);expect(seen.sends[0]!.commandId).not.toBe(seen.sends[1]!.commandId);
  expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});expect((await app.previewState()).requests).toHaveLength(1);
});
