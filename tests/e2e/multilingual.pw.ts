import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('VoxCPM2 and Chatterbox dispatch supported settings and keep existing takes after reload', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!).generations);
  for (const variant of ['voxcpm2-bf16', 'chatterbox-multilingual-v3']) {
    await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
    const panel = page.getByRole('dialog', { name: 'Doublage', exact: true });
    await panel.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption(variant);
    await panel.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
    const mode = panel.getByRole('combobox', { name: 'Mode de clonage' });
    await expect(mode).toHaveValue('crossLingual');
    const mood = panel.getByRole('combobox', { name: 'Humeur / interprétation' });
    if (variant.startsWith('voxcpm')) {
      await expect(mode).toBeEnabled(); await mood.selectOption('stressed');
      await mood.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'docs/screenshots/voxcpm2-fr.png' });
    } else {
      await expect(mode).toBeDisabled(); await expect(mood).toBeDisabled(); await expect(mood).toHaveValue('default');
      await expect(panel.getByRole('combobox', { name: 'Accent souhaité (consigne)' })).toBeDisabled();
      await expect(panel.getByText(/la langue cible du projet/)).toBeVisible();
    }
    await panel.getByRole('combobox', { name: 'Périphérique de génération' }).selectOption('cuda:0');
    await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
    const pending = await page.evaluate(() => (window as any).__pendingTts);
    expect(pending.options.variantId).toBe(variant); expect(pending.options.mode).toBe('crossLingual');
    await page.evaluate(() => (window as any).__completeTts());
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  }
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(saved.formatVersion).toBe(16); expect(saved.generations).toHaveLength(before.length + 2);
  expect(saved.generations.slice(0, before.length)).toEqual(before);
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const batch = page.getByRole('dialog', { name: 'Doublage par lot', exact: true });
  await batch.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('voxcpm2-bf16');
  await batch.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await batch.getByRole('checkbox', { name: /Forcer un nouvel essai/ }).check();
  await batch.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingBatch)).options.variantId).toBe('voxcpm2-bf16');
});

test('new model cards check the chosen variant space again before downloading', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await page.evaluate(() => { (window as any).__multilingualReady = false; });
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const card = page.locator('.multilingual-model').filter({ hasText: 'Chatterbox Multilingual V3' });
  await expect(card.getByRole('button', { name: 'Installer cette variante', exact: true })).toBeEnabled();
  await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: 'docs/screenshots/chatterbox-model-fr.png' });
  await page.evaluate(() => { (window as any).__dramaSpace = { path: 'F:/Models', availableBytes: 0, requiredBytes: 30 * 1024 ** 3, modelBytes: 3208844550, downloadBytes: 4 * 1024 ** 3, runtimeBytes: 12 * 1024 ** 3, marginBytes: 2 * 1024 ** 3, enough: false }; });
  await card.getByRole('button', { name: 'Installer cette variante', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Installer cette variante', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).__calls);
  expect(calls.filter((c: any) => c.command === 'voice_install_space').some((c: any) => c.args.variantId === 'chatterbox-multilingual-v3')).toBe(true);
  expect(calls.some((c: any) => c.command === 'install_voice_runtime')).toBe(false);
});
