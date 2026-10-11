import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type LocalApplication = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: LocalApplication; configured: boolean }>({
  configured: [true, { option: true }],
  application: async ({ configured }, use) => {
    const application = await startLocalApplication(configured);
    try { await use(application); } finally { await application.close(); }
  },
});

async function fillLogin(page: Page, password: string, email = 'owner@example.invalid') {
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(password).catch(() => {
    throw new Error('Synthetic password input failed');
  });
}

async function signIn(page: Page, application: LocalApplication, email?: string) {
  await page.goto(`${application.baseURL}/login`);
  await fillLogin(page, application.password, email);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(`${application.baseURL}/workspace`);
}

test('anonymous workspace deep link presents the real login page', async ({ page, application }) => {
  await page.goto(`${application.baseURL}/workspace`);
  await expect(page).toHaveURL(`${application.baseURL}/login`);
  await expect(page.getByRole('heading', { name: '登录 DingBell', exact: true })).toBeVisible();
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible();
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password');
  const response = await page.request.get(`${application.baseURL}/api/no-such-endpoint`);
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
});

test('incorrect credentials keep the user on the form with a useful generic error', async ({ page, application }) => {
  await page.goto(`${application.baseURL}/login`);
  await fillLogin(page, 'deliberately-incorrect-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/邮箱|密码|登录/);
  await expect(page).toHaveURL(`${application.baseURL}/login`);
  await expect(page.getByLabel('邮箱', { exact: true })).toHaveValue('owner@example.invalid');
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled();
});

test('anonymous focus revalidation preserves typed credentials', async ({ page, application }) => {
  await page.goto(`${application.baseURL}/login`);
  await fillLogin(page, application.password);
  const refreshedSetup = page.waitForResponse(response => new URL(response.url()).pathname === '/api/setup');
  const refreshedSession = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/get-session');
  await page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  })()`);
  await Promise.all([refreshedSetup, refreshedSession]);
  try {
    const email = await page.getByLabel('邮箱', { exact: true }).inputValue();
    const password = await page.getByLabel('密码', { exact: true }).inputValue();
    expect({ emailRetained: email === 'owner@example.invalid', passwordRetained: password === application.password })
      .toEqual({ emailRetained: true, passwordRetained: true });
  } finally {
    // Keep generated credentials out of failure-time accessibility snapshots.
    await page.getByLabel('密码', { exact: true }).fill('');
  }
});

test('one pending sign-in leads through company selection, switching, refresh and logout', async ({ page, application }) => {
  let loginRequests = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/auth/sign-in/email', async route => {
    loginRequests += 1;
    await pending;
    await route.continue();
  });
  try {
    await page.goto(`${application.baseURL}/login`);
    await fillLogin(page, application.password);
    const submit = page.getByRole('button', { name: /登录/ });
    await submit.dblclick();
    await expect.poll(() => loginRequests).toBe(1);
    await expect(submit).toBeDisabled();
    release();
    await expect(page).toHaveURL(`${application.baseURL}/workspace`);
    await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /测试公司 A/ }).click();
    await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
    await expect(page.getByText('测试公司 A', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '切换公司', exact: true }).click();
    await page.getByRole('menuitem', { name: /测试公司 B/ }).click();
    await expect(page.getByText('测试公司 B', { exact: true }).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
    await expect(page.getByText('测试公司 B', { exact: true }).first()).toBeVisible();
    const active = await page.request.get(`${application.baseURL}/api/companies`);
    expect((await active.json()).activeCompanyId).toBe('company-b');
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(`${application.baseURL}/login`);
    await expect(page.getByLabel('密码', { exact: true })).toBeEmpty();
    expect((await page.request.get(`${application.baseURL}/api/companies`)).status()).toBe(401);
    expect(loginRequests).toBe(1);
  } finally { release(); }
});

test('revoking the active membership removes that company from the refreshed workspace', async ({ page, application }) => {
  await signIn(page, application);
  await page.getByRole('button', { name: /测试公司 A/ }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  await application.removeMembership('company-a');
  await page.reload();
  await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /测试公司 A/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /测试公司 B/ })).toBeVisible();
});

test('an authenticated user without memberships sees an honest empty state', async ({ page, application }) => {
  await signIn(page, application, 'empty@example.invalid');
  await expect(page.getByRole('heading', { name: '尚未加入公司', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeEnabled();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toHaveCount(0);
});

test('a temporary company-loading failure can be retried explicitly', async ({ page, application }) => {
  await signIn(page, application);
  await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
  let requests = 0;
  await page.route('**/api/companies', async route => {
    requests += 1;
    if (requests === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        error: { code: 'TEMPORARILY_UNAVAILABLE', message: 'Synthetic availability test' }, requestId: crypto.randomUUID(),
      }) });
    } else await route.continue();
  });
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(requests).toBe(1);
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
  expect(requests).toBeGreaterThanOrEqual(2);
});

test('offline workspace hides company data and reconnects only after verifying the session', async ({ page, context, application }) => {
  let sessionReads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/auth/get-session') sessionReads += 1;
  });
  await signIn(page, application);
  await page.getByRole('button', { name: /测试公司 A/ }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  const readsBeforeOffline = sessionReads;
  await context.setOffline(true);
  try {
    await expect(page.getByText('网络已断开', { exact: true })).toBeVisible();
    await expect(page.getByText('测试公司 A', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toHaveCount(0);
  } finally { await context.setOffline(false); }
  await expect.poll(() => sessionReads).toBeGreaterThan(readsBeforeOffline);
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  await expect(page.getByText('测试公司 A', { exact: true }).first()).toBeVisible();
});

test('an unconfirmed activation rereads actual company state without resending the change', async ({ page, application }) => {
  await signIn(page, application);
  await page.getByRole('button', { name: /测试公司 A/ }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  let activations = 0;
  let companyReads = 0;
  page.on('request', request => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/companies') companyReads += 1;
  });
  await page.route('**/api/companies/company-b/activate', async route => {
    activations += 1;
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    await route.fulfill({ response: committed, status: 503, contentType: 'application/json', body: JSON.stringify({
      error: { code: 'OPERATION_UNCONFIRMED', message: 'Synthetic completion failure' }, requestId: crypto.randomUUID(),
    }) });
  });
  await page.getByRole('button', { name: '切换公司', exact: true }).click();
  await page.getByRole('menuitem', { name: /测试公司 B/ }).click();
  await expect(page.getByRole('alert')).toContainText('操作结果暂未确认');
  await expect(page.getByText('测试公司 B', { exact: true }).first()).toBeVisible();
  expect(companyReads).toBeGreaterThanOrEqual(1);
  expect(activations).toBe(1);
  const active = await page.request.get(`${application.baseURL}/api/companies`);
  expect((await active.json()).activeCompanyId).toBe('company-b');
});

test('login, company selection and workspace fit a narrow viewport', async ({ page, application }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${application.baseURL}/login`);
  await expect(page.getByRole('heading', { name: '登录 DingBell', exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await fillLogin(page, application.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.getByRole('button', { name: /测试公司 A/ }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.getByRole('button', { name: '打开或收起导航', exact: true }).click();
  await page.getByRole('button', { name: '切换公司', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: /测试公司 B/ })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});

test.describe('installation without authentication configuration', () => {
  test.use({ configured: false });
  test('shows the missing configuration and disables sign-in', async ({ page, application }) => {
    await page.goto(`${application.baseURL}/login`);
    await expect(page.getByText('登录服务尚未配置', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled();
  });
});
