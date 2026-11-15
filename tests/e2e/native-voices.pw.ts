import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function open(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  return panel;
}
test('ZONOS3 French orientation remains independent of quality presets and adds a take without changing prior ones', async ({
  page,
}) => {
  const panel = await open(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await panel
    .getByRole('combobox', { name: 'Moteur et variante de voix' })
    .selectOption('zonos3-mini-gguf');
  await panel.locator('.voice-accent').getByRole('combobox').selectOption('fr-FR');
  const strength = panel.getByRole('slider', { name: 'Intensité de l’orientation française' });
  await strength.fill('0.75');
  await panel.getByRole('combobox', { name: 'Qualité de génération' }).selectOption('stable');
  await expect(strength).toHaveValue('0.75');
  await expect(panel.getByRole('combobox', { name: 'Humeur / interprétation' })).toBeDisabled();
  await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toBeDisabled();
  await panel
    .getByRole('combobox', { name: 'Périphérique de génération' })
    .selectOption('vulkan:1');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const pending = await page.evaluate(() => (window as any).__pendingTts);
  expect(pending.options).toMatchObject({
    variantId: 'zonos3-mini-gguf',
    device: 'vulkan:1',
    mode: 'crossLingual',
    accent: 'fr-FR',
    quality: { accentStrength: 0.75, temperature: 0.65 },
  });
  await page.evaluate(() => (window as any).__completeTts());
  await expect(
    panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }),
  ).toBeEnabled();
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations.at(-1).providerId).toBe('zonos3');
  expect(after.formatVersion).toBe(31);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await panel.locator('.voice-accent').scrollIntoViewIfNeeded();
  await panel
    .locator('.voice-accent')
    .screenshot({ path: 'docs/screenshots/zonos3-french-fr.png' });
});
test('MOSS Local uses transcript-free native cloning and only supported quality controls', async ({
  page,
}) => {
  const panel = await open(page);
  await panel
    .getByRole('combobox', { name: 'Moteur et variante de voix' })
    .selectOption('moss-local-v15-gguf-q8');
  await expect(panel.locator('.voice-accent').getByRole('combobox')).toBeDisabled();
  await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toHaveValue(
    'crossLingual',
  );
  await expect(panel.getByRole('combobox', { name: 'Humeur / interprétation' })).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Qualité de génération' }).selectOption('stable');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingTts)).options).toMatchObject({
    variantId: 'moss-local-v15-gguf-q8',
    mode: 'crossLingual',
    accent: 'auto',
    quality: { temperature: 1.3 },
  });
  await expect(panel).toBeVisible();
});
test('new native installation reports disk preflight and refuses to start with insufficient space', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__native095Ready = false;
    (window as any).__dramaSpace = {
      path: 'F:/Models/voice-engines',
      availableBytes: 100,
      requiredBytes: 3000000000,
      modelBytes: 1160861792,
      downloadBytes: 85462928,
      runtimeBytes: 536870912,
      marginBytes: 1073741824,
      enough: false,
    };
  });
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const card = page
    .locator('.model-card')
    .filter({ has: page.getByRole('heading', { name: 'ZONOS3-Mini · GGUF Q4/Q8', exact: true }) });
  await expect(card).toContainText('Espace insuffisant');
  await expect(card.getByRole('button', { name: /Installer/ })).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__lastVoiceInstall)).toBeUndefined();
});
