import { test as base, expect, type Page } from '@playwright/test';
import { startLocalApplication } from '../fixtures/web-identity/local-app.ts';

type Application = Awaited<ReturnType<typeof startLocalApplication>>;
const test = base.extend<{ application: Application; indexing: boolean }>({ indexing: [false, { option: true }], application: async ({ indexing }, use) => {
  const app = await startLocalApplication(true, { mail: true, team: 'roles', stores: 'configured', knowledge: indexing });
  try { await use(app); } finally { await app.close(); }
} });
async function login(page: Page, app: Application, email = 'owner@example.invalid') {
  await page.goto(`${app.baseURL}/login`); await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(app.password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '测试公司 A', exact: true }).click();
}
async function create(page: Page, name = '售后使用说明') {
  await page.getByRole('button', { name: '新建知识', exact: true }).click();
  await page.getByLabel('知识标题', { exact: true }).fill(name);
  await page.getByLabel('知识正文', { exact: true }).fill('请使用附带的说明书安装商品。遇到困难时联系商家。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
}
async function revalidate(page: Page) {
  await page.evaluate(`(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  })()`);
}
test('file imports preview CSV, recover lost receipts and retain manually edited drafts on repeat', async ({ page, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`);
  await page.getByRole('button', { name: '从文件导入', exact: true }).click();
  const file = { name: 'policies.csv', mimeType: 'text/csv', buffer: Buffer.from('title,content\n配送说明,我们会核对订单状态。\n使用说明,请先阅读说明书。') };
  await page.getByLabel('知识文件', { exact: true }).setInputFiles(file);
  await page.getByLabel('文件知识语言', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '预览文件', exact: true }).click();
  await expect(page.getByText('待导入 2 条 · 已存在 0 条', { exact: true })).toBeVisible();
  await expect(page.getByTestId('file-import-preview')).toContainText('我们会核对订单状态。');
  await page.screenshot({ path: test.info().outputPath('file-import-desktop.png'), fullPage: true, animations: 'disabled' });
  let writes = 0;
  await page.route('**/knowledge/file-import', async route => { writes++; await route.fetch(); await route.abort(); });
  await page.getByRole('button', { name: '导入为草稿', exact: true }).click();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByText('导入结果尚未确认', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '导入为草稿', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '核对导入结果', exact: true }).click();
  await expect(page.getByText('待导入 0 条 · 已存在 2 条', { exact: true })).toBeVisible();
  expect(writes).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: test.info().outputPath('file-import-mobile.png'), fullPage: true, animations: 'disabled' });
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.getByRole('button', { name: '打开知识：配送说明', exact: true }).click();
  await page.getByLabel('知识正文', { exact: true }).fill('人工修订后的配送说明。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('button', { name: '从文件导入', exact: true }).click();
  await page.getByLabel('知识文件', { exact: true }).setInputFiles(file);
  await page.getByLabel('文件知识语言', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: '预览文件', exact: true }).click();
  await expect(page.getByText('待导入 0 条 · 已存在 2 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开知识：配送说明', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('人工修订后的配送说明。');
});
test('invalid file previews can be corrected, scope changes clear preview and leaving requires confirmation', async ({ page, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`);
  await page.getByRole('button', { name: '从文件导入', exact: true }).click();
  await page.getByLabel('知识文件', { exact: true }).setInputFiles({ name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('title,content\na,"broken') });
  await page.getByRole('button', { name: '预览文件', exact: true }).click();
  await expect(page.getByText('CSV 格式不正确。请使用 title,content 表头，并检查引号与列数。', { exact: true })).toBeVisible();
  await page.getByLabel('知识文件', { exact: true }).setInputFiles({ name: 'readme.md', mimeType: 'text/markdown', buffer: Buffer.from('# 说明\n\n请按说明操作。') });
  await page.getByRole('button', { name: '预览文件', exact: true }).click();
  await expect(page.getByText('待导入 1 条 · 已存在 0 条', { exact: true })).toBeVisible();
  await page.getByLabel('文件知识语言', { exact: true }).selectOption('en');
  await expect(page.getByTestId('file-import-preview')).not.toBeVisible();
  await page.getByRole('button', { name: '返回知识库', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('文件知识语言', { exact: true })).toHaveValue('en');
});
test('synced product imports require review, recover a lost acknowledgement and preserve manual drafts on repeat', async ({ page, application }) => {
  await login(page, application); const storeId = crypto.randomUUID();
  expect((await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, { headers: { origin: application.baseURL },
    data: { id: storeId, name: '商品来源店', clientId: '930003', apiKey: crypto.randomUUID() } })).status()).toBe(200);
  await application.seedKnowledgeProduct(storeId); await application.seedKnowledgeProduct(storeId, { productId: '1002', pending: true });
  await page.goto(`${application.baseURL}/workspace/knowledge`);
  await expect(page.getByRole('button', { name: '从商品导入', exact: true })).toBeVisible({ timeout: 3000 });
  await page.getByRole('button', { name: '从商品导入', exact: true }).click();
  await page.getByLabel('商品来源店铺', { exact: true }).selectOption(storeId);
  await expect(page.getByRole('button', { name: '预览商品 1002', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '预览商品 1001', exact: true }).click();
  await expect(page.getByTestId('product-import-preview')).toContainText('Органайзер');
  await expect(page.getByTestId('product-import-preview')).not.toContainText('123.45');
  await page.screenshot({ path: test.info().outputPath('product-import-desktop.png'), fullPage: true, animations: 'disabled' });
  let posts = 0;
  await page.route('**/knowledge/product-import', async route => { if (route.request().method() !== 'POST') return route.continue(); posts++; await route.fetch(); await route.abort(); });
  await page.getByRole('button', { name: '导入为草稿', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认导入商品资料', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByText('导入结果尚未确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '核对导入结果', exact: true }).click();
  await page.getByRole('button', { name: '打开知识草稿', exact: true }).click();
  await expect(page.getByLabel('知识标题', { exact: true })).toHaveValue('Органайзер');
  await page.getByLabel('属性值 1', { exact: true }).fill('人工核对后的名称');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('button', { name: '从商品导入', exact: true }).click();
  await page.getByLabel('商品来源店铺', { exact: true }).selectOption(storeId); await page.getByRole('button', { name: '预览商品 1001', exact: true }).click();
  await expect(page.getByText('此来源已导入', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '打开知识草稿', exact: true }).click();
  await expect(page.getByLabel('属性值 1', { exact: true })).toHaveValue('人工核对后的名称'); expect(posts).toBe(1);
  await page.unroute('**/knowledge/product-import'); await application.seedKnowledgeProduct(storeId, { name: 'Новая версия' });
  await page.getByRole('button', { name: '从商品导入', exact: true }).click();
  await page.getByLabel('商品来源店铺', { exact: true }).selectOption(storeId); await page.getByRole('button', { name: '预览商品 1001', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '更新知识草稿', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('人工核对后的名称');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('product-import-mobile.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '确认更新草稿', exact: true }).click();
  await page.getByRole('button', { name: '打开知识草稿', exact: true }).click();
  await expect(page.getByLabel('知识标题', { exact: true })).toHaveValue('Новая версия');
  await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
});
test('knowledge drafts, filters and historical restoration use real APIs while unavailable indexing remains explicit', async ({ page, application }) => {
  await login(page, application); await page.getByRole('link', { name: '管理知识', exact: true }).click();
  await expect(page.getByText('索引服务尚未启用', { exact: true })).toBeVisible();
  await create(page); await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  await expect(page.getByRole('button', { name: '开始索引', exact: true })).toBeDisabled();
  await page.getByLabel('知识正文', { exact: true }).fill('修订后的使用说明，请确认电源已连接。' + ' '.repeat(9000));
  await expect(page.getByText('内容过长，请拆分成多条资料后保存。', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('tab', { name: '版本记录', exact: true }).click();
  await page.getByRole('button', { name: '将 v1 恢复为草稿', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('请使用附带的说明书安装商品。遇到困难时联系商家。');
  await page.reload(); await expect(page.getByLabel('知识标题', { exact: true })).toHaveValue('售后使用说明');
  await page.getByRole('button', { name: '返回知识库', exact: true }).click();
  await page.getByLabel('发布状态筛选', { exact: true }).selectOption('published');
  await expect(page.getByText('没有匹配的知识', { exact: true })).toBeVisible();
  await page.getByLabel('发布状态筛选', { exact: true }).selectOption('');
  await page.getByRole('button', { name: '编辑知识：售后使用说明', exact: true }).click();
  await expect(page.getByLabel('知识标题', { exact: true })).toHaveValue('售后使用说明');
  await page.screenshot({ path: test.info().outputPath('knowledge-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('knowledge-mobile.png'), fullPage: true, animations: 'disabled' });
});

test('a newer product snapshot never inherits a previous snapshot import success indicator', async ({ page, application }) => {
  await login(page, application); const storeId = crypto.randomUUID();
  expect((await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, { headers: { origin: application.baseURL },
    data: { id: storeId, name: '持续同步店', clientId: '930004', apiKey: crypto.randomUUID() } })).status()).toBe(200);
  await application.seedKnowledgeProduct(storeId); await page.goto(`${application.baseURL}/workspace/knowledge?import=products`);
  await page.getByLabel('商品来源店铺', { exact: true }).selectOption(storeId); await page.getByRole('button', { name: '预览商品 1001', exact: true }).click();
  await page.getByRole('button', { name: '导入为草稿', exact: true }).click(); await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByText('知识草稿已生成', { exact: true })).toBeVisible();
  await application.seedKnowledgeProduct(storeId, { name: 'Еще одна версия' }); await revalidate(page);
  await expect(page.getByTestId('product-import-preview')).toContainText('Еще одна версия');
  await expect(page.getByText('知识草稿已生成', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '更新知识草稿', exact: true })).toBeEnabled();
  const records = await page.request.get(`${application.baseURL}/api/companies/company-a/knowledge`);
  expect((await records.json()).documents[0].draftRevision).toBe(1);
});

test('unsaved knowledge is protected across sidebar navigation, browser back and company changes', async ({ page, application }) => {
  await login(page, application); await page.getByRole('link', { name: '知识库', exact: true }).click(); await create(page);
  const editorURL = page.url();
  await page.getByLabel('知识正文', { exact: true }).fill('暂未保存的重要内容');
  await page.getByRole('link', { name: '消息中心', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('暂未保存的重要内容');
  await page.goBack(); await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click(); await expect(page).toHaveURL(editorURL);
  await page.getByRole('button', { name: '切换公司', exact: true }).click();
  await page.getByRole('menuitem', { name: '测试公司 B', exact: false }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('暂未保存的重要内容');
  await page.getByRole('link', { name: '消息中心', exact: true }).click();
  await page.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page).toHaveURL(`${application.baseURL}/workspace/messages`);
});

test('knowledge ownership is enforced and switching company clears the previous document', async ({ page, browser, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
  const id = new URL(page.url()).searchParams.get('document'); expect(id).toBeTruthy();
  const context = await browser.newContext(), member = await context.newPage();
  try {
    await login(member, application, 'member@example.invalid'); await member.goto(`${application.baseURL}/workspace/knowledge?document=${id}`);
    await expect(member.getByText('需要管理员权限', { exact: true })).toBeVisible();
    await expect(member.getByLabel('知识正文', { exact: true })).toHaveCount(0);
    expect((await member.request.get(`${application.baseURL}/api/companies/company-a/knowledge/${id}`)).status()).toBe(403);
  } finally { await context.close(); }
  expect((await page.request.post(`${application.baseURL}/api/companies/company-b/activate`, { headers: { origin: application.baseURL }, data: {} })).status()).toBe(200);
  await page.reload(); await expect(page.getByText('需要管理员权限', { exact: true })).toBeVisible();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveCount(0);
});

test('product knowledge confirms format changes and validates immutable scope and distinct facts', async ({ page, application }) => {
  await login(page, application);
  const storeId = crypto.randomUUID();
  expect((await page.request.post(`${application.baseURL}/api/companies/company-a/stores`, { headers: { origin: application.baseURL },
    data: { id: storeId, name: '知识验证店', clientId: '930002', apiKey: crypto.randomUUID() } })).status()).toBe(200);
  await page.goto(`${application.baseURL}/workspace/knowledge`); await page.getByRole('button', { name: '新建知识', exact: true }).click();
  await page.getByLabel('知识标题', { exact: true }).fill('收纳盒规格');
  await page.getByLabel('知识正文', { exact: true }).fill('请保留这段内容。');
  await page.getByLabel('知识类型', { exact: true }).selectOption('product');
  await expect(page.getByRole('dialog', { name: '切换资料格式？' })).toBeVisible();
  await page.getByRole('button', { name: '保留当前内容', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('请保留这段内容。');
  await page.getByLabel('知识类型', { exact: true }).selectOption('product');
  await page.getByRole('button', { name: '清空并切换', exact: true }).click();
  await page.getByLabel('属性 1', { exact: true }).fill('宽度'); await page.getByLabel('属性值 1', { exact: true }).fill('26 cm');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await page.getByLabel('适用店铺', { exact: true }).selectOption(storeId); await page.getByLabel('商品标识', { exact: true }).fill('SKU-' + 'a'.repeat(110));
  await page.getByRole('button', { name: '添加属性', exact: true }).click();
  await page.getByLabel('属性 2', { exact: true }).fill('宽度'); await page.getByLabel('属性值 2', { exact: true }).fill('浅灰色');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await page.getByLabel('属性 2', { exact: true }).fill('颜色');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.reload(); await expect(page.getByLabel('属性值 1', { exact: true })).toHaveValue('26 cm');
  await expect(page.getByLabel('适用店铺', { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('knowledge-product-mobile.png'), fullPage: true, animations: 'disabled' });
});

test.describe('configured knowledge workflow', () => {
  test.use({ indexing: true });
  test('durable indexing, saved retrieval tests, publication and withdrawal survive reloads and lost acknowledgements', async ({ page, application }) => {
    test.setTimeout(100_000);
    await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
    await page.getByRole('button', { name: '开始索引', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行');
    await page.reload(); await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行');
    await expect(page.getByRole('button', { name: '开始索引', exact: true })).toBeDisabled();
    await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-operation')).toContainText('索引完成', { timeout: 20_000 });
    await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
    await page.getByRole('tab', { name: '检索测试', exact: true }).click();
    await page.getByLabel('测试问题 1', { exact: true }).fill('Как установить товар?');
    await page.getByLabel('预期片段 1', { exact: true }).selectOption({ index: 1 });
    await page.getByRole('button', { name: '运行检索测试', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行');
    await page.reload(); await expect(page.getByTestId('knowledge-operation')).toContainText('检索测试任务');
    await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-operation')).toContainText('检索测试通过', { timeout: 20_000 });
    await page.getByRole('tab', { name: '检索测试', exact: true }).click();
    await expect(page.getByLabel('测试问题 1', { exact: true })).toHaveValue('Как установить товар?');
    await expect(page.getByTestId('knowledge-test-results')).toContainText('命中预期片段');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot({ path: test.info().outputPath('knowledge-test-mobile.png'), fullPage: true, animations: 'disabled' });
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.getByRole('tab', { name: '编辑草稿', exact: true }).click();
    await page.getByRole('button', { name: '发布知识', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '确认发布知识' })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: '发布知识', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    let requests = 0;
    await page.route('**/knowledge/*/publish', async route => { requests++; await route.fetch(); await route.abort('failed'); });
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await expect(page.getByText('操作结果尚未确认', { exact: true })).toBeVisible();
    await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
    await page.getByRole('button', { name: '读取最新版本', exact: true }).click();
    await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-effective')).toContainText('生效版本 v1', { timeout: 20_000 });
    await page.getByRole('button', { name: '基于最新版本继续编辑', exact: true }).click();
    expect(requests).toBe(1); expect((await application.knowledge()).calls.find(row => row.kind === 'embedding')?.n).toBe(2);
    await page.getByLabel('知识正文', { exact: true }).fill('新草稿尚未发布。');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
    await expect(page.getByTestId('knowledge-effective')).toContainText('生效版本 v1');
    await page.getByRole('button', { name: '撤回发布', exact: true }).click();
    await page.getByRole('button', { name: '确认撤回', exact: true }).click();
    await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
    await page.reload(); await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('新草稿尚未发布。');
    await page.screenshot({ path: test.info().outputPath('knowledge-workflow-desktop.png'), fullPage: true, animations: 'disabled' });
  });

  test('failed questions can be reviewed, reused for retesting and distinguished from published knowledge', async ({ page, application }) => {
    test.setTimeout(100_000);
    await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
    await page.getByRole('button', { name: '开始索引', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-operation')).toContainText('索引完成', { timeout: 20_000 });
    await page.getByRole('tab', { name: '检索测试', exact: true }).click();
    await page.getByLabel('测试问题 1', { exact: true }).fill('Как установить товар?');
    await page.getByLabel('预期片段 1', { exact: true }).selectOption({ index: 1 });
    await application.knowledge({ mode: 'query-empty' });
    await page.getByLabel('最低匹配分值 1', { exact: true }).fill('0.7');
    await page.getByRole('button', { name: '运行检索测试', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-test-results')).toContainText('未达到预期', { timeout: 20_000 });
    await page.getByRole('button', { name: '知识缺口', exact: true }).click();
    await expect(page.getByTestId('knowledge-gap-list')).toContainText('Как установить товар?');
    await expect(page.getByTestId('knowledge-gap-list')).toContainText('待核对');
    await page.screenshot({ path: test.info().outputPath('knowledge-gaps-desktop.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '用此问题复测', exact: true }).click();
    await expect(page.getByLabel('测试问题 1', { exact: true })).toHaveValue('Как установить товар?');
    await expect(page.getByLabel('预期片段 1', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('最低匹配分值 1', { exact: true })).toHaveValue('0.7');
    await page.getByLabel('预期片段 1', { exact: true }).selectOption({ index: 1 });
    await application.knowledge({ mode: 'normal' });
    await page.getByRole('button', { name: '运行检索测试', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-test-results')).toContainText('命中预期片段', { timeout: 20_000 });
    await page.getByRole('button', { name: '知识缺口', exact: true }).click();
    await page.getByLabel('知识缺口状态', { exact: true }).selectOption('retested');
    await expect(page.getByTestId('knowledge-gap-list')).toContainText('草稿复测通过');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath('knowledge-gaps-mobile.png'), fullPage: true, animations: 'disabled' });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.getByRole('button', { name: '编辑知识', exact: true }).click();
    await page.getByRole('button', { name: '发布知识', exact: true }).click();
    await page.getByRole('button', { name: '确认发布', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-effective')).toContainText('已发布', { timeout: 20_000 });
    await page.getByRole('button', { name: '知识缺口', exact: true }).click();
    await page.getByLabel('知识缺口状态', { exact: true }).selectOption('published');
    await expect(page.getByTestId('knowledge-gap-list')).toContainText('对应版本已发布');
  });
  test('a failed saved test keeps its evidence and never enables publication', async ({ page, application }) => {
    await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
    await page.getByRole('button', { name: '开始索引', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-operation')).toContainText('索引完成', { timeout: 20_000 });
    await page.getByRole('tab', { name: '检索测试', exact: true }).click();
    await page.getByLabel('测试问题 1', { exact: true }).fill('没有匹配的问题');
    await page.getByLabel('预期片段 1', { exact: true }).selectOption({ index: 1 });
    await application.knowledge({ mode: 'query-empty' });
    await page.getByRole('button', { name: '运行检索测试', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-test-results')).toContainText('未达到预期', { timeout: 20_000 });
    await page.reload(); await page.getByRole('tab', { name: '检索测试', exact: true }).click();
    await expect(page.getByTestId('knowledge-test-results')).toContainText('返回 0 个候选片段');
    await page.getByRole('tab', { name: '编辑草稿', exact: true }).click();
    await expect(page.getByRole('button', { name: '发布知识', exact: true })).toBeDisabled();
    await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  });

  test('an uncertain indexing call is shown honestly and never redispatched after reload', async ({ page, application }) => {
    await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
    await application.knowledge({ mode: 'model-error' });
    await page.getByRole('button', { name: '开始索引', exact: true }).click();
    await expect(page.getByTestId('knowledge-operation')).toContainText('等待执行'); await application.knowledge({ dispatch: true });
    await expect(page.getByTestId('knowledge-operation')).toContainText('结果待确认', { timeout: 20_000 });
    await page.reload(); await expect(page.getByTestId('knowledge-operation')).toContainText('结果待确认');
    await application.knowledge({ dispatch: true });
    expect((await application.knowledge()).calls.find(row => row.kind === 'embedding')?.n).toBe(1);
    await expect(page.getByRole('button', { name: '发布知识', exact: true })).toBeDisabled();
    await expect(page.getByTestId('knowledge-effective')).toContainText('尚未发布');
  });
});

test('knowledge preserves local edits on conflicts and confirms leaving an unsaved draft', async ({ page, context, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
  const url = page.url(), other = await context.newPage(); await other.goto(url);
  await page.getByLabel('知识正文', { exact: true }).fill('当前页面未保存的内容');
  await other.getByLabel('知识正文', { exact: true }).fill('另一页面保存的内容');
  await other.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(other.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByText('请读取最新版本并核对后再操作。', { exact: false })).toBeVisible();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('当前页面未保存的内容');
  await page.getByRole('button', { name: '返回知识库', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('当前页面未保存的内容');
});

test('a failed capability refresh can be recovered without discarding local knowledge edits', async ({ page, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
  await page.getByLabel('知识正文', { exact: true }).fill('网络中断时保留的修改');
  let unavailable = true;
  await page.route('**/api/companies/company-a/knowledge?*', async route => unavailable
    ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }) }) : route.continue());
  const failed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/knowledge') && response.status() === 503);
  await revalidate(page);
  await failed; await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeDisabled();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('网络中断时保留的修改');
  unavailable = false; await page.getByRole('button', { name: '重新读取知识库配置', exact: true }).click();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '草稿已保存' })).toBeVisible();
});

test('knowledge and open dialogs stay hidden during reauthorization and are cleared after revocation', async ({ page, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
  await page.getByLabel('知识正文', { exact: true }).fill('重新核验身份期间保留的内容');
  await page.getByRole('button', { name: '返回知识库', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  let release = () => {}, arrived = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }), seen = new Promise<void>(resolve => { arrived = resolve; });
  await page.route('**/api/workspace-bootstrap', async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }); });
  try {
    await revalidate(page); await seen;
    await expect(page.getByText('正在确认账号状态…', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeHidden();
    await expect(page.getByLabel('知识正文', { exact: true })).toBeHidden();
  } finally { release(); }
  await expect(page.getByRole('dialog', { name: '放弃未保存的修改？' })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('重新核验身份期间保留的内容');
  await page.unroute('**/api/workspace-bootstrap'); await application.removeMembership('company-a'); await revalidate(page);
  await expect(page.getByRole('heading', { name: '选择公司', exact: true })).toBeVisible();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a save acknowledged while knowledge is hidden can be reconciled without a stuck form or duplicate write', async ({ page, application }) => {
  await login(page, application); await page.goto(`${application.baseURL}/workspace/knowledge`); await create(page);
  let releaseWrite = () => {}, releaseIdentity = () => {}, accepted = () => {}, checking = () => {}, writes = 0;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; }), identityGate = new Promise<void>(resolve => { releaseIdentity = resolve; });
  const written = new Promise<void>(resolve => { accepted = resolve; }), identity = new Promise<void>(resolve => { checking = resolve; });
  await page.route('**/knowledge/*/draft', async route => { writes++; const response = await route.fetch(); accepted(); await writeGate; await route.fulfill({ response }); });
  await page.route('**/api/workspace-bootstrap', async route => { const response = await route.fetch(); checking(); await identityGate; await route.fulfill({ response }); });
  try {
    await page.getByLabel('知识正文', { exact: true }).fill('保存响应在隐藏期间到达的内容');
    await page.getByRole('button', { name: '保存草稿', exact: true }).click(); await written;
    await revalidate(page); await identity; await expect(page.getByText('正在确认账号状态…', { exact: true })).toBeVisible();
    const acknowledgement = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/draft'));
    releaseWrite(); await acknowledgement;
    await page.evaluate(() => {
      const { requestAnimationFrame } = globalThis as typeof globalThis & { requestAnimationFrame: (callback: () => void) => number };
      return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
  } finally { releaseWrite(); releaseIdentity(); }
  await expect(page.getByText('操作结果尚未确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '读取最新版本', exact: true }).click();
  await expect(page.getByLabel('知识正文', { exact: true })).toHaveValue('保存响应在隐藏期间到达的内容');
  const confirm = page.getByRole('button', { name: '基于最新版本继续编辑', exact: true });
  await confirm.click();
  await page.getByLabel('知识正文', { exact: true }).fill('下一次修改');
  await expect(page.getByRole('button', { name: '保存草稿', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
});
