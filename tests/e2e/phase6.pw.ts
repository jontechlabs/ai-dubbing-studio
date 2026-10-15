import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('Qwen GGUF uses the selected Vulkan GPU and persists a labelled take', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await nativeMock(page); await page.goto('/');
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Doubler', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Doublage' });
  await panel.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('qwen3-06b-gguf-q8');
  await panel.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await panel.getByRole('combobox', { name: 'Périphérique de génération' }).selectOption('vulkan:1');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const args = await page.evaluate(() => (window as any).__pendingTts);
  expect(args.options.variantId).toBe('qwen3-06b-gguf-q8'); expect(args.options.device).toBe('vulkan:1');
  await page.evaluate(() => (window as any).__completeTts());
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
  await expect(panel.locator('.generation-card').getByText(/Qwen3-TTS Base 0.6B/)).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/phase6-dubbing.png' });
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload(); await page.locator('.dialogue-card').first().getByRole('button', { name: 'Régénérer', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Moteur et variante de voix' })).toHaveValue('qwen3-06b-gguf-q8');
  expect(errors).toEqual([]);
});

test('Fish FP8 requires reference text and sends CUDA options to its engine', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await page.locator('.dialogue-card').first().getByRole('button', { name: 'Doubler', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Doublage' });
  await panel.getByRole('combobox', { name: 'Moteur et variante de voix' }).selectOption('fish-s2-fp8');
  await expect(panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await panel.getByRole('combobox', { name: 'Périphérique de génération' }).selectOption('cuda:0');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const args = await page.evaluate(() => (window as any).__pendingTts);
  expect(args.options.variantId).toBe('fish-s2-fp8'); expect(args.options.mode).toBe('zeroShot'); expect(args.options.device).toBe('cuda:0');
});

test('models expose installable GGUF and FP8 variants with sizes and license information', async ({ page }) => {
  await nativeMock(page); await page.goto('/'); await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Modèles' });
  const card = panel.locator('.model-card').filter({ has: page.getByRole('heading', { name: 'Fish S2 Pro · FP8 E4M3', exact: true }) });
  await expect(card.getByText(/1.85 GiB/)).toBeVisible();
  await expect(card.getByText(/Fish Audio Research License/)).toBeVisible();
  await panel.locator('.panel-body').evaluate((element) => { element.scrollTop = 380; });
  await page.screenshot({ path: 'docs/screenshots/phase6-models.png' });
  await card.getByRole('button', { name: 'Vérifier / réparer cette variante' }).click();
  expect(await page.evaluate(() => (window as any).__calls.some((c: any) => c.command === 'install_voice_runtime' && c.args.variantId === 'fish-s2-fp8'))).toBe(true);
});
