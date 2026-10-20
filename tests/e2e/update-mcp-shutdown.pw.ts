import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

async function ready(page: import('@playwright/test').Page) {
  await nativeMock(page); await page.goto('/');
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Activer le pilotage MCP local', exact: true }).check();
  await page.getByRole('button', { name: 'Rechercher une mise à jour' }).click();
  await page.getByRole('button', { name: 'Télécharger la mise à jour' }).click();
  await expect(page.getByRole('button', { name: 'Installer et redémarrer' })).toBeEnabled();
}
test('update saves first, suspends MCP before launching NSIS and preserves opt-in', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Installer et redémarrer' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.command === 'mcp_prepare_update'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__installed)).not.toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__installed), { timeout: 10000 }).toBe(true);
  const result = await page.evaluate(() => ({ calls: (window as any).__calls.map((c: any) => c.command), optedIn: localStorage.getItem('mockMcpEnabled') }));
  expect(result.calls.lastIndexOf('mcp_prepare_update')).toBeLessThan(result.calls.lastIndexOf('plugin:updater|install'));
  expect(result.optedIn).toBe('true');
});
test('failed installation restores MCP without installing or changing the project', async ({ page }) => {
  await ready(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.evaluate(() => (window as any).__installError = true);
  await page.getByRole('button', { name: 'Installer et redémarrer' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.command === 'mcp_update_failed')), { timeout: 10000 }).toBe(true);
  expect((await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('mcp_status'))).enabled).toBe(true);
  expect(await page.evaluate(() => (window as any).__getMockProject())).toEqual(before);
  await expect(page.getByRole('button', { name: 'Installer et redémarrer' })).toBeEnabled();
});
test('a job appearing before install prevents MCP suspension and NSIS launch', async ({ page }) => {
  await ready(page); await page.evaluate(() => (window as any).__updateBusy = true);
  await page.getByRole('button', { name: 'Installer et redémarrer' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('mcp_status'))).enabled).toBe(true);
  expect(await page.evaluate(() => (window as any).__installed)).not.toBe(true);
});
test('a job started while relays close blocks installation and restores MCP', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: 'Installer et redémarrer' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.command === 'mcp_prepare_update'))).toBe(true);
  await page.evaluate(() => (window as any).__updateBusy = true);
  await expect(page.getByRole('alert')).toBeVisible({ timeout: 10000 });
  expect((await page.evaluate(() => (window as any).__TAURI_INTERNALS__.invoke('mcp_status'))).enabled).toBe(true);
  expect(await page.evaluate(() => (window as any).__installed)).not.toBe(true);
});
