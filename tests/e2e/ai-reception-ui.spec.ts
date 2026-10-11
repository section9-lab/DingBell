import {test as base,expect,type Page} from '@playwright/test';
import {startLocalApplication} from '../fixtures/web-identity/local-app.ts';
const aiConfiguration=JSON.stringify({maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
 pricing:{version:'synthetic-only',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}});
async function setup(page:Page){
 const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',control:true,aiReception:true,aiConfiguration});
 try{
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
  const api=`${app.baseURL}/api/companies/company-a`,headers={origin:app.baseURL,'X-DingBell-Member-Id':'owner-a'};
  const post=async(path:string,data:unknown)=>{const response=await page.request.post(`${api}${path}`,{headers,data});expect(response.status(),await response.text()).toBe(200);return await response.json();};
  const storeId=crypto.randomUUID();await post('/stores',{id:storeId,name:'恢复接待测试店',clientId:'910001',apiKey:crypto.randomUUID()});await post(`/stores/${storeId}/check`,{expectedRevision:1});
  const history=await app.seedConversationHistory(storeId);await app.prepareAiReceptionConversation(history.id);
  const policyId=crypto.randomUUID();await post('/reply-policies',{id:policyId,config:{kind:'automatic',name:'合成自动接待',storeIds:[storeId],priority:50,stages:['presale','order','aftersale'],mode:'automatic',language:'customer',tone:'concise',instructions:''}});
  await post(`/reply-policies/${policyId}/test`,{expectedVersion:1});await post(`/reply-policies/${policyId}/publish`,{expectedVersion:2});
  const budgetId=crypto.randomUUID(),startsAt=Math.floor(Date.now()/86400000)*86400000;await post('/ai-budgets',{id:budgetId,action:'create',startsAt,endsAt:startsAt+86400000,limitMicros:2000000,maxRuns:10});await post('/ai-budgets',{id:crypto.randomUUID(),action:'set_enabled',budgetId,expectedRevision:0,enabled:true});
  const path=`/conversations/${history.id}`,url=`${app.baseURL}/workspace/messages?${new URLSearchParams({store:storeId,conversation:history.id})}`;
  await page.goto(url);return {app,post,path,url};
 }catch(error){await app.close();throw error;}
}
const test=base.extend<{reception:Awaited<ReturnType<typeof setup>>}>({reception:async({page},use)=>{const reception=await setup(page);try{await use(reception);}finally{await reception.app.close();}}});
async function resume(page:Page){await page.getByRole('button',{name:'恢复 AI 接待',exact:true}).click();const dialog=page.getByRole('dialog',{name:'恢复 AI 接待？',exact:true});await expect(dialog).toContainText('只接待此后的新消息');await dialog.getByRole('button',{name:'确认恢复',exact:true}).click();}
test('explicit confirmation waits for new input and human takeover clears the waiting state',async({page,reception})=>{
 await page.getByRole('button',{name:'恢复 AI 接待',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'恢复 AI 接待',exact:true})).toBeFocused();
 await resume(page);await expect(page.getByText('等待新消息',{exact:true})).toBeVisible();await expect(page.getByText('AI 处理中',{exact:true})).toHaveCount(0);
 await page.setViewportSize({width:1366,height:768});await page.screenshot({path:test.info().outputPath('reception-waiting-laptop.png'),fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);await page.screenshot({path:test.info().outputPath('reception-waiting-mobile.png'),fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'接管会话',exact:true}).click();await expect(page.getByText('人工处理',{exact:true})).toBeVisible();await expect(page.getByText('等待新消息',{exact:true})).toHaveCount(0);await expect(page.getByText('已恢复，等待新消息。',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'恢复 AI 接待',exact:true})).toBeEnabled();expect(reception.app.replyRequests).toHaveLength(0);
});
test('refresh recovers a lost acknowledgement without resubmission or undoing a later human takeover',async({page,reception})=>{
 let posts=0;await page.route('**/ai-resumptions',async route=>{posts++;await route.fetch();await route.abort();});
 await resume(page);await expect(page.getByRole('button',{name:'核对恢复结果',exact:true})).toBeEnabled();expect(posts).toBe(1);
 await reception.post(`${reception.path}/commands`,{commandId:crypto.randomUUID(),expectedVersion:1,action:'takeover'});await page.reload();
 await expect(page.getByText('恢复操作已确认；会话随后已更新，以当前状态为准。',{exact:true})).toBeVisible();await expect(page.getByText('人工处理',{exact:true})).toBeVisible();await expect(page.getByText('等待新消息',{exact:true})).toHaveCount(0);expect(posts).toBe(1);
});
test('an unreceived operation survives reload and retries only on explicit action with its original ID',async({page,reception})=>{
 const bodies:string[]=[];await page.route('**/ai-resumptions',async route=>{bodies.push(route.request().postData()!);if(bodies.length===1)await route.abort();else await route.continue();});
 await resume(page);await expect(page.getByRole('button',{name:'核对恢复结果',exact:true})).toBeEnabled();await page.reload();
 await expect(page.getByText('暂未查到原操作结果。可以继续核对，或使用同一操作重试。',{exact:true})).toBeVisible();expect(bodies).toHaveLength(1);
 await page.getByRole('button',{name:'重试原操作',exact:true}).click();await expect(page.getByText('等待新消息',{exact:true})).toBeVisible();expect(bodies).toHaveLength(2);expect(bodies[1]).toBe(bodies[0]);expect(reception.app.replyRequests).toHaveLength(0);
});
test('unavailable deployment is explained and a rejected new command leaves no pending recovery',async({page,reception})=>{
 await page.route('**/ai-resumptions',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:{code:'AI_DISABLED',message:'Automatic reception is disabled.'}})}));
 await resume(page);await expect(page.getByText('AI 接待尚未启用，请联系部署管理员。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'核对恢复结果',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'恢复 AI 接待',exact:true})).toBeEnabled();expect(reception.app.replyRequests).toHaveLength(0);
});
test('a never received command can be cleared after a later human action fences its original version',async({page,reception})=>{
 let posts=0;await page.route('**/ai-resumptions',async route=>{posts++;await route.abort();});await resume(page);await expect(page.getByRole('button',{name:'核对恢复结果',exact:true})).toBeEnabled();
 await reception.post(`${reception.path}/commands`,{commandId:crypto.randomUUID(),expectedVersion:0,action:'claim'});await page.reload();
 await expect(page.getByText('会话已被后续操作更新，旧恢复请求不会再改变当前状态。',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'核对恢复结果',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'恢复 AI 接待',exact:true})).toBeEnabled();expect(posts).toBe(1);
});
