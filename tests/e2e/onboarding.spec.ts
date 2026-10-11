import { test as base, expect } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application; mailEnabled: boolean; empty: boolean }>({
  mailEnabled: [false, { option: true }],
  empty: [false, { option: true }],
  application: async ({ mailEnabled, empty }, use) => {
    const app = await startLocalApplication(true, { mail: mailEnabled, empty });
    try { await use(app); } finally { await app.close(); }
  },
});

async function mailLink(application: Application, recipient: string, path: string) {
  await expect.poll(() => application.mailbox.some(mail => mail.to === recipient && mail.text.includes(path))).toBe(true);
  const message = application.mailbox.findLast(mail => mail.to === recipient && mail.text.includes(path))!;
  const url = message.text.split('\n').find(line => line.startsWith(application.baseURL));
  expect(!!url).toBe(true);
  return url!;
}

test.describe('first company installation', () => {
  test.use({ mailEnabled: true, empty: true });
  test('owner creation survives a refresh and only finishes after email verification', async ({ page, context, application }) => {
    await page.goto(`${application.baseURL}/setup`);
    await page.getByLabel('安装令牌', { exact: true }).fill(application.installationSecret);
    await page.getByRole('button', { name: '验证安装权限', exact: true }).click();
    await page.getByLabel('公司名称', { exact: true }).fill('安装测试公司');
    await page.getByLabel('你的姓名', { exact: true }).fill('测试所有者');
    await page.getByLabel('所有者邮箱', { exact: true }).fill('new-owner@example.invalid');
    await page.getByRole('button', { name: '保存并继续', exact: true }).click();
    await page.getByLabel('设置账号密码', { exact: true }).fill(application.password);
    await page.getByRole('button', { name: '创建账号并验证邮箱', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('验证邮件已提交邮件服务');
    const link = await mailLink(application, 'new-owner@example.invalid', '/verify-email#');
    expect(await (await page.request.get(`${application.baseURL}/api/auth/get-session`)).json()).toBe(null);
    await page.reload();
    await expect(page.getByLabel('安装令牌', { exact: true })).toBeEmpty();
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    await page.getByLabel('安装令牌', { exact: true }).fill(application.installationSecret);
    await page.getByRole('button', { name: '验证安装权限', exact: true }).click();
    await expect(page.getByText('安装测试公司', { exact: true })).toBeVisible();
    const verification = await context.newPage();
    await verification.goto(link);
    await verification.getByRole('button', { name: '确认验证邮箱' }).click();
    await expect(verification.getByRole('heading', { name: '邮箱已验证' })).toBeVisible();
    await verification.close();
    await page.getByLabel('账号密码', { exact: true }).fill(application.password);
    await page.getByRole('button', { name: '继续安装', exact: true }).click();
    await page.getByRole('button', { name: '安装测试公司', exact: true }).click();
    await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
    await page.goto(`${application.baseURL}/setup`);
    await expect(page.getByRole('heading', { name: '安装已完成' })).toBeVisible();
  });
});

test.describe('team and password email flows', () => {
  test.use({ mailEnabled: true });
  test('owner invites a new colleague who verifies and explicitly accepts the invitation', async ({ page, browser, application }) => {
    await page.goto(`${application.baseURL}/login`);
    await page.getByLabel('邮箱', { exact: true }).fill('owner@example.invalid');
    await page.getByLabel('密码', { exact: true }).fill(application.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
    await page.getByRole('link', { name: '团队成员', exact: true }).click();
    await page.getByLabel('成员邮箱', { exact: true }).fill('colleague@example.invalid');
    await page.getByRole('button', { name: '发送邀请', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('邀请已提交邮件服务');
    const inviteLink = await mailLink(application, 'colleague@example.invalid', '/invite/');
    const colleague = await browser.newContext();
    try {
      const invitationPage = await colleague.newPage();
      await invitationPage.goto(inviteLink);
      await invitationPage.getByRole('button', { name: '使用受邀邮箱创建账号' }).click();
      await invitationPage.getByLabel('你的姓名', { exact: true }).fill('测试同事');
      await invitationPage.getByLabel('受邀邮箱', { exact: true }).fill('colleague@example.invalid');
      await invitationPage.getByLabel('设置密码', { exact: true }).fill(application.password);
      await invitationPage.getByRole('button', { name: '创建账号并验证邮箱' }).click();
      await expect(invitationPage.getByRole('status')).toContainText('验证邮件已提交邮件服务');
      const verification = await colleague.newPage();
      await verification.goto(await mailLink(application, 'colleague@example.invalid', '/verify-email#'));
      await verification.getByRole('button', { name: '确认验证邮箱' }).click();
      await expect(verification.getByRole('heading', { name: '邮箱已验证' })).toBeVisible();
      await verification.close();
      await invitationPage.getByRole('link', { name: '已验证，前往登录' }).click();
      await invitationPage.getByLabel('邮箱', { exact: true }).fill('colleague@example.invalid');
      await invitationPage.getByLabel('密码', { exact: true }).fill(application.password);
      await invitationPage.getByRole('button', { name: '登录', exact: true }).click();
      await expect(invitationPage).toHaveURL(inviteLink);
      await invitationPage.getByRole('button', { name: '接受邀请并进入公司' }).click();
      await expect(invitationPage.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
      const response = await invitationPage.request.get(`${application.baseURL}/api/companies`);
      expect((await response.json()).companies.map((company: { role: string }) => company.role)).toEqual(['member']);
    } finally { await colleague.close(); }
  });

  test('password recovery confirms a new password without automatically signing in', async ({ page, application }) => {
    await page.goto(`${application.baseURL}/forgot-password`);
    await page.getByLabel('邮箱', { exact: true }).fill('owner@example.invalid');
    await page.getByRole('button', { name: '提交请求' }).click();
    await expect(page.getByRole('status')).toContainText('请求已受理');
    await page.goto(await mailLink(application, 'owner@example.invalid', '/reset-password#'));
    await page.getByLabel('新密码', { exact: true }).fill(application.password + '-new');
    await page.getByLabel('确认新密码', { exact: true }).fill(application.password + '-new');
    await page.getByRole('button', { name: '更新密码' }).click();
    await expect(page.getByRole('heading', { name: '密码已更新' })).toBeVisible();
    expect(await (await page.request.get(`${application.baseURL}/api/auth/get-session`)).json()).toBe(null);
  });
});

test('installation with missing mail configuration explains what is needed and cannot create an owner', async ({ page, application }) => {
  await page.goto(`${application.baseURL}/setup`);
  await expect(page.getByRole('heading', { name: '首次安装 DingBell' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '安装配置尚未就绪' })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建账号并验证邮箱' })).toHaveCount(0);
});

test('mail confirmation removes the fragment and requires an explicit confirmation click', async ({ page, application }) => {
  let posts = 0;
  const tokens: string[] = [];
  await page.route('**/api/auth/verify-email', async route => { posts++; tokens.push(route.request().postDataJSON().token); await route.continue(); });
  await page.goto(`${application.baseURL}/verify-email#token=synthetic-invalid-token`);
  await expect(page.getByRole('heading', { name: '确认你的邮箱' })).toBeVisible();
  await expect(page).toHaveURL(`${application.baseURL}/verify-email`);
  expect(posts).toBe(0);
  await page.getByRole('button', { name: '确认验证邮箱' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(posts).toBe(1);
  await page.evaluate("window.location.hash = 'token=synthetic-replacement-token'");
  await expect(page).toHaveURL(`${application.baseURL}/verify-email`);
  await page.getByRole('button', { name: '确认验证邮箱' }).click();
  await expect.poll(() => posts).toBe(2);
  expect(tokens).toEqual(['synthetic-invalid-token', 'synthetic-replacement-token']);
});
