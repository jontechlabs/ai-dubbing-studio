import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('Audio8 uses its exact transcript mode, inline progress and preserves historical takes', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!).generations);
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  await panel.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('audio8-realistic-06b-gguf-q8');
  await panel.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toHaveValue('zeroShot');
  await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toBeDisabled();
  await expect(panel.getByRole('combobox', { name: 'Humeur / interprétation' })).toBeDisabled();
  await expect(panel.getByRole('combobox', { name: 'Accent souhaité (consigne)' })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Périphérique de génération' }).selectOption('vulkan:1');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const pending = await page.evaluate(() => (window as any).__pendingTts);
  expect(pending.options).toMatchObject({ variantId: 'audio8-realistic-06b-gguf-q8', device: 'vulkan:1', mode: 'zeroShot', accent: 'auto', mood: 'default' });
  await expect(panel).toBeVisible();
  await page.evaluate(() => (window as any).__completeTts());
  await expect(panel).toBeVisible();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(saved.formatVersion).toBe(26); expect(saved.generations.slice(0, before.length)).toEqual(before);
  expect(saved.generations.at(-1).providerId).toBe('audio8-tts');
});

test('Audio8 shows its disk budget and checks free space before installation', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const card = page.locator('.multilingual-model').filter({ hasText: 'Audio8-TTS Realistic' });
  await expect(card.getByText(/Apache 2.0/)).toBeVisible();
  await page.evaluate(() => { (window as any).__dramaSpace = { path: 'F:/Models', availableBytes: 0, requiredBytes: 3 * 1024 ** 3, modelBytes: 1429472157, downloadBytes: 61728860, runtimeBytes: 512 * 1024 ** 2, marginBytes: 1024 ** 3, enough: false }; });
  await card.getByRole('button', { name: 'Vérifier / réparer cette variante', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Vérifier / réparer cette variante', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).__calls);
  expect(calls.some((c: any) => c.command === 'voice_install_space' && c.args.variantId === 'audio8-realistic-06b-gguf-q8')).toBe(true);
  expect(calls.some((c: any) => c.command === 'install_voice_runtime')).toBe(false);
});

test('Audio8 preference does not inherit unsupported legacy Cosy mood or diffusion controls', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('nativeMockProject')!);
    p.formatVersion = 26;
    p.modelPreferences = { ttsProviderId: 'audio8-tts', voiceVariantId: 'audio8-realistic-06b-gguf-q8' };
    p.dialogues[0].voiceSettings = { device: 'auto', referenceMode: 'current', referenceId: null, mode: 'crossLingual', speed: 1, seed: 7, mood: 'angry', accent: 'fr-FR', quality: { inferenceSteps: 20 } };
    localStorage.setItem('nativeMockProject', JSON.stringify(p));
  });
  await page.reload();
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Moteur et variante de voix' })).toHaveValue('audio8-realistic-06b-gguf-q8');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const pending = await page.evaluate(() => (window as any).__pendingTts);
  expect(pending.options).toMatchObject({ mode: 'zeroShot', mood: 'default', accent: 'auto' });
  expect(pending.options.quality).toBeUndefined();
});
