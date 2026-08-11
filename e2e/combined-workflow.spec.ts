import { expect, test } from '@playwright/test';

test('旧项目、画布保存、历史、系统控制台和重登可联合使用', async ({ page }) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });

  await page.goto('/__e2e/login');
  await expect(page.getByTestId('project-browser-project')).toBeVisible();
  await page.getByTestId('project-browser-project').click();
  await expect(page.getByTestId('add-image-node')).toBeVisible();

  await page.getByTestId('add-image-node').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(1);
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/projects/browser-project') && response.request().method() === 'PUT' && response.ok());
  await page.getByTestId('save-project').click();
  await saved;

  await page.getByTestId('open-generation-history').click();
  await expect(page.getByTestId('generation-history')).toContainText('浏览器联合验证短片');
  await page.getByTestId('generation-history').getByTitle('关闭').click();

  await page.getByTestId('close-project').click();
  await page.getByTestId('open-system-admin').click();
  await expect(page.getByTestId('infrastructure-capacity')).toBeVisible();
  await expect(page.getByTestId('storage-cleanup')).toBeVisible();
  await expect(page.getByTestId('storage-quarantine')).toBeVisible();
  await page.getByRole('button', { name: '关闭' }).last().click();

  await page.getByTestId('logout').click();
  await expect(page.getByText('登录创作空间')).toBeVisible();
  await page.goto('/__e2e/login');
  await expect(page.getByTestId('project-browser-project-scene-count')).toContainText('1');
  expect(browserErrors).toEqual([]);
});
