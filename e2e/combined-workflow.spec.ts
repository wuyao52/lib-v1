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

  await expect(page.locator('.react-flow__node')).toHaveCount(5);
  const refreshedImage = page.locator('.react-flow__node[data-id="refresh-image-node"] img').first();
  await expect(refreshedImage).toBeVisible();
  await expect.poll(() => refreshedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const projectSettings = page.getByRole('banner').getByTitle('项目设置');
  await projectSettings.click();
  const portraitRatio = page.getByRole('button', { name: '9:16', exact: true });
  await portraitRatio.click();
  await expect(portraitRatio).toHaveAttribute('aria-pressed', 'true');
  await projectSettings.click();
  await page.getByRole('banner').getByTitle('AI模型配置').click();
  await page.getByRole('button', { name: '视频生成', exact: true }).click();
  const videoResolution = page.getByTestId('video-resolution');
  await expect(videoResolution).toBeVisible();
  await videoResolution.selectOption('480p');
  await expect(videoResolution).toHaveValue('480p');
  await videoResolution.selectOption('');
  await expect(videoResolution).toHaveValue('');
  await page.getByLabel('关闭 AI 模型配置').click();
  const nodes = page.locator('.react-flow__node');
  const targetNode = page.locator('.react-flow__node[data-id="batch-target"]');

  const imageNode = page.locator('.react-flow__node[data-id="refresh-image-node"]');
  const imageNodeBox = await imageNode.boundingBox();
  expect(imageNodeBox).not.toBeNull();
  const alignmentImage = page.locator('.react-flow__node[data-id="alignment-image-node"]');
  await expect(alignmentImage).toBeVisible();
  const alignmentImageBox = await alignmentImage.boundingBox();
  expect(alignmentImageBox).not.toBeNull();
  const dragStart = { x: alignmentImageBox!.x + 40, y: alignmentImageBox!.y + 20 };
  const dragEnd = { x: imageNodeBox!.x + imageNodeBox!.width + 90, y: imageNodeBox!.y + 20 };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 12 });
  const movedBox = await alignmentImage.boundingBox();
  expect(movedBox).not.toBeNull();
  await page.mouse.move(dragEnd.x, dragEnd.y - (movedBox!.y - imageNodeBox!.y), { steps: 2 });
  await expect(page.getByTestId('alignment-guide-y')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('alignment-guide-y')).toHaveCount(0);
  const alignedBox = await alignmentImage.boundingBox();
  expect(alignedBox).not.toBeNull();
  expect(Math.abs(alignedBox!.y - imageNodeBox!.y)).toBeLessThanOrEqual(1);
  await page.waitForTimeout(4700);

  const zoomOut = page.locator('.react-flow__controls-zoomout');
  for (let index = 0; index < 20 && await zoomOut.isEnabled(); index += 1) await zoomOut.click();
  const zoomScale = await page.locator('.react-flow__viewport').evaluate((viewport) => {
    const match = getComputedStyle(viewport).transform.match(/matrix\(([^)]+)\)/);
    return match ? Number(match[1].split(',')[0]) : 1;
  });
  expect(zoomScale).toBeLessThanOrEqual(0.11);
  await page.locator('.react-flow__controls-fitview').click();

  await page.waitForTimeout(2200);
  const putsBeforeUpload = projectPutCount;
  let uploadRequests = 0;
  let activeUploads = 0;
  let maxActiveUploads = 0;
  await page.route('**/api/assets/direct-upload', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadRequests += 1;
    if (uploadRequests === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'OBJECT_STORAGE_ERROR', message: 'temporary fixture failure' }) });
    return route.continue();
  });
  await page.route('**/__e2e/oss-upload**', async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    activeUploads += 1;
    maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
    await new Promise((resolve) => setTimeout(resolve, 150));
    try {
      const response = await route.fetch();
      await route.fulfill({ response });
    } finally {
      activeUploads -= 1;
    }
  });
  await page.locator('.react-flow__pane').evaluate((pane) => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2p4ZxQAAAABJRU5ErkJggg=='), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    ['multi-a.png', 'multi-b.png', 'multi-c.png'].forEach((name) => transfer.items.add(new File([png], name, { type: 'image/png' })));
    pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: 600, clientY: 450 }));
  });
  await expect.poll(() => uploadRequests).toBe(4);
  await expect(page.getByText('已上传 3/3')).toBeVisible();
  await expect(page.locator('.react-flow__node')).toHaveCount(8);
  await expect(page.locator('.react-flow__node').filter({ hasText: 'multi-a' })).toBeVisible();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'multi-b' })).toBeVisible();
  await expect(page.locator('.react-flow__node').filter({ hasText: 'multi-c' })).toBeVisible();
  expect(uploadRequests).toBe(4);
  expect(maxActiveUploads).toBeLessThanOrEqual(4);
  await expect.poll(() => projectPutCount - putsBeforeUpload, { timeout: 7000 }).toBe(1);
  browserErrors.splice(0, browserErrors.length);

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
  await expect(page.getByTestId('mention-menu')).toContainText('没有匹配的画布目标');
  await promptEditor.press('Backspace');
  await promptEditor.press('Escape');
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 650 } });

  const sourceHandle = page.locator('.react-flow__node[data-id="batch-source-a"] .react-flow__handle-right');
  const sourceHandleBox = await sourceHandle.boundingBox();
  const ordinaryTargetBox = await targetNode.boundingBox();
  expect(sourceHandleBox).not.toBeNull();
  expect(ordinaryTargetBox).not.toBeNull();
  await page.mouse.move(sourceHandleBox!.x + sourceHandleBox!.width / 2, sourceHandleBox!.y + sourceHandleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(ordinaryTargetBox!.x + ordinaryTargetBox!.width / 2, ordinaryTargetBox!.y + ordinaryTargetBox!.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  const edgePath = await page.locator('.react-flow__edge path.react-flow__edge-path').first().getAttribute('d');
  expect(edgePath).toContain('C');

  await page.locator('.react-flow__node[data-id="batch-source-a"]').click({ position: { x: 30, y: 20 }, force: true });
  await page.locator('.react-flow__node[data-id="batch-source-b"]').click({ position: { x: 30, y: 20 }, modifiers: ['Shift'], force: true });
  await expect(page.getByTestId('batch-connect-handle')).toBeVisible();
  await page.getByTitle('将选中目标连接到新组件').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(9);
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

  await targetNode.click({ position: { x: 30, y: 20 }, force: true });
  await promptEditor.click();
  await promptEditor.pressSequentially('@');
  await expect(page.getByTestId('mention-menu')).toBeVisible();
  const editorBox = await promptEditor.boundingBox();
  const menuBox = await page.getByTestId('mention-menu').boundingBox();
  expect(editorBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(editorBox!.y);
  await promptEditor.press('ArrowUp');
  await expect(page.getByTestId('mention-menu').locator('[aria-selected="true"]')).toHaveCount(1);
  await page.getByTestId('mention-option-batch-source-b').click();
  await expect(promptEditor.locator('[data-mention-id="batch-source-b"]').first()).toBeVisible();
  await page.locator('.react-flow__pane').click({ position: { x: 1100, y: 650 } });

  await page.getByTestId('add-image-node').click();
  await expect(page.locator('.react-flow__node')).toHaveCount(10);

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
  await expect(page.getByTestId('project-browser-project-scene-count')).toContainText('10');
  await page.getByTestId('project-browser-project').click();
  const restoredProjectSettings = page.getByRole('banner').getByTitle('项目设置');
  await restoredProjectSettings.click();
  await expect(page.getByRole('button', { name: '9:16', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await restoredProjectSettings.click();
  const imageAfterRefresh = page.locator('.react-flow__node[data-id="refresh-image-node"] img').first();
  await expect(imageAfterRefresh).toBeVisible();
  await expect.poll(() => imageAfterRefresh.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(browserErrors).toEqual([]);
});
