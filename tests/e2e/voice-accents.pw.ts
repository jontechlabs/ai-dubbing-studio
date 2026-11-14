import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { installedVoiceVariants } from '../../src/domain/voiceEngines';
import { demoProject } from '../../src/domain/project';

async function open(page: Page, batch = false) {
  const project = demoProject();
  project.formatVersion = 9;
  project.voiceReferences = [
    {
      id: 'french-file',
      label: 'Référence française',
      path: 'characters/french.wav',
      durationMs: 6000,
      transcript: 'Une référence française très claire.',
    },
  ];
  await nativeMock(page, false, project);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page
    .getByRole('button', { name: batch ? /Doublage par lot/ : 'Régénérer', exact: !batch })
    .first()
    .click();
  return page.getByRole('region', { name: batch ? 'Doublage par lot' : 'Doublage', exact: true });
}

for (const variant of installedVoiceVariants) {
  test(`${variant.id}: accent availability matches the integrated engine`, async ({ page }) => {
    const panel = await open(page);
    await panel
      .getByRole('combobox', { name: 'Moteur et variante de voix' })
      .selectOption(variant.id);
    const control = panel.locator('.voice-accent');
    const select = control.getByRole('combobox');
    if (['audio8-tts', 'qwen3-tts', 'chatterbox'].includes(variant.providerId)) {
      await expect(select).toBeDisabled();
      await expect(select.locator('option')).toHaveCount(1);
      await expect(select.locator('option:checked')).toHaveText(
        'Accent guidé par la référence vocale',
      );
      await expect(control).toContainText(
        variant.providerId === 'audio8-tts' ? 'sa transcription exacte' : 'automatiquement',
      );
      await expect(control.getByRole('button')).toHaveCount(0);
    } else {
      if (variant.id === 'voxcpm2-bf16')
        await panel.getByRole('combobox', { name: 'Mode de clonage' }).selectOption('crossLingual');
      await expect(select).toBeEnabled();
      await expect(select.locator('option')).toHaveCount(5);
      await select.selectOption('fr-CA');
      await expect(select).toHaveValue('fr-CA');
    }
  });
}

for (const guide of ['off', 'hybrid'] as const) {
  test(`Vox ${guide}: restore accent instructions explicitly and preserve reference and takes`, async ({
    page,
  }) => {
    const panel = await open(page);
    await panel
      .getByRole('combobox', { name: 'Moteur et variante de voix' })
      .selectOption('voxcpm2-bf16');
    await panel
      .getByRole('combobox', { name: 'Référence vocale', exact: true })
      .selectOption('file');
    await panel.getByRole('combobox', { name: 'Référence à utiliser' }).selectOption('french-file');
    if (guide === 'hybrid')
      await panel
        .getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' })
        .selectOption('hybrid');
    else await panel.getByRole('combobox', { name: 'Mode de clonage' }).selectOption('zeroShot');
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
    const before = await page.evaluate(() => (window as any).__getMockProject());
    const control = panel.locator('.voice-accent');
    await expect(control.getByRole('combobox')).toBeDisabled();
    await expect(control).toContainText('ne prennent pas ces consignes en charge');
    await control
      .getByRole('button', { name: 'Activer le choix d’accent · passer en Standard' })
      .click();
    await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toHaveValue(
      'crossLingual',
    );
    await expect(
      panel.getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' }),
    ).toHaveValue('off');
    await control.getByRole('combobox').selectOption('fr-FR');
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
    const after = await page.evaluate(() => (window as any).__getMockProject());
    expect(after.dialogues[0].voiceSettings).toMatchObject({
      mode: 'crossLingual',
      accent: 'fr-FR',
      referenceMode: 'file',
      referenceId: 'french-file',
    });
    expect(after.dialogues[0].voiceSettings.intonationGuide).toBeUndefined();
    expect(after.generations).toEqual(before.generations);
    expect(after.voiceReferences).toEqual(before.voiceReferences);
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await page.reload();
    expect(
      (await page.evaluate(() => (window as any).__getMockProject())).dialogues[0].voiceSettings
        .accent,
    ).toBe('fr-FR');
  });
}

for (const previous of ['audio8-realistic-06b-gguf-q8', 'fish-s2-fp8']) {
  test(`switching from ${previous} to Vox starts in Standard instead of inheriting forced continuation`, async ({
    page,
  }) => {
    const panel = await open(page);
    const engine = panel.getByRole('combobox', { name: 'Moteur et variante de voix' });
    await engine.selectOption(previous);
    await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toHaveValue('zeroShot');
    await engine.selectOption('voxcpm2-bf16');
    await expect(panel.getByRole('combobox', { name: 'Mode de clonage' })).toHaveValue(
      'crossLingual',
    );
    await expect(panel.locator('.voice-accent').getByRole('combobox')).toBeEnabled();
    await panel.locator('.voice-accent').getByRole('combobox').selectOption('fr-FR');
    await panel
      .getByRole('combobox', { name: 'Référence vocale', exact: true })
      .selectOption('current');
    await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
    const request = await page.evaluate(() => (window as any).__pendingTts);
    expect(request.options).toMatchObject({
      variantId: 'voxcpm2-bf16',
      mode: 'crossLingual',
      accent: 'fr-FR',
    });
    expect(request.options.intonationGuide).toBeUndefined();
  });
}

test('Vox batch restores Standard accent selection and dispatches the explicit accent', async ({
  page,
}) => {
  const panel = await open(page, true);
  await panel
    .getByRole('combobox', { name: 'Moteur et variante de voix' })
    .selectOption('voxcpm2-bf16');
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await panel.getByRole('combobox', { name: 'Mode de clonage' }).selectOption('zeroShot');
  await panel
    .getByRole('button', { name: 'Activer le choix d’accent · passer en Standard' })
    .click();
  await panel.locator('.voice-accent').getByRole('combobox').selectOption('fr-BE');
  await panel.getByRole('checkbox', { name: /Forcer un nouvel essai/ }).check();
  await panel.getByRole('button', { name: /Doubler \d+ répliques/, exact: true }).click();
  const pending = await page.evaluate(() => (window as any).__pendingBatch);
  expect(pending.options).toMatchObject({
    variantId: 'voxcpm2-bf16',
    mode: 'crossLingual',
    accent: 'fr-BE',
  });
  expect(pending.options.intonationGuide).toBeUndefined();
  // Keep settings editable for the next queued batch; only immediate dispatch is busy.
  await expect(panel.locator('.voice-accent').getByRole('combobox')).toBeEnabled();
  await expect(
    panel.getByRole('button', { name: /Doubler \d+ répliques/, exact: true }),
  ).toBeDisabled();
});

test('a non-French project gets a language-specific explanation instead of incompatible accent choices', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    const p = JSON.parse(localStorage.getItem('nativeMockProject')!);
    p.languages.target = 'en';
    localStorage.setItem('nativeMockProject', JSON.stringify(p));
  });
  await page.reload();
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Doubler', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  const control = panel.locator('.voice-accent');
  await expect(control.getByRole('combobox')).toBeDisabled();
  await expect(control.getByRole('combobox').locator('option')).toHaveCount(1);
  await expect(control).toContainText('langue cible est le français');
});
