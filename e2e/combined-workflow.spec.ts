import { expect, test } from '@playwright/test';

test.afterAll(async ({ request }) => {
  await request.post('/__e2e/shutdown').catch(() => undefined);
});

test('旧项目、画布保存、历史、系统控制台和重登可联合使用', async ({ page }) => {
  const browserErrors: string[] = [];
  let projectPutCount = 0;
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('request', (request) => {
    if (request.method() === 'PUT' && request.url().endsWith('/api/projects/browser-project')) projectPutCount += 1;
  });

  await page.goto('/__e2e/login');
  await expect(page.getByTestId('project-browser-project')).toBeVisible();
  await page.getByTestId('project-browser-project').click();
  await expect(page.getByTestId('add-image-node')).toBeVisible();

  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  const refreshedImage = page.locator('.react-flow__node[data-id="refresh-image-node"] img').first();
  await expect(refreshedImage).toBeVisible();
  await expect.poll(() => refreshedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const nodes = page.locator('.react-flow__node');
  const targetNode = page.locator('.react-flow__node[data-id="batch-target"]');
  await page.waitForTimeout(2200);
  const putsBeforeSelection = projectPutCount;
  await page.locator('.react-flow__node[data-id="batch-source-a"]').click({ force: true });
  await page.locator('.react-flow__node[data-id="batch-source-b"]').click({ modifiers: ['Shift'], force: true });
  await page.waitForTimeout(2200);
  expect(projectPutCount).toBe(putsBeforeSelection);
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 650 } });
  await targetNode.click({ position: { x: 30, y: 20 }, force: true });
  const promptEditor = page.getByRole('textbox', { name: '提示词' });
  await promptEditor.click();
  await promptEditor.pressSequentially('@');
  await expect(page.getByTestId('mention-menu')).toBeVisible();
  const editorBox = await promptEditor.boundingBox();
  const menuBox = await page.getByTestId('mention-menu').boundingBox();
  expect(editorBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(editorBox!.y);
  await promptEditor.press('ArrowUp');
  await expect(page.getByTestId('mention-option-batch-source-b')).toHaveAttribute('aria-selected', 'true');
  await promptEditor.press('Enter');
  await expect(promptEditor.locator('[data-mention-id="batch-source-b"]')).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 650 } });

  await page.locator('.react-flow__node[data-id="batch-source-a"]').click({ position: { x: 30, y: 20 }, force: true });
  await page.locator('.react-flow__node[data-id="batch-source-b"]').click({ position: { x: 30, y: 20 }, modifiers: ['Shift'], force: true });
  await expect(page.getByTestId('batch-connect-handle')).toBeVisible();
  await page.getByTitle('将选中目标连接到新组件').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  await expect(page.getByTestId('node-saved-references')).toContainText('批量来源 A');
  await expect(page.getByTestId('node-saved-references')).toContainText('批量来源 B');
  const handleBox = await page.getByTestId('batch-connect-handle').boundingBox();
  const targetBox = await targetNode.boundingBox();
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
  await expect(page.locator('.react-flow__edge')).toHaveCount(4);

  await page.getByTestId('add-image-node').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(6);

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
  await expect(page.getByTestId('project-browser-project-scene-count')).toContainText('6');
  await page.getByTestId('project-browser-project').click();
  const imageAfterRefresh = page.locator('.react-flow__node[data-id="refresh-image-node"] img').first();
  await expect(imageAfterRefresh).toBeVisible();
  await expect.poll(() => imageAfterRefresh.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(browserErrors).toEqual([]);
});
