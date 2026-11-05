import { test as base, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { serveNode } from '../../src/platform/node/server.ts';
import { browserClientAssets } from '../fixtures/node-browser.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64');
const imageURL = 'https://api-seller.ozon.ru/v2/chat/file/synthetic/photo.jpg';
const password = 'synthetic-images-password';
const test = base.extend<{ application: { baseURL: string } }>({ application: async ({}, use) => {
  const directory = await mkdtemp(join(tmpdir(), 'dingbell-message-images-'));
  const variables = { APP_BASE_URL: 'http://127.0.0.1:0', BETTER_AUTH_SECRET: 'synthetic-image-ui-secret-at-least-thirty-two-characters' };
  const runtime = await serveNode({ dataDirectory: directory, migrationsDirectory: resolve('migrations'), assetsDirectory: await browserClientAssets(),
    port: 0, hostname: '127.0.0.1', variables });
  try {
    const address = runtime.server.address(); if (!address || typeof address === 'string') throw new Error('Missing local address');
    const baseURL = `http://127.0.0.1:${address.port}`;
    variables.APP_BASE_URL = baseURL; runtime.app.env.APP_BASE_URL = baseURL;
    const db = runtime.app.database.sqlite;
    db.exec(`INSERT INTO user(id,name,email,email_verified) VALUES('image-owner','测试管理员','images@example.invalid',1);
      INSERT INTO organization(id,name,slug,created_at) VALUES('image-company','图片测试公司','image-company',1);
      INSERT INTO member(id,organization_id,user_id,role,created_at) VALUES('image-member','image-company','image-owner','owner',1);
      INSERT INTO store(id,organization_id,name,platform_store_id,status,created_at,updated_at) VALUES('image-store','image-company','图片测试店铺','1','verified',1,1);
      INSERT INTO conversation(id,organization_id,store_id,platform_thread_id,platform_type,platform_status,platform_created_at,last_message_at,imported_at)
        VALUES('image-conversation','image-company','image-store','synthetic-image-thread','BUYER_SELLER','Opened',1,1,1);`);
    db.prepare("INSERT INTO account(id,account_id,provider_id,user_id,password,updated_at) VALUES('image-account','image-owner','credential','image-owner',?,1)").run(await hashPassword(password));
    db.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
      VALUES('image-message','image-company','image-store','image-conversation','1','Customer','inbound',?,1,0,1,1,'backfill')`).run(JSON.stringify([`![](${imageURL})`, 'https://cdn1.ozone.ru/synthetic.png', '买家图片说明 <script>window.__imageInjected=true</script>']));
    db.prepare(`INSERT INTO message(id,organization_id,store_id,conversation_id,platform_message_id,sender_type,direction,content,is_image,is_read,event_at,received_at,ingest_mode)
      VALUES('unsafe-image','image-company','image-store','image-conversation','2','Customer','inbound','["https://untrusted.invalid/pixel.png"]',1,0,2,2,'backfill')`).run();
    await use({ baseURL });
  } finally { runtime.server.closeAllConnections(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
} });

test('message images show thumbnails, keyboard previews and explicit retry without external browser requests', async ({ page, application }) => {
  let secondAttempts = 0; const external: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(application.baseURL)) external.push(request.url()); });
  await page.route('**/messages/image-message/images/*', route => {
    if (route.request().url().endsWith('/1') && secondAttempts++ === 0) return route.fulfill({ status: 502, body: 'unavailable' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: png, headers: { 'cache-control': 'no-store' } });
  });
  await page.goto(`${application.baseURL}/login`);
  await page.getByLabel('邮箱', { exact: true }).fill('images@example.invalid');
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('button', { name: '图片测试公司', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '图片测试公司', exact: true }).click();
  await page.goto(`${application.baseURL}/workspace/messages?store=image-store&conversation=image-conversation`);
  const region = page.getByRole('region', { name: '消息记录', exact: true });
  const thumbnail = region.getByRole('button', { name: '查看图片 1', exact: true });
  await expect(thumbnail).toBeEnabled();
  await expect(region.getByText('图片地址不可用或不受支持', { exact: true })).toBeVisible();
  await expect(region.getByText('买家图片说明 <script>window.__imageInjected=true</script>', { exact: true })).toBeVisible();
  const retry = region.getByRole('button', { name: '重新加载图片 2', exact: true });
  await expect(retry).toBeVisible(); await retry.click();
  await expect(region.getByRole('button', { name: '查看图片 2', exact: true })).toBeEnabled();
  await thumbnail.focus(); await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: '图片预览', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('img', { name: '消息图片 1', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(preview).toBeHidden(); await expect(thumbnail).toBeFocused();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await thumbnail.scrollIntoViewIfNeeded(); await thumbnail.click(); await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate(node => node.getBoundingClientRect().width <= node.ownerDocument.defaultView!.innerWidth)).toBe(true);
    await page.keyboard.press('Escape'); await expect(preview).toBeHidden();
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  }
  expect(external).toEqual([]);
  expect(await page.evaluate('window.__imageInjected')).toBeUndefined();
});
