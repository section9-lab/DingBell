import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({
  application: async (_fixtures, use) => {
    const app = await startLocalApplication(true, {
      mail: true,
      team: 'roles',
      stores: 'configured',
      control: true,
      replies: true,
    });
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
});
async function login(page: Page, app: Application, email = 'owner@example.invalid') {
  await page.goto(`${app.baseURL}/login`);
  await page.getByRole('button', { name: '密码登录', exact: true }).click();
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(app.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}
async function store(page: Page, app: Application) {
  const id = crypto.randomUUID();
  expect(
    (
      await page.request.post(`${app.baseURL}/api/companies/company-a/stores`, {
        headers: { origin: app.baseURL },
        data: {
          id,
          name: '策略验证店',
          clientId: '930001',
          apiKey: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(200);
  return id;
}
async function createPolicy(page: Page, name = '售前接待') {
  await page.getByRole('button', { name: '新建策略', exact: true }).click();
  const card = page.getByRole('dialog', { name: '新建策略', exact: true });
  await expect(card.getByRole('heading', { name: '新建策略', exact: true })).not.toBeVisible();
  await expect(card.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await card.getByLabel('策略名称', { exact: true }).fill(name);
  await card
    .getByLabel('提示词内容', { exact: true })
    .fill('先回答消费者的问题，再补充必要的使用建议。');
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: `编辑策略：${name}`, exact: true })).toBeVisible();
}

test('a single strategy list edits through one card and saves directly', async ({
  page,
  application,
}) => {
  await login(page, application);
  await page.getByRole('link', { name: '回复策略', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('主动通知', { exact: true })).toHaveCount(0);
  await expect(page.getByText('创建第一条回复策略', { exact: true })).toBeVisible();
  await createPolicy(page);
  await expect(page.getByRole('table')).toContainText('已启用');
  await page.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  const card = page.getByRole('dialog', { name: '编辑策略', exact: true });
  await expect(card.getByLabel('策略名称', { exact: true })).toHaveValue('售前接待');
  await expect(card.getByLabel('提示词内容', { exact: true })).toHaveValue(
    '先回答消费者的问题，再补充必要的使用建议。',
  );
  await expect(card.getByText('生成建议', { exact: true })).toHaveCount(0);
  await expect(card.getByTestId('policy-effective')).toHaveCount(0);
  await card.getByLabel('回复语气', { exact: true }).selectOption('friendly');
  await card.getByLabel('回复语言', { exact: true }).selectOption('ru');
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '编辑策略', exact: true })
      .getByLabel('回复语气', { exact: true }),
  ).toHaveValue('friendly');
  await page
    .getByRole('dialog', { name: '编辑策略', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '编辑策略', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: test.info().outputPath('reply-policies-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.getByRole('button', { name: '新建策略', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '新建策略', exact: true })
      .getByRole('button', { name: '保存', exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('reply-policies-mobile.png'),
    animations: 'disabled',
  });
  expect(application.replyRequests).toHaveLength(0);
});

test('the card requires a name, keeps one stage, and guards unsaved changes', async ({
  page,
  application,
}) => {
  await login(page, application);
  await page.goto(`${application.baseURL}/workspace/reply-policies`);
  await page.getByRole('button', { name: '新建策略', exact: true }).click();
  const card = page.getByRole('dialog', { name: '新建策略', exact: true });
  const save = card.getByRole('button', { name: '保存', exact: true });
  await expect(save).toBeDisabled();
  await expect(card.getByRole('radio', { name: '售前咨询', exact: true })).toBeChecked();
  await card.getByLabel('策略名称', { exact: true }).fill('需要名称的策略');
  await expect(save).toBeEnabled();
  await card.getByRole('radio', { name: '售中订单查询', exact: true }).check();
  await expect(card.getByRole('radio', { name: '售前咨询', exact: true })).not.toBeChecked();
  await card.getByLabel('提示词内容', { exact: true }).fill('未保存的内容');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(card.getByLabel('提示词内容', { exact: true })).toHaveValue('未保存的内容');
  await card.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '放弃并关闭', exact: true }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole('button', { name: '新建策略', exact: true }).click();
  await page
    .getByRole('dialog', { name: '新建策略', exact: true })
    .getByRole('button', { name: '取消', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '新建策略', exact: true })).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(0);
});

test('a competing save keeps local input and offers an explicit reload', async ({
  page,
  context,
  application,
}) => {
  await login(page, application);
  await page.goto(`${application.baseURL}/workspace/reply-policies`);
  await createPolicy(page);
  await page.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑策略', exact: true })
    .getByLabel('策略名称', { exact: true })
    .fill('本地尚未保存');
  const other = await context.newPage();
  await other.goto(`${application.baseURL}/workspace/reply-policies`);
  await other.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  const otherCard = other.getByRole('dialog', { name: '编辑策略', exact: true });
  await otherCard.getByLabel('策略名称', { exact: true }).fill('另一管理员的修改');
  await otherCard.getByRole('button', { name: '保存', exact: true }).click();
  await expect(otherCard).toHaveCount(0);
  const card = page.getByRole('dialog', { name: '编辑策略', exact: true });
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(
    card.getByText('策略已被修改，请读取最新版本并核对后再操作。', { exact: true }),
  ).toBeVisible();
  await expect(card.getByLabel('策略名称', { exact: true })).toHaveValue('本地尚未保存');
  await card.getByRole('button', { name: '读取最新策略', exact: true }).click();
  await expect(card.getByLabel('策略名称', { exact: true })).toHaveValue('另一管理员的修改');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await other.close();
  expect(application.replyRequests).toHaveLength(0);
});

test('store scope can be limited to selected stores', async ({ page, application }) => {
  await login(page, application);
  const storeId = await store(page, application);
  await page.goto(`${application.baseURL}/workspace/reply-policies`);
  await page.getByRole('button', { name: '新建策略', exact: true }).click();
  const card = page.getByRole('dialog', { name: '新建策略', exact: true });
  const save = card.getByRole('button', { name: '保存', exact: true });
  await expect(card.getByRole('radio', { name: '全部店铺', exact: true })).toBeChecked();
  await card.getByRole('radio', { name: '指定店铺', exact: true }).check();
  await expect(save).toBeDisabled();
  await card.getByRole('checkbox', { name: '策略验证店', exact: true }).check();
  await expect(save).toBeEnabled();
  await card.getByLabel('策略名称', { exact: true }).fill('仅指定店铺');
  await save.click();
  await expect(card).toHaveCount(0);
  const list = (await (
    await page.request.get(
      `${application.baseURL}/api/companies/company-a/reply-policies?kind=automatic`,
    )
  ).json()) as { policies: { id: string; name: string }[] };
  const created = list.policies.find((policy) => policy.name === '仅指定店铺');
  expect(created).toBeTruthy();
  const detail = (await (
    await page.request.get(
      `${application.baseURL}/api/companies/company-a/reply-policies/${created!.id}`,
    )
  ).json()) as { policy: { published: { config: { storeIds: string[] } } } };
  expect(detail.policy.published.config.storeIds).toEqual([storeId]);
});

test('members cannot configure policies and losing access closes the card', async ({
  page,
  context,
  application,
}) => {
  await login(page, application);
  await page.goto(`${application.baseURL}/workspace/reply-policies`);
  await createPolicy(page);
  await page.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  const selected = new URL(page.url()).searchParams.get('policy');
  expect(selected).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '编辑策略', exact: true })).toHaveCount(0);
  const member = await context.browser()!.newContext(),
    staff = await member.newPage();
  try {
    await login(staff, application, 'member@example.invalid');
    await staff.goto(`${application.baseURL}/workspace/reply-policies?policy=${selected}`);
    await expect(staff.getByRole('alert').filter({ hasText: '需要管理员权限' })).toBeVisible();
    await expect(staff.getByLabel('策略名称', { exact: true })).toHaveCount(0);
    expect(
      (
        await staff.request.get(
          `${application.baseURL}/api/companies/company-a/reply-policies/${selected}`,
        )
      ).status(),
    ).toBe(403);
  } finally {
    await member.close();
  }
  await page.getByRole('button', { name: '编辑策略：售前接待', exact: true }).click();
  await page
    .getByRole('dialog', { name: '编辑策略', exact: true })
    .getByLabel('策略名称', { exact: true })
    .fill('撤权后不能保留的编辑页');
  await application.removeMembership('company-a');
  await page
    .getByRole('dialog', { name: '编辑策略', exact: true })
    .getByRole('button', { name: '保存', exact: true })
    .click();
  await expect(page.getByRole('dialog', { name: '编辑策略', exact: true })).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(0);
});
