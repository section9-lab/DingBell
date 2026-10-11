import {test as base,expect,type Page} from '@playwright/test';
import {join} from 'node:path';
import {startLocalApplication} from '../fixtures/web-identity/local-app.ts';
type App=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{app:App}>({app:async({},use)=>{const app=await startLocalApplication(true,{mail:true,team:'roles',stores:'configured',control:true,replies:true,aiReception:true,aiDraft:true});try{await use(app);}finally{await app.close();}}});
const editor=(page:Page)=>page.getByRole('textbox',{name:'回复原文',exact:true});
const sheet=(page:Page)=>page.getByRole('dialog',{name:'AI 回复草稿',exact:true});
async function setup(page:Page,app:App){
 await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
 const storeId=crypto.randomUUID();expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`,{headers:{origin:app.baseURL},data:{id:storeId,name:'AI 草稿测试店',clientId:'910030',apiKey:crypto.randomUUID()}})).status()).toBe(200);
 await app.prepareReplyStore(storeId);const history=await app.seedConversationHistory(storeId),saved=await app.aiDraft({conversationId:history.id});
 await page.goto(`${app.baseURL}/workspace/messages?${new URLSearchParams({store:storeId,conversation:history.id})}`);return {...history,storeId,saved};
}
async function open(page:Page){await page.getByRole('button',{name:'AI 草稿',exact:true}).click();await expect(sheet(page).getByRole('heading',{name:'回复正文',exact:true})).toBeVisible();await expect(sheet(page)).toHaveCSS('opacity','1');}
async function capture(page:Page,name:string){if(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY)await page.screenshot({path:join(process.env.DINGBELL_TEST_EVIDENCE_DIRECTORY,name),fullPage:true,animations:'disabled'});}
test('review a real saved draft, explicitly adopt it, then send only through manual confirmation',async({page,app})=>{
 await page.setViewportSize({width:1366,height:768});const x=await setup(page,app);await open(page);
 await expect(sheet(page).getByText(x.saved.body,{exact:true})).toBeVisible();await expect(sheet(page).getByRole('heading',{name:'1. 桌面收纳盒 · 尺寸说明',exact:true})).toBeVisible();await expect(sheet(page).getByRole('button',{name:'采纳到回复框',exact:true})).toBeDisabled();
 await capture(page,'ai-draft-desktop.png');await sheet(page).getByRole('button',{name:'关闭',exact:true}).click();await page.getByRole('button',{name:'认领并接管',exact:true}).click();await expect(editor(page)).toBeEnabled();
 const writes:string[]=[];page.on('request',request=>{if(request.method()==='POST'&&request.url().includes('/conversations/'))writes.push(request.url());});
 await open(page);await sheet(page).getByRole('button',{name:'采纳到回复框',exact:true}).click();await expect(sheet(page)).toHaveCount(0);await expect(editor(page)).toHaveValue(x.saved.body);await expect(editor(page)).toBeFocused();expect(writes).toEqual([]);expect(app.replyRequests).toHaveLength(0);
 await page.reload();await expect(editor(page)).toHaveValue(x.saved.body);await page.getByRole('button',{name:'预览回复',exact:true}).click();expect(app.replyRequests).toHaveLength(0);
 await page.getByRole('dialog',{name:'确认发送给消费者',exact:true}).getByRole('button',{name:'确认发送',exact:true}).click();await expect.poll(()=>app.replyRequests.length).toBe(1);expect(app.replyRequests[0].body?.text).toBe(x.saved.body);
});
test('existing input needs explicit replacement and closing a pending adoption protects later edits',async({page,app})=>{
 const x=await setup(page,app);await page.getByRole('button',{name:'认领并接管',exact:true}).click();await expect(editor(page)).toBeEnabled();await editor(page).fill('我手写的回复');await open(page);
 await sheet(page).getByRole('button',{name:'采纳到回复框',exact:true}).click();await expect(sheet(page).getByText('回复框已有内容',{exact:true})).toBeVisible();await sheet(page).getByRole('button',{name:'保留当前输入',exact:true}).click();await sheet(page).getByRole('button',{name:'关闭',exact:true}).click();await expect(editor(page)).toHaveValue('我手写的回复');
 await open(page);await sheet(page).getByRole('button',{name:'采纳到回复框',exact:true}).click();let release:()=>void=()=>{};let held=false;
 await page.route('**/ai-draft',async route=>{const response=await route.fetch();held=true;await new Promise<void>(resolve=>{release=resolve;});await route.fulfill({response}).catch(()=>{});});
 await sheet(page).getByRole('button',{name:'替换当前输入',exact:true}).click();await expect.poll(()=>held).toBe(true);await sheet(page).getByRole('button',{name:'关闭',exact:true}).click();await editor(page).fill('关闭抽屉后继续编辑');release();await page.unroute('**/ai-draft');await expect(editor(page)).toHaveValue('关闭抽屉后继续编辑');expect(app.replyRequests).toHaveLength(0);
 await open(page);await sheet(page).getByRole('button',{name:'采纳到回复框',exact:true}).click();await sheet(page).getByRole('button',{name:'替换当前输入',exact:true}).click();await expect(editor(page)).toHaveValue(x.saved.body);
});
test('withdrawal is rechecked on adoption and a newer message visibly invalidates the draft',async({page,app})=>{
 const x=await setup(page,app);await page.getByRole('button',{name:'认领并接管',exact:true}).click();await expect(editor(page)).toBeEnabled();await open(page);
 await app.aiDraft({withdraw:x.saved.documentId});await sheet(page).getByRole('button',{name:'采纳到回复框',exact:true}).click();await expect(sheet(page).getByText('知识来源已变化，请核对最新资料后重新编写。',{exact:true})).toBeVisible();await expect(sheet(page).getByRole('button',{name:'采纳到回复框',exact:true})).toBeDisabled();
 await x.appendMessage();await sheet(page).getByRole('button',{name:'刷新草稿',exact:true}).click();await expect(sheet(page).getByText('会话已有新消息，这份草稿仅供查看。',{exact:true})).toBeVisible();await sheet(page).getByRole('button',{name:'关闭',exact:true}).click();await expect(editor(page)).toHaveValue('');expect(app.replyRequests).toHaveLength(0);
});
test('the review sheet fits a small screen and removes private content when the session expires',async({page,app})=>{
 await page.setViewportSize({width:390,height:844});const x=await setup(page,app);await open(page);await expect(sheet(page).getByText(x.saved.body,{exact:true})).toBeVisible();
 const bounds=await sheet(page).boundingBox();expect(bounds!.width).toBeLessThanOrEqual(391);expect(bounds!.x).toBeGreaterThanOrEqual(-1);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(391);await expect(sheet(page).getByRole('button',{name:'采纳到回复框',exact:true})).toBeInViewport();await capture(page,'ai-draft-mobile.png');
 expect((await page.request.post(`${app.baseURL}/api/auth/sign-out`,{headers:{origin:app.baseURL},data:{}})).status()).toBe(200);await sheet(page).getByRole('button',{name:'刷新草稿',exact:true}).click();await expect(page.getByText(x.saved.body,{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'登录',exact:true})).toBeVisible();expect(app.replyRequests).toHaveLength(0);
});
