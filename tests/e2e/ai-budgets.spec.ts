import {test as base,expect,type Page} from '@playwright/test';
import {startLocalApplication} from '../fixtures/web-identity/local-app.ts';
type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{const app=await startLocalApplication(true,{mail:true,team:'roles'});try{await use(app);}finally{await app.close();}}});
async function login(page:Page,app:Application,email='owner@example.invalid'){
 await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByRole('button',{name:'测试公司 A',exact:true}).click();await page.getByRole('link',{name:'公司设置',exact:true}).click();
}
async function draft(page:Page){await page.getByRole('button',{name:'新建接待预算',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建接待预算',exact:true});
 await dialog.getByLabel('接待金额上限（USD）',{exact:true}).fill('0.25');await dialog.getByLabel('接待次数上限',{exact:true}).fill('20');return dialog;}
test('managers create, enable and pause reception budgets while test budgets remain separate',async({page,application})=>{
 await login(page,application);await expect(page.getByRole('tab',{name:'AI 接待',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByText('接待服务：未启用',{exact:true})).toBeVisible();await expect(page.getByText('模型与价格：未配置',{exact:true})).toBeVisible();const dialog=await draft(page);
 await dialog.getByRole('button',{name:'创建预算',exact:true}).click();await expect(dialog).toBeHidden();const current=page.getByTestId('current-reception-budget');await expect(current).toContainText('已暂停');await expect(current).toContainText('$0.25');await expect(current).toContainText('0 / 20');
 await current.getByRole('button',{name:'启用预算',exact:true}).click();await expect(current).toContainText('已启用');await current.getByRole('button',{name:'暂停预算',exact:true}).click();await expect(current).toContainText('已暂停');
 await page.getByRole('tab',{name:'策略测试',exact:true}).click();await expect(page.getByTestId('current-test-budget')).toHaveCount(0);await expect(page.getByRole('button',{name:'新建测试预算',exact:true})).toBeVisible();
 await page.getByRole('tab',{name:'AI 接待',exact:true}).click();await expect(current).toContainText('$0.25');await page.getByTestId('reception-budget-audit').getByText('最近 10 条管理操作',{exact:true}).click();await expect(page.getByTestId('reception-budget-audit')).toContainText('暂停预算');
 await page.screenshot({path:test.info().outputPath('reception-budgets-desktop.png'),fullPage:true,animations:'disabled'});
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);await page.screenshot({path:test.info().outputPath('reception-budgets-mobile.png'),fullPage:true,animations:'disabled'});
});
test('a lost reception budget acknowledgement is read back without repeating the write',async({page,application})=>{
 await login(page,application);let posts=0;await page.route('**/ai-budgets',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort();}else await route.continue();});
 const dialog=await draft(page);await dialog.getByRole('button',{name:'创建预算',exact:true}).click();await expect(dialog.getByRole('button',{name:'创建预算',exact:true})).toBeDisabled();await expect(dialog.getByText('操作结果尚未确认。请读取当前预算和管理记录，再决定下一步。',{exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'读取当前预算',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByTestId('current-reception-budget')).toContainText('$0.25');await page.reload();await expect(page.getByTestId('current-reception-budget')).toContainText('$0.25');expect(posts).toBe(1);
});
test('ordinary members cannot see either company budget or management actions',async({page,application})=>{
 await login(page,application,'member@example.invalid');await expect(page.getByRole('heading',{name:'公司设置',exact:true})).toBeVisible();await expect(page.getByRole('tab',{name:'AI 接待',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'新建接待预算',exact:true})).toHaveCount(0);
});
test('reviewed server configuration shows full-run cost independently of service enablement',async({page})=>{
 const aiConfiguration=JSON.stringify({maxGenerations:2,model:{provider:'nvidia',model:'nvidia/nemotron-3-super-120b-a12b',modelConfigVersion:'support-v1',promptVersion:'support-v1',maxInputTokens:262144,maxOutputTokens:2048,
  pricing:{version:'synthetic-only',currency:'USD',inputMicrosPerMillion:1000000,outputMicrosPerMillion:1000000,cacheReadMicrosPerMillion:1000000,cacheWriteMicrosPerMillion:1000000}}});
 const app=await startLocalApplication(true,{mail:true,team:'roles',aiConfiguration});try{
  await login(page,app);await expect(page.getByText('接待服务：未启用',{exact:true})).toBeVisible();await expect(page.getByText('模型与价格：已配置',{exact:true})).toBeVisible();
  await expect(page.getByText('模型：nvidia/nemotron-3-super-120b-a12b',{exact:true})).toBeVisible();await expect(page.getByText(/每次接待最多预留 \$0\.528384/)).toBeVisible();
  await page.screenshot({path:test.info().outputPath('configured-reception-budget.png'),fullPage:true,animations:'disabled'});
 }finally{await app.close();}
});
