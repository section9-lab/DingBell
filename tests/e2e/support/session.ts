import type { Page } from '@playwright/test';

/**
 * 工作区的「退出登录」已收进侧边栏底部的账户菜单，不再是可直接点击的可见按钮。
 * 统一从这里走「打开账户菜单 → 退出登录」，并在上一个菜单尚未收起时重试一次。
 */
export async function signOut(page: Page) {
  const trigger = page.getByRole('button', { name: /^打开账户菜单/ });
  const item = page.getByRole('menuitem', { name: '退出登录', exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    if (await item.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) break;
  }
  await item.click();
}
