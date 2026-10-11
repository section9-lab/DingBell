import { test as base, expect, type Page, type Locator } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({ application: async ({}, use) => {
  const application = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true, replies: true });
  try { await use(application); } finally { await application.close(); }
} });

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
    const preview = page.getByRole('button', { name: '预览回复', exact: true });
    const boxes = { viewport, history: await region.boundingBox(), draft: await draft.boundingBox(), preview: await preview.boundingBox() };
    await writeFile(test.info().outputPath(`layout-${viewport.width}.json`), JSON.stringify(boxes, null, 2));
    await page.screenshot({ path: test.info().outputPath(`layout-${viewport.width}.png`) });
    expect(boxes.history!.height).toBeGreaterThanOrEqual(120);
    for (const box of [boxes.draft!, boxes.preview!]) {
      expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth && window.scrollY === 0')).toBe(true);
    await page.keyboard.press('Tab');
    const assignee = page.getByRole('button', { name: `负责人：${'客服负责人'.repeat(20)}`, exact: true });
    await assignee.focus();
    expect(await assignee.evaluate(node => node.ownerDocument.defaultView!.getComputedStyle(node).boxShadow)).not.toBe('none');
    await page.keyboard.press('Enter');
    const ownerDetails = page.getByRole('dialog', { name: '负责人信息', exact: true });
    await expect(ownerDetails.getByText(`负责人：${'客服负责人'.repeat(20)}`, { exact: true })).toBeVisible();
    await expect(ownerDetails).toBeInViewport();
    await page.keyboard.press('Escape'); await expect(ownerDetails).toBeHidden(); await expect(assignee).toBeFocused();
    const details = page.getByRole('button', { name: '会话详情', exact: true });
    await details.focus(); await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: '会话详情', exact: true });
    await expect(drawer).toBeVisible(); await expect(drawer).toHaveAccessibleDescription('查看商品、订单包裹、消息来源与同步范围。');
    await containedFocus(page, drawer);
    await page.keyboard.press('Escape'); await expect(drawer).toBeHidden(); await expect(details).toBeFocused();
    await preview.focus(); await page.keyboard.press('Enter');
    const confirmation = page.getByRole('dialog', { name: '确认发送给消费者', exact: true });
    await expect(confirmation).toBeVisible(); await containedFocus(page, confirmation);
    await page.keyboard.press('Escape'); await expect(confirmation).toBeHidden();
    // Background reads may temporarily disable the original trigger; the draft remains a useful return target.
    await expect.poll(async () => await preview.evaluate(node => node === node.ownerDocument.activeElement)
      || await draft.evaluate(node => node === node.ownerDocument.activeElement)).toBe(true);
    await expect(draft).toHaveValue(body);
  }
  expect(application.replyRequests).toHaveLength(0);
});

test('a failed control read blocks actions, preserves the draft and offers a keyboard recovery path', async ({ page, application }) => {
  const history = await setup(page, application);
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  await draft.fill('确认规格'); await draft.press('Enter'); await draft.press('ArrowUp');
  await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
  await expect(page.getByRole('dialog', { name: '确认发送给消费者', exact: true })).toHaveCount(0);
  expect(application.replyRequests).toHaveLength(0);
  const body = await draft.inputValue();
  let fail = true;
  await page.route(`**/conversations/${history.id}/control`, async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: { code: 'SERVICE_UNAVAILABLE' } } }); else await route.continue();
  });
  await page.reload();
  const recovery = page.getByRole('button', { name: '刷新会话状态', exact: true });
  await expect(recovery).toBeEnabled(); await expect(draft).toHaveCount(0);
  await expect(page.getByRole('button', { name: '预览回复', exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('control-unavailable.png') });
  fail = false; await recovery.focus(); await page.keyboard.press('Enter');
  await expect(draft).toHaveValue(body); await expect(draft).toBeEnabled();
  const preview = page.getByRole('button', { name: '预览回复', exact: true });
  await preview.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('dialog', { name: '确认发送给消费者', exact: true });
  await expect(confirmation).toBeVisible();
  const send = confirmation.getByRole('button', { name: '确认发送', exact: true });
  await send.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => application.replyRequests.length).toBe(1);
  expect(application.replyRequests[0]!.body?.text).toBe(body);
  await expect(confirmation).toBeHidden(); await expect(draft).toHaveValue('');
});

test('closing a reply confirmation during a background read returns focus to the editable draft', async ({ page, application }) => {
  await page.clock.install();
  const history = await setup(page, application);
  const draft = page.getByRole('textbox', { name: '回复原文', exact: true });
  await draft.fill('FOCUS-RECOVERY-DRAFT');
  const preview = page.getByRole('button', { name: '预览回复', exact: true, includeHidden: true });
  await preview.focus(); await page.keyboard.press('Enter');
  const confirmation = page.getByRole('dialog', { name: '确认发送给消费者', exact: true });
  await expect(confirmation).toBeVisible();
  let release = () => {}, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route(`**/conversations/${history.id}/replies`, async route => { held = true; await gate; await route.continue(); });
  try {
    await page.clock.fastForward(10_000);
    await expect.poll(() => held).toBe(true); await expect(preview).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(confirmation).toBeHidden();
    await writeFile(test.info().outputPath('focus-after-close.json'), JSON.stringify(await page.evaluate("({tag:document.activeElement?.tagName,id:document.activeElement?.id,text:document.activeElement?.textContent?.slice(0,80)})")));
    await expect(draft).toBeFocused({ timeout: 2_000 });
    await expect(draft).toHaveValue('FOCUS-RECOVERY-DRAFT');
    expect(application.replyRequests).toHaveLength(0);
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
});

for (const [buttonName, dialogName] of [['标记已解决', '标记会话已解决？'], ['转交会话', '转交会话'], ['内部备注', '内部备注']]) {
  test(`closing ${buttonName} during a background control read returns visible focus to the control panel`, async ({ page, application }) => {
    await page.clock.install();
    const history = await setup(page, application);
    const trigger = page.getByRole('button', { name: buttonName, exact: true, includeHidden: true });
    await trigger.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: dialogName, exact: true });
    await expect(dialog).toBeVisible();
    let release = () => {}, held = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/conversations/${history.id}/control`, async route => { held = true; await gate; await route.continue(); });
    try {
      await page.clock.fastForward(10_000);
      await expect.poll(() => held).toBe(true); await expect(trigger).toBeDisabled();
      await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
      const panel = page.getByLabel('会话处理', { exact: true });
      await expect.poll(() => panel.evaluate(node => node.contains(node.ownerDocument.activeElement)), { timeout: 2_000 }).toBe(true);
      expect(await panel.evaluate('node => getComputedStyle(node.ownerDocument.activeElement).boxShadow')).not.toBe('none');
      expect(application.replyRequests).toHaveLength(0);
    } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  });
}
