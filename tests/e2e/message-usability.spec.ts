import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({ application: [async ({}, use) => {
  const application = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true, replies: true });
  try { await use(application); } finally { await application.close(); }
}, { timeout: 90_000 }] });

async function setup(page: Page, app: Application, longName = false) {
  if (longName) await app.renameFixtureMember('客服负责人'.repeat(20), 'owner');
  await page.goto(`${app.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(app.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
  const storeId = crypto.randomUUID();
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`, { headers: { origin: app.baseURL }, data: {
    id: storeId, name: '长名称家居及数码用品客户服务测试店', clientId: '910008', apiKey: crypto.randomUUID(),
  } })).status()).toBe(200);
  await app.prepareReplyStore(storeId);
  const history = await app.seedConversationHistory(storeId, { neighbors: 50 });
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/conversations/${history.id}/commands`, {
    headers: { origin: app.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: 0, action: 'claim' },
  })).status()).toBe(200);
  const url = `${app.baseURL}/workspace/messages?${new URLSearchParams({ store: storeId, conversation: history.id })}`;
  await page.goto(url);
  await expect(page.getByRole('textbox', { name: '回复原文', exact: true })).toBeEnabled();
  return { ...history, url };
}

async function containedFocus(page: Page, dialog: Locator) {
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    await expect.poll(() => dialog.evaluate(node => node.contains(node.ownerDocument.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => dialog.evaluate(node => node.contains(node.ownerDocument.activeElement))).toBe(true);
}

test('long names and a full draft keep history, reply actions and keyboard dialogs usable', async ({ page, application }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await setup(page, application, true);
  await expect(page.getByRole('main')).toHaveCount(1);
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  const body = ('请确认商品规格。\nЗдравствуйте! Сверхдлинноесловодляпроверкипереносатекста.\n').repeat(20).slice(0, 1000);
  await draft.fill(body);
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const region = page.getByRole('region', { name: '消息记录', exact: true });
    const send = page.getByRole('button', { name: '发送', exact: true });
    // Wait for the split layout's ResizeObserver before taking geometry snapshots.
    await expect.poll(async () => (await region.boundingBox())!.height).toBeGreaterThanOrEqual(120);
    const boxes = { viewport, history: await region.boundingBox(), draft: await draft.boundingBox(), send: await send.boundingBox() };
    await writeFile(test.info().outputPath(`layout-${viewport.width}.json`), JSON.stringify(boxes, null, 2));
    await page.screenshot({ path: test.info().outputPath(`layout-${viewport.width}.png`) });
    expect(boxes.history!.height).toBeGreaterThanOrEqual(120);
    for (const box of [boxes.draft!, boxes.send!]) {
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth && window.scrollY === 0')).toBe(true);
    const details = page.getByRole('button', { name: '会话详情', exact: true });
    await details.focus(); await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: '会话详情', exact: true });
    await expect(drawer).toBeVisible(); await expect(drawer).toHaveAccessibleDescription('查看商品、订单包裹、消息来源与同步范围。');
    await containedFocus(page, drawer);
    await page.keyboard.press('Escape'); await expect(drawer).toBeHidden(); await expect(details).toBeFocused();
    // 发送是单步动作，这里只校验按钮可用与可聚焦，不触发真实发送。
    await send.focus();
    expect(await send.evaluate(node => node.ownerDocument.defaultView!.getComputedStyle(node).boxShadow)).not.toBe('none');
    await expect(draft).toHaveValue(body);
  }
  expect(application.replyRequests).toHaveLength(0);
});

test('a failed control read blocks actions, preserves the draft and offers a keyboard recovery path', async ({ page, application }) => {
  const history = await setup(page, application);
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  await draft.fill('确认规格'); await draft.press('Enter'); await draft.press('ArrowUp');
  await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  await expect.poll(async () => (await draft.inputValue()).trim()).toBe('确认规格');
  expect(application.replyRequests).toHaveLength(0);
  const body = await draft.inputValue();
  let fail = true;
  await page.route(`**/conversations/${history.id}/control`, async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } }); else await route.continue();
  });
  await page.reload();
  const recovery = page.getByRole('button', { name: '刷新托管状态', exact: true });
  await expect(recovery).toBeEnabled(); await expect(draft).toHaveCount(0);
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('control-unavailable.png') });
  fail = false; await recovery.focus(); await page.keyboard.press('Enter');
  await expect(draft).toHaveValue(body); await expect(draft).toBeEnabled();
  const send = page.getByRole('button', { name: '发送', exact: true });
  await send.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => application.replyRequests.length).toBe(1);
  expect(application.replyRequests[0]!.body?.text).toBe(body);
  await expect(draft).toHaveValue('');
});

test('keyboard resizing and mobile navigation preserve the same reply draft', async ({ page, application }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const { url } = await setup(page, application);
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  await draft.fill('请确认规格，再回复消费者。');
  const separator = page.getByRole('separator', { name: '调整会话列表宽度', exact: true });
  const list = page.getByRole('complementary', { name: '会话列表', exact: true });
  const before = (await list.boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await list.boundingBox())!.width).toBeGreaterThan(before);
  await expect(draft).toHaveValue('请确认规格，再回复消费者。');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(separator).toBeHidden();
  await expect.poll(async () => (await page.getByRole('region', { name: '消息记录', exact: true }).boundingBox())!.width).toBeGreaterThan(342);
  await expect(draft).toHaveValue('请确认规格，再回复消费者。');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  expect((await page.getByRole('heading', { name: '消息中心', exact: true }).boundingBox())!.height).toBeLessThan(40);
  await page.getByRole('button', { name: '返回会话列表', exact: true }).click();
  await expect(list).toBeVisible();
  await page.goto(url);
  await expect(draft).toHaveValue('请确认规格，再回复消费者。');

  await page.setViewportSize({ width: 1366, height: 900 });
  await expect(separator).toBeVisible();
  await expect(draft).toHaveValue('请确认规格，再回复消费者。');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('link', { name: '开始使用', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公司工作区', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '进入消息中心', exact: true })).toBeVisible();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
});
