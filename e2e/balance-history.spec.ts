import { expect, test } from '@playwright/test';
import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.js';
import { JsonDatabase } from '../server/store.js';

test('余额修改历史在浏览器中即时显示且只有最高系统用户可删除', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'balance-history-browser-'));
  const db = await new JsonDatabase(join(directory, 'database.json')).init();
  const password = 'balance-history-browser-password';
  const salt = 'balance-history-browser-salt';
  const passwordHash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  const accounts = ['zhaoyan', 'browser-operator', 'browser-target'].map((username, index) => ({
    id: randomUUID(), username, name: username, email: `${username}@example.test`, passwordHash,
    role: index < 2 ? 'system' : 'user', accountType: index < 2 ? 'system' : 'user',
    balanceCents: 0, createdAt: new Date().toISOString(), token: randomUUID(),
  }));
  await db.mutate((data) => {
    data.users = accounts.map(({ token: _token, ...user }) => user);
    data.sessions = accounts.map((user) => ({ id: randomUUID(), userId: user.id, tokenHash: createHash('sha256').update(user.token).digest('hex'), createdAt: Date.now(), expiresAt: Date.now() + 3600000, userAgent: 'balance-history-browser' }));
  });
  const { app } = await createApp({ database: db, serveFrontend: true, secureCookies: false, videoQueue: false, maintenance: false, monitoring: false, assetStorage: null, sendEmailCode: async () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  const switchUser = async (index: number) => {
    await page.context().addCookies([{ name: 'ads_session', value: accounts[index].token, url: origin }]);
    await page.goto(origin);
  };
  try {
    await switchUser(1);
    await page.getByTestId('open-system-admin').click();
    await expect(page.getByText('暂无余额修改记录', { exact: true })).toBeVisible();
    await page.getByPlaceholder('当前系统账号密码（余额、权限、退款确认）').fill(password);
    const row = page.locator('div[class*="grid-cols-[1fr_auto]"]').filter({ hasText: 'browser-target@example.test' });
    await row.getByPlaceholder('增减元').fill('25');
    await row.getByTitle('调整余额', { exact: true }).click();
    const history = page.getByRole('heading', { name: '余额修改记录', exact: true }).locator('../..');
    await expect(history.getByRole('listitem')).toHaveCount(1);
    await expect(history.getByText('browser-operator 给 browser-target')).toBeVisible();
    await expect(history.getByText('增加 ¥25.00')).toBeVisible();
    await expect(history.getByText('余额 ¥0.00 → ¥25.00')).toBeVisible();
    await row.getByPlaceholder('增减元').fill('-5');
    await row.getByTitle('调整余额', { exact: true }).click();
    await expect(history.getByRole('listitem')).toHaveCount(2);
    await expect(history.getByText('减少 ¥5.00')).toBeVisible();
    await expect(history.getByRole('button', { name: /删除/ })).toHaveCount(0);

    await switchUser(0);
    await page.getByTestId('open-system-admin').click();
    const rootHistory = page.getByRole('heading', { name: '余额修改记录', exact: true }).locator('../..');
    await expect(rootHistory.getByRole('listitem')).toHaveCount(2);
    await expect(rootHistory.getByRole('button', { name: /删除/ })).toHaveCount(2);
    await rootHistory.getByRole('button', { name: /删除/ }).first().click();
    await rootHistory.getByRole('button', { name: '取消', exact: true }).click();
    await expect(rootHistory.getByRole('listitem')).toHaveCount(2);
    await page.getByPlaceholder('当前系统账号密码（余额、权限、退款确认）').fill(password);
    await rootHistory.getByRole('button', { name: /删除/ }).first().click();
    await rootHistory.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(rootHistory.getByRole('listitem')).toHaveCount(1);
    expect(db.read('users').find((user) => user.id === accounts[2].id).balanceCents).toBe(2000);
    expect(db.read('balanceTransactions')).toHaveLength(2);
    await page.screenshot({ path: test.info().outputPath('balance-history.png'), fullPage: true });

    await switchUser(2);
    await expect(page.getByTestId('open-system-admin')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '余额修改记录', exact: true })).toHaveCount(0);
    expect((await page.request.get(`${origin}/api/admin/recharges`)).status()).toBe(403);
    expect(browserErrors).toEqual([]);
  } finally {
    await page.goto('about:blank');
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
