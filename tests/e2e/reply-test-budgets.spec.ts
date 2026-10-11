import { test as base,expect,type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
type Application=Awaited<ReturnType<typeof startLocalApplication>>;
const test=base.extend<{application:Application}>({application:async({},use)=>{const app=await startLocalApplication(true,{mail:true,team:'roles'});try{await use(app);}finally{await app.close();}}});
async function login(page:Page,app:Application,email='owner@example.invalid'){
  await page.goto(`${app.baseURL}/login`);await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(app.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await page.getByRole('button',{name:'测试公司 A',exact:true}).click();await page.getByRole('link',{name:'公司设置',exact:true}).click();
}
async function draft(page:Page){await page.getByRole('tab',{name:'策略测试',exact:true}).click();await page.getByRole('button',{name:'新建测试预算',exact:true}).click();const dialog=page.getByRole('dialog',{name:'新建测试预算',exact:true});
  await dialog.getByLabel('生成金额上限（USD）',{exact:true}).fill('0.10');await dialog.getByLabel('生成次数上限',{exact:true}).fill('10');return dialog;}
test('owners configure paused test budgets, enable and pause with visible usage and audit history',async({page,application})=>{
  await login(page,application);const dialog=await draft(page);await expect(dialog.getByText('创建后，时间窗、金额和次数不能修改。预算默认暂停。',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'创建预算',exact:true}).click();await expect(dialog).toBeHidden();
  const current=page.getByTestId('current-test-budget');await expect(current).toContainText('已暂停');await expect(current).toContainText('$0.10');await expect(current).toContainText('0 / 10');
  await current.getByRole('button',{name:'启用预算',exact:true}).click();await expect(current).toContainText('已启用');
  await current.getByRole('button',{name:'暂停预算',exact:true}).click();await expect(current).toContainText('已暂停');await expect(page.getByTestId('test-budget-audit')).toContainText('暂停预算');
  await page.reload();await page.getByRole('tab',{name:'策略测试',exact:true}).click();await expect(current).toContainText('已暂停');await page.screenshot({path:test.info().outputPath('test-budgets-desktop.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);await page.screenshot({path:test.info().outputPath('test-budgets-mobile.png'),fullPage:true,animations:'disabled'});
});
test('a lost budget creation acknowledgement requires reading state and never repeats the write automatically',async({page,application})=>{
  await login(page,application);let posts=0;await page.route('**/reply-test-budgets',async route=>{if(route.request().method()==='POST'){posts++;await route.fetch();await route.abort();}else await route.continue();});
  const dialog=await draft(page);await dialog.getByRole('button',{name:'创建预算',exact:true}).click();
  await expect(dialog.getByText('操作结果尚未确认。请读取当前预算和管理记录，再决定下一步。',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'创建预算',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'读取当前预算',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByTestId('current-test-budget')).toContainText('$0.10');expect(posts).toBe(1);
  await page.reload();await page.getByRole('tab',{name:'策略测试',exact:true}).click();await expect(page.getByTestId('current-test-budget')).toContainText('$0.10');expect(posts).toBe(1);
});
test('ordinary members see company timezone but no budget controls or usage',async({page,application})=>{
  await login(page,application,'member@example.invalid');await expect(page.getByRole('heading',{name:'公司设置',exact:true})).toBeVisible();await expect(page.getByText('时间与时区',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'新建测试预算',exact:true})).toHaveCount(0);await expect(page.getByTestId('current-test-budget')).toHaveCount(0);
});
