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

  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  const nodes = page.locator('.react-flow__node');
  await nodes.nth(0).click({ position: { x: 30, y: 20 }, force: true });
  await nodes.nth(1).click({ position: { x: 30, y: 20 }, modifiers: ['Shift'], force: true });
  await expect(page.getByTestId('batch-connect-handle')).toBeVisible();
  const handleBox = await page.getByTestId('batch-connect-handle').boundingBox();
  const targetBox = await nodes.nth(2).boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.getByTestId('batch-connect-handle').dispatchEvent('pointerdown', {
    clientX: handleBox!.x + handleBox!.width / 2,
    clientY: handleBox!.y + handleBox!.height / 2,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
  });
  await expect(page.getByTestId('batch-connection-line')).toBeVisible();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(2);

  await page.getByTestId('add-image-node').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);

  const batchSaved = page.waitForResponse((response) => response.url().endsWith('/api/projects/browser-project') && response.request().method() === 'PUT' && response.ok());
  await page.getByTestId('save-project').click();
  await batchSaved;

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
  await expect(page.getByTestId('project-browser-project-scene-count')).toContainText('4');
  expect(browserErrors).toEqual([]);
});
