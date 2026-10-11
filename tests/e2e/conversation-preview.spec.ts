import { test as base,expect,type Page,type Route } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
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
  const storeId=crypto.randomUUID();const response=await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'俄语预览测试店',clientId:'910007',apiKey:crypto.randomUUID()}});expect(response.status()).toBe(200);
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
const generate=(page:Page)=>page.getByRole('button',{name:'生成俄语预览',exact:true});
const show=(page:Page)=>page.getByRole('button',{name:'查看俄语预览',exact:true});
const confirmation=(page:Page)=>page.getByRole('dialog',{name:'确认发送给消费者',exact:true});
async function capture(page:Page,name:string){await page.screenshot({path:test.info().outputPath(`${name}.png`),fullPage:true,animations:'disabled'});}

test('restoring a failed reply invalidates its old preview while retaining an uncertain translation request',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);app.setReplyBehavior('forbidden');
  const source='请确认商品规格。',commandId=crypto.randomUUID(),replies=`${app.baseURL}/api/companies/company-a/conversations/${history.id}/replies`;
  expect((await page.request.post(commands(app,history.id),{headers:{origin:app.baseURL,'X-DingBell-Member-Id':'owner-a'},data:{commandId,action:'send_reply',expectedVersion:1,body:source}})).status()).toBe(200);
  await expect.poll(async()=>(await (await page.request.get(`${replies}/${commandId}`)).json()).reply.status).toBe('failed');
  await page.goto(messages(app,history.storeId,history.id));const seen=observed(page);await original(page).fill(source);await generate(page).click();await expect(show(page)).toBeEnabled();
  await page.getByRole('button',{name:/^最近发送/}).click();await page.getByRole('dialog',{name:'最近发送',exact:true}).getByRole('button',{name:'恢复为草稿',exact:true}).click();
  await expect(original(page)).toHaveValue(source);await expect(original(page)).toBeFocused();await expect(show(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'恢复翻译原文',exact:true})).toHaveCount(0);expect(seen.previews).toHaveLength(1);expect(seen.sends).toHaveLength(0);
  const lose=async(route:Route)=>{const accepted=await route.fetch();expect(accepted.status()).toBe(200);await route.abort('failed');};await page.route(previews(app,history.id),lose);
  await generate(page).click();await expect(page.getByRole('button',{name:'核对俄语预览',exact:true})).toBeEnabled();
  expect(seen.previews[1]!.body.sourceRevision).toBeGreaterThan(seen.previews[0]!.body.sourceRevision);
  await page.getByRole('button',{name:/^最近发送/}).click();await page.getByRole('dialog',{name:'最近发送',exact:true}).getByRole('button',{name:'恢复为草稿',exact:true}).click();
  await expect(generate(page)).toBeDisabled();await expect(page.getByRole('button',{name:'核对俄语预览',exact:true})).toBeEnabled();await page.unroute(previews(app,history.id),lose);
  await page.reload();await page.getByRole('button',{name:'恢复翻译原文',exact:true}).click();await page.getByRole('button',{name:'核对俄语预览',exact:true}).click();await expect(show(page)).toBeEnabled();
  expect(seen.previews).toHaveLength(2);expect((await app.previewState()).requests).toHaveLength(2);expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(1);
});

test('Russian preview is edited and sent only after explicit confirmation, including mobile keyboard input',async({page,application:app})=>{
  await page.setViewportSize({width:1366,height:768});await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));
  const seen=observed(page),source='请确认商品规格。';await original(page).fill(source);
  await expect(generate(page)).toBeVisible();await generate(page).click();await expect(show(page)).toBeEnabled();
  expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);expect((await app.previewState()).requests).toHaveLength(1);
  await show(page).click();const dialog=confirmation(page);await expect(dialog.getByText(source,{exact:true})).toBeVisible();
  const translated=dialog.getByRole('textbox',{name:'俄语译文',exact:true});await expect(translated).toHaveValue('Пожалуйста, подтвердите характеристики товара.');
  await capture(page,'preview-confirm-desktop');await page.setViewportSize({width:390,height:844});
  await translated.fill('Пожалуйста, проверьте размер товара. '.repeat(30).slice(0,1000));
  await expect(dialog.getByRole('button',{name:'确认发送',exact:true})).toBeInViewport();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);await capture(page,'preview-long-mobile');
  const edited='  Здравствуйте!\nПожалуйста, подтвердите размер.  ';await translated.fill(edited);
  await translated.dispatchEvent('compositionstart');await translated.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});await translated.dispatchEvent('compositionend');
  expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);await expect(translated).toHaveValue(edited);
  await expect(dialog.getByRole('button',{name:'确认发送',exact:true})).toBeInViewport();expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await capture(page,'preview-confirm-mobile');await dialog.getByRole('button',{name:'确认发送',exact:true}).focus();await page.keyboard.press('Enter');
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(seen.sends).toHaveLength(1);expect(seen.sends[0]!.body).toBe(edited);
  expect(seen.sends[0]!.previewRequestId).toBe(seen.previews[0]!.body.requestId);
  expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});expect((await app.previewState()).requests).toHaveLength(1);
});

test('lost translated send responses preserve the preview reference and recover without another model or message',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page);
  await original(page).fill('请核对商品。');await generate(page).click();await expect(show(page)).toBeEnabled();await show(page).click();
  const edited='  Пожалуйста, проверьте товар.  ';await confirmation(page).getByRole('textbox',{name:'俄语译文',exact:true}).fill(edited);
  const lose=async(route:Route)=>{const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed');};
  await page.route(commands(app,history.id),lose);await confirmation(page).getByRole('button',{name:'确认发送',exact:true}).click();
  await expect(page.getByRole('button',{name:'核对提交',exact:true})).toBeEnabled();
  expect(seen.sends).toHaveLength(1);expect(seen.sends[0]!.previewRequestId).toBe(seen.previews[0]!.body.requestId);
  await page.unroute(commands(app,history.id),lose);await page.reload();await expect(page.getByRole('button',{name:'核对提交',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'核对提交',exact:true}).click();await expect(page.getByText(/原提交已找到：/)).toBeVisible();
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});
  expect(seen.sends).toHaveLength(1);expect((await app.previewState()).requests).toHaveLength(1);
});

test('an A to B to A edit never applies a late translation from the earlier source revision',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page),source='原文 A：请确认规格。';
  let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
  const delayed=async(route:Route)=>{const response=await route.fetch();await gate;await route.fulfill({response});};await page.route(previews(app,history.id),delayed);
  try{
    await original(page).fill(source);await generate(page).click();await expect.poll(async()=>(await app.previewState()).requests.length).toBe(1);
    await original(page).fill('原文 B：请确认颜色。');await original(page).fill(source);
    const returned=page.waitForResponse(response=>response.url()===previews(app,history.id));release();await returned;
    await page.unroute(previews(app,history.id),delayed);await expect(generate(page)).toBeEnabled();
    await expect(show(page)).toHaveCount(0);await expect(confirmation(page)).toHaveCount(0);await expect(original(page)).toHaveValue(source);
    await generate(page).click();await expect(show(page)).toBeEnabled();
    expect(seen.previews).toHaveLength(2);expect(seen.previews[1]!.body.source).toBe(source);expect(seen.previews[1]!.body.requestId).not.toBe(seen.previews[0]!.body.requestId);expect(seen.previews[1]!.body.sourceRevision).toBeGreaterThan(seen.previews[0]!.body.sourceRevision);
    expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);
  }finally{release();await page.unroute(previews(app,history.id),delayed);}
});

test('lost translation responses recover after refresh and only an explicit original request retry may submit again',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page),source='已接受但响应丢失的原文。';
  const lose=async(route:Route)=>{const accepted=await route.fetch();expect(accepted.status()).toBe(200);await route.abort('failed');};await page.route(previews(app,history.id),lose);
  await original(page).fill(source);await generate(page).click();await expect(page.getByRole('button',{name:'核对俄语预览',exact:true})).toBeVisible();expect(seen.previews).toHaveLength(1);
  const frozen=seen.previews[0]!;await page.reload();await expect(page.getByRole('button',{name:'恢复翻译原文',exact:true})).toBeVisible();await expect(original(page)).toHaveValue(source);
  await page.getByRole('button',{name:'恢复翻译原文',exact:true}).click();await expect(original(page)).toHaveValue(source);await page.unroute(previews(app,history.id),lose);
  await page.getByRole('button',{name:'核对俄语预览',exact:true}).click();await expect(show(page)).toBeEnabled();expect(seen.previews).toHaveLength(1);expect((await app.previewState()).requests).toHaveLength(1);
  await page.goto(messages(app,history.storeId,history.emptyId));const drop=async(route:Route)=>route.abort('failed');await page.route(previews(app,history.emptyId),drop);
  await original(page).fill('从未到达服务器的第二份原文。');await generate(page).click();await expect(page.getByRole('button',{name:'核对俄语预览',exact:true})).toBeEnabled();expect(seen.previews).toHaveLength(2);
  const second=seen.previews[1]!;await page.reload();await page.getByRole('button',{name:'恢复翻译原文',exact:true}).click();await page.getByRole('button',{name:'核对俄语预览',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试原预览',exact:true})).toBeEnabled();expect(seen.previews).toHaveLength(2);await page.unroute(previews(app,history.emptyId),drop);
  await page.getByRole('button',{name:'重试原预览',exact:true}).click();await expect(show(page)).toBeEnabled();expect(seen.previews).toHaveLength(3);expect(seen.previews[2]).toEqual(second);expect(seen.previews[0]).toEqual(frozen);
  expect((await app.previewState()).requests).toHaveLength(2);expect(app.replyRequests).toHaveLength(0);
});

test('pending translation stays in its conversation and membership and logout clears the local original',async({page,browser,application:app})=>{
  await login(page,app);const history=await seed(page,app);const grant=`${app.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/member-a`;
  expect((await page.request.post(grant,{headers:{origin:app.baseURL},data:{expectedGranted:false,granted:true}})).status()).toBe(200);
  const context=await browser.newContext();try{
    const member=await context.newPage();await login(member,app,'member');await member.goto(messages(app,history.storeId,history.id));const seen=observed(member),privateSource='PRIVATE-OLD-MEMBER-TRANSLATION';
    const drop=async(route:Route)=>route.abort('failed');await member.route(previews(app,history.id),drop);await original(member).fill(privateSource);await generate(member).click();await expect(member.getByRole('button',{name:'核对俄语预览',exact:true})).toBeVisible();
    await member.goto(messages(app,history.storeId,history.emptyId));await expect(member.getByText(privateSource,{exact:true})).toHaveCount(0);await expect(member.getByRole('button',{name:'恢复翻译原文',exact:true})).toHaveCount(0);
    await app.rejoinFixtureMember(history.storeId);await member.goto(messages(app,history.storeId,history.id));await expect(original(member)).toHaveValue('');await expect(member.getByRole('button',{name:'恢复翻译原文',exact:true})).toHaveCount(0);await expect(member.getByText(privateSource,{exact:true})).toHaveCount(0);
    await member.unroute(previews(app,history.id),drop);await original(member).fill('新成员的新翻译原文。');await generate(member).click();await expect(show(member)).toBeEnabled();expect(seen.previews[0]!.memberId).toBe('member-a');expect(seen.previews[1]!.memberId).toBe('member-a-rejoined');
    await member.route(previews(app,history.id),drop);const logoutSource='PRIVATE-LOGOUT-PREVIEW';await original(member).fill(logoutSource);await generate(member).click();await expect(member.getByRole('button',{name:'核对俄语预览',exact:true})).toBeVisible();
    await member.getByRole('button',{name:'退出登录',exact:true}).click();await expect(member).toHaveURL(`${app.baseURL}/login`);expect(await member.evaluate(`Object.values(sessionStorage).some(value=>value.includes(${JSON.stringify(logoutSource)})||value.includes(${JSON.stringify(privateSource)}))`)).toBe(false);
    expect(app.replyRequests).toHaveLength(0);
  }finally{await context.close();}
});

test('budget and browser storage failures preserve the original send path without silently starting translation',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));const seen=observed(page);await original(page).fill('预算不足时仍可发送的原文。');
  await app.setPreviewBudget(false);await generate(page).click();await expect(page.getByRole('alert').filter({hasText:'翻译预算暂不可用。你仍可发送原文。'})).toBeVisible();expect((await app.previewState()).requests).toHaveLength(0);
  await page.getByRole('button',{name:'预览回复',exact:true}).click();await expect(confirmation(page).getByText('预算不足时仍可发送的原文。',{exact:true})).toBeVisible();await confirmation(page).getByRole('button',{name:'返回编辑',exact:true}).click();
  await app.setPreviewBudget(true);const disabled=async(route:Route)=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'TRANSLATION_DISABLED',message:'Synthetic disabled deployment'}})});await page.route(previews(app,history.id),disabled);
  await generate(page).click();await expect(page.getByRole('alert').filter({hasText:'此工作区尚未开启俄语预览。你仍可发送原文。'})).toBeVisible();await page.unroute(previews(app,history.id),disabled);
  await app.setPreviewBehavior('failed');await generate(page).click();await expect(page.getByRole('alert')).toBeVisible();await expect(show(page)).toHaveCount(0);expect((await app.previewState()).requests).toHaveLength(1);
  const before=seen.previews.length;await page.evaluate(`(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===window.sessionStorage)throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);};})()`);
  await generate(page).click();await expect(page.getByRole('alert').filter({hasText:'浏览器无法可靠保存翻译请求，尚未提交。请检查浏览器存储设置。'})).toBeVisible();expect(seen.previews).toHaveLength(before);expect((await app.previewState()).requests).toHaveLength(1);
  await expect(page.getByRole('button',{name:'预览回复',exact:true})).toBeEnabled();expect(seen.sends).toHaveLength(0);expect(app.replyRequests).toHaveLength(0);
});

test('edited Russian survives returning to the draft and a confirmed server rejection without another translation',async({page,application:app})=>{
  await login(page,app);const history=await seed(page,app);await page.goto(messages(app,history.storeId,history.id));
  const seen=observed(page),source='中文草稿保持不变。',edited='  Исправленный ответ.\nПожалуйста, проверьте размер.  ';
  await original(page).fill(source);await generate(page).click();await show(page).click();
  await confirmation(page).getByRole('textbox',{name:'俄语译文',exact:true}).fill(edited);
  await confirmation(page).getByRole('button',{name:'返回编辑',exact:true}).click();await show(page).click();
  await expect(confirmation(page).getByRole('textbox',{name:'俄语译文',exact:true})).toHaveValue(edited);
  const changeBeforeSend=async(route:Route)=>{
    const current=await page.request.get(`${app.baseURL}/api/companies/company-a/conversations/${history.id}/control`);
    expect(current.status()).toBe(200);const version=(await current.json()).control.state.version;
    const changed=await page.request.post(commands(app,history.id),{headers:{origin:app.baseURL},data:{commandId:crypto.randomUUID(),expectedVersion:version,action:'set_work_status',workStatus:'waiting_customer'}});
    expect(changed.status()).toBe(200);const rejected=await route.fetch();expect(rejected.status()).toBe(409);
    expect((await rejected.json()).error.code).toBe('CONVERSATION_CHANGED');await route.fulfill({response:rejected});
  };
  await page.route(commands(app,history.id),changeBeforeSend);
  try{
    await confirmation(page).getByRole('button',{name:'确认发送',exact:true}).click();
    await expect(show(page)).toBeEnabled();await expect(original(page)).toHaveValue(source);expect(app.replyRequests).toHaveLength(0);
  }finally{await page.unroute(commands(app,history.id),changeBeforeSend);}
  await show(page).click();await expect(confirmation(page).getByRole('textbox',{name:'俄语译文',exact:true})).toHaveValue(edited);
  await confirmation(page).getByRole('button',{name:'确认发送',exact:true}).click();
  await expect.poll(()=>app.replyRequests.length).toBe(1);expect(seen.sends).toHaveLength(2);
  expect(seen.sends.map(value=>value.body)).toEqual([edited,edited]);expect(seen.sends[0]!.commandId).not.toBe(seen.sends[1]!.commandId);
  expect(app.replyRequests[0]!.body).toEqual({chat_id:history.threadId,text:edited});expect((await app.previewState()).requests).toHaveLength(1);
});
