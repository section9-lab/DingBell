import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';
type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application }>({ application: async ({}, use) => {
  const app = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', sync: true, control: true, replies: true });
  try { await use(app); } finally { await app.close(); }
} });
async function login(page: Page, app: Application, actor = 'owner') {
  await page.goto(`${app.baseURL}/login`); await page.getByLabel('邮箱', { exact: true }).fill(`${actor}@example.invalid`);
  await page.getByLabel('密码', { exact: true }).fill(app.password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}
const url = (app: Application, store: string, conversation: string) => `${app.baseURL}/workspace/messages?${new URLSearchParams({ store, conversation })}`;
const commands = (app: Application, conversation: string) => `${app.baseURL}/api/companies/company-a/conversations/${conversation}/commands`;
const draft = (page: Page) => page.getByRole('textbox', { name: '回复原文', exact: true });
async function seed(page: Page, app: Application) {
  const storeId = crypto.randomUUID();
  expect((await page.request.post(`${app.baseURL}/api/companies/company-a/stores`, { headers: { origin: app.baseURL }, data: { id: storeId, name: '草稿恢复测试店', clientId: '910008', apiKey: crypto.randomUUID() } })).status()).toBe(200);
  await app.prepareReplyStore(storeId); const history = await app.seedConversationHistory(storeId);
  for (const id of [history.id, history.emptyId]) expect((await page.request.post(commands(app, id), { headers: { origin: app.baseURL }, data: { commandId: crypto.randomUUID(), expectedVersion: 0, action: 'claim' } })).status()).toBe(200);
  return { storeId, ...history };
}

test('ordinary drafts survive conversation switches, refresh and offline reauthorization and clear only after confirmed submission', async ({ page, application: app }) => {
  await login(page, app); const history = await seed(page, app), first = url(app, history.storeId, history.id), second = url(app, history.storeId, history.emptyId);
  const body = '  草稿一：请确认尺寸。\nЗдравствуйте!  ', other = '第二个会话的独立草稿';
  await page.goto(first); await draft(page).fill(body); await page.goto(second); await expect(draft(page)).toHaveValue(''); await draft(page).fill(other);
  await page.goto(first); await expect(draft(page)).toHaveValue(body); await page.reload(); await expect(draft(page)).toHaveValue(body);
  await page.getByRole('button', { name: '切换公司', exact: true }).click(); await page.getByRole('menuitem', { name: /测试公司 B/ }).click(); await expect(draft(page)).toHaveCount(0);
  await page.getByRole('button', { name: '切换公司', exact: true }).click(); await page.getByRole('menuitem', { name: /测试公司 A/ }).click(); await page.goto(first); await expect(draft(page)).toHaveValue(body);
  await page.context().setOffline(true); await expect(page.getByRole('heading', { name: '网络已断开', exact: true })).toBeVisible(); await expect(draft(page)).toHaveCount(0);
  await page.context().setOffline(false); await expect(draft(page)).toHaveValue(body); expect(app.replyRequests).toHaveLength(0);
  await page.getByRole('button', { name: '预览回复', exact: true }).click(); await page.getByRole('dialog', { name: '确认发送给消费者', exact: true }).getByRole('button', { name: '确认发送', exact: true }).click();
  await expect(draft(page)).toHaveValue(''); await page.reload(); await expect(draft(page)).toHaveValue('');
  await expect.poll(() => app.replyRequests.length).toBe(1); expect(app.replyRequests[0]!.body).toEqual({ chat_id: history.threadId, text: body });
  await page.goto(second); await expect(draft(page)).toHaveValue(other);
});

test('replacement membership never inherits a draft, and confirmed revocation and logout clear only the current account', async ({ page, browser, application: app }) => {
  await login(page, app); const history = await seed(page, app), target = url(app, history.storeId, history.id);
  const grant = (id: string) => `${app.baseURL}/api/companies/company-a/stores/${history.storeId}/grants/${id}`;
  expect((await page.request.post(grant('member-a'), { headers: { origin: app.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
  const context = await browser.newContext();
  try {
    const member = await context.newPage(); await login(member, app, 'member'); await member.goto(target); await draft(member).fill('OLD-MEMBER-PRIVATE-DRAFT');
    await app.rejoinFixtureMember(history.storeId); await member.reload(); await expect(draft(member)).toHaveValue(''); await draft(member).fill('REJOINED-PRIVATE-DRAFT');
    const revoked = member.waitForResponse(response => response.status() === 404 && response.url().startsWith(`${app.baseURL}/api/companies/company-a/conversations/${history.id}`), { timeout: 15_000 });
    expect((await page.request.post(grant('member-a-rejoined'), { headers: { origin: app.baseURL }, data: { expectedGranted: true, granted: false } })).status()).toBe(200);
    await revoked; await expect(draft(member)).toHaveCount(0);
    await expect.poll(() => member.evaluate("Object.values(sessionStorage).some(value => value.includes('PRIVATE-DRAFT'))")).toBe(false);
    expect((await page.request.post(grant('member-a-rejoined'), { headers: { origin: app.baseURL }, data: { expectedGranted: false, granted: true } })).status()).toBe(200);
    await member.goto(target); await draft(member).fill('LOGOUT-PRIVATE-DRAFT'); await member.getByRole('button', { name: '退出登录', exact: true }).click(); await expect(member).toHaveURL(`${app.baseURL}/login`);
    expect(await member.evaluate("Object.values(sessionStorage).some(value => value.includes('PRIVATE-DRAFT'))")).toBe(false);
    await login(member, app, 'admin'); await member.goto(target); await expect(draft(member)).toHaveValue(''); expect(app.replyRequests).toHaveLength(0);
  } finally { await context.close(); }
});

test('failed draft storage preserves current input and accepted-send cleanup keeps its original recovery journal until cleared', async ({ page, application: app }) => {
  await login(page, app); const history = await seed(page, app); await page.goto(url(app, history.storeId, history.id)); await draft(page).fill('OLDER-PERSISTED-DRAFT');
  await page.evaluate(`(() => {
    const write = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
    Storage.prototype.setItem = function(key, value) { if (this === sessionStorage && key.startsWith('dingbell:reply-draft:')) throw new DOMException('Synthetic quota', 'QuotaExceededError'); return write.call(this, key, value); };
    Storage.prototype.removeItem = function(key) { if (this === sessionStorage && key.startsWith('dingbell:reply-draft:')) throw new DOMException('Synthetic cleanup failure', 'SecurityError'); return remove.call(this, key); };
  })()`);
  const body = 'CURRENT-DRAFT-MUST-NOT-BE-LOST'; await draft(page).fill(body); await expect(draft(page)).toHaveValue(body);
  await expect(page.getByText('草稿自动保存不可用。当前输入仍保留，请勿关闭或刷新页面。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '预览回复', exact: true }).click(); await page.getByRole('dialog', { name: '确认发送给消费者', exact: true }).getByRole('button', { name: '确认发送', exact: true }).click();
  await expect(page.getByText('原提交已确认，但本机草稿尚未清理。请恢复浏览器存储后再次核对，暂时不要创建新回复。', { exact: true })).toBeVisible();
  await expect(draft(page)).toHaveCount(0); await page.screenshot({ path: test.info().outputPath('draft-cleanup-unconfirmed.png') });
  await page.reload(); await expect(draft(page)).toHaveCount(0); await page.getByRole('button', { name: '核对提交', exact: true }).click();
  await expect(draft(page)).toHaveValue(''); await page.reload(); await expect(draft(page)).toHaveValue('');
  await expect.poll(() => app.replyRequests.length).toBe(1); expect(app.replyRequests[0]!.body).toEqual({ chat_id: history.threadId, text: body });
});
