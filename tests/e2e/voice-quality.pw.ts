import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function setup(page: Page) {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
  return page.getByRole('dialog', { name: 'Doublage', exact: true });
}
test('Vox Natural is dispatched, saved with the take and reloads without changing previous takes', async ({ page }) => {
  const panel = await setup(page);
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!).generations);
  await panel.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('voxcpm2-bf16');
  await panel.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await panel.getByRole('combobox', { name: 'Qualité de génération', exact: true }).selectOption('natural');
  const quality = panel.getByRole('region', { name: 'Qualité de génération' });
  await quality.locator('summary').click();
  await expect(quality.getByRole('slider', { name: 'Étapes de synthèse', exact: true })).toHaveValue('20');
  await expect(quality.getByRole('slider', { name: 'Force du guidage', exact: true })).toHaveValue('1.6');
  await quality.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/voice-quality-voxcpm2-fr.png' });
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingTts)).options.quality).toEqual({ inferenceSteps: 20, cfgStrength: 1.6 });
  await page.evaluate(() => (window as any).__completeTts());
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(saved.formatVersion).toBe(19);
  expect(saved.generations.slice(0, before.length)).toEqual(before);
  expect(saved.generations.at(-1).options.quality).toEqual({ inferenceSteps: 20, cfgStrength: 1.6 });
});
test('each engine exposes only its supported controls and Standard clears overrides', async ({ page }) => {
  const panel = await setup(page);
  const engine = panel.getByRole('combobox', { name: 'Moteur et variante de voix' });
  const quality = panel.getByRole('region', { name: 'Qualité de génération' });
  await engine.selectOption('voxcpm2-bf16');
  await quality.locator('summary').click();
  await quality.getByRole('combobox').selectOption('natural');
  await quality.getByRole('slider', { name: 'Force du guidage', exact: true }).fill('1.7');
  await expect(quality.getByRole('combobox')).toHaveValue('custom');
  for (const [variant, count] of [['cosy3-official', 1], ['fish-s2-fp8', 3], ['fish-s2-gguf-q8', 3], ['drama3-comfy-fp8', 3], ['qwen3-06b-gguf-q8', 4], ['qwen3-17b-gguf-q8', 4], ['chatterbox-multilingual-v3', 6]] as const) {
    await engine.selectOption(variant);
    await expect(quality.getByRole('combobox')).toHaveValue('standard');
    await expect(quality.getByRole('slider')).toHaveCount(count);
  }
  await expect(quality.getByRole('slider', { name: 'Guidage de la référence', exact: true })).toHaveValue('0');
  await engine.selectOption('voxcpm2-bf16');
  await quality.getByRole('combobox').selectOption('natural');
  await quality.getByRole('combobox').selectOption('standard');
  await expect(quality.getByRole('slider', { name: 'Étapes de synthèse', exact: true })).toHaveValue('10');
  await expect(quality.getByRole('slider', { name: 'Force du guidage', exact: true })).toHaveValue('2');
});
test('batch generation accepts quality and MCP discovers every supported bound', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const batch = page.getByRole('dialog', { name: 'Doublage par lot', exact: true });
  await batch.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('voxcpm2-bf16');
  await batch.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await batch.getByRole('combobox', { name: 'Qualité de génération' }).selectOption('natural');
  await batch.getByRole('checkbox', { name: /Forcer un nouvel essai/ }).check();
  await batch.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingBatch)).options.quality).toEqual({ inferenceSteps: 20, cfgStrength: 1.6 });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Activer le pilotage MCP local', exact: true }).check();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpReady)).toBe(true);
  const catalog = await page.evaluate(() => (window as any).__mcp('studio_voice_quality_catalog', {}));
  expect(Object.keys(catalog.variants)).toHaveLength(8);
  expect(catalog.variants['voxcpm2-bf16'].parameters.inferenceSteps.max).toBe(30);
});
