import {test,expect} from '@playwright/test';
import {startLocalApplication} from '../fixtures/web-identity/local-app.ts';

test('能力与数据总览列出部署开关、四类同步与接待准备，并可就地开关同步', async ({page}) => {
  const app = await startLocalApplication(true, {mail:true,team:'roles',stores:'configured',sync:true,control:true});
  try {
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${app.baseURL}/login`);
    await page.getByLabel('邮箱',{exact:true}).fill('owner@example.invalid');
    await page.getByRole('button',{name:'密码登录',exact:true}).click({timeout:1500}).catch(()=>{});await page.getByLabel('密码',{exact:true}).fill(app.password);
    await page.getByRole('button',{name:'登录',exact:true}).click();
    await page.getByRole('button',{name:'测试公司 A',exact:true}).click();
    const api=`${app.baseURL}/api/companies/company-a`,headers={origin:app.baseURL,'X-DingBell-Member-Id':'owner-a'};
    const post=async(path:string,data:unknown)=>{const response=await page.request.post(`${api}${path}`,{headers,data});expect(response.status(),await response.text()).toBe(200);return await response.json();};
    const storeId=crypto.randomUUID();
    await post('/stores',{id:storeId,name:'Mirava',clientId:'910001',apiKey:crypto.randomUUID()});
    await post(`/stores/${storeId}/check`,{expectedRevision:1});

    await page.goto(`${app.baseURL}/workspace/capabilities`);
    await expect(page.getByRole('heading',{name:'能力与数据',exact:true})).toBeVisible();
    const main=page.locator('#main-content');
    for (const name of ['会话同步','商品同步','FBS 包裹同步','FBO 包裹同步']) await expect(main.getByText(name,{exact:true})).toBeVisible();
    for (const name of ['回复策略','知识库发布','人工回复发送','AI 托管接待','AI 自动发送']) await expect(main.getByText(name,{exact:true})).toBeVisible();
    // Deployment switches state their variable names instead of offering an in-app toggle.
    await expect(page.getByText('OUTBOUND_ENABLED',{exact:false}).first()).toBeVisible();
    await expect(page.getByRole('button',{name:'复制',exact:true})).toBeVisible();
    // Copying reports through the global toast live region instead of a transient label.
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:app.baseURL});
    await page.getByRole('button',{name:'复制',exact:true}).click();
    const notifications=page.getByRole('region',{name:'通知',exact:true});
    await expect(notifications).toContainText('部署配置片段已复制到剪贴板。');
    await notifications.locator('button[aria-label="关闭通知"]').click();
    await expect(notifications).not.toContainText('部署配置片段已复制到剪贴板。');

    // Enabling one stream is a real write; the row reflects the new state without leaving the page.
    await page.getByRole('button',{name:'启用',exact:true}).first().click();
    await expect(page.getByRole('button',{name:'停止',exact:true}).first()).toBeEnabled({timeout:20_000});
    await page.reload();
    await expect(page.getByRole('button',{name:'停止',exact:true}).first()).toBeEnabled({timeout:20_000});
    await page.screenshot({path:test.info().outputPath('capabilities-desktop.png'),fullPage:true,animations:'disabled'});

    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot({path:test.info().outputPath('capabilities-mobile.png'),fullPage:true,animations:'disabled'});
  } finally { await app.close(); }
});
