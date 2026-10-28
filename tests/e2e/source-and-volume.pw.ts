import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';
test('source transcription is reviewed before changing SRT, preserves timing, targets and takes, and is undoable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1680, height: 1200 });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Aide à la traduction', exact: true }).click();
  await page.locator('.source-transcription summary').click();
  const section = page.locator('.source-transcription'),
    before = await page.evaluate(() => (window as any).__getMockProject());
  await section.getByRole('combobox', { name: 'Langue de l’audio source' }).selectOption('ja');
  await section.getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__pendingSourceAsr)).toMatchObject({
    language: 'ja',
    trackId: 'auto',
  });
  await page.evaluate(() => (window as any).__completeSourceTranscription());
  const field = section.getByRole('textbox', { name: 'Proposition source 1', exact: true });
  await expect(field).toHaveValue('日本語の訂正。');
  await field.fill('日本語の訂正を確認。');
  expect((await page.evaluate(() => (window as any).__getMockProject())).sourceCues).toEqual(
    before.sourceCues,
  );
  await section.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/source-transcription-fr.png' });
  await section.getByRole('button', { name: 'Appliquer au SRT original', exact: true }).click();
  await expect(
    section.getByText('Texte original mis à jour. Vous pouvez annuler cette modification.', {
      exact: true,
    }),
  ).toBeVisible();
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.sourceCues[0].text).toBe('日本語の訂正を確認。');
  expect(after.sourceCues[0].startMs).toBe(before.sourceCues[0].startMs);
  expect(after.sourceCues[0].endMs).toBe(before.sourceCues[0].endMs);
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.generations).toEqual(before.generations);
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await page.evaluate(() => (window as any).__getMockProject())).sourceCues)
    .toEqual(before.sourceCues);
});
test('source ASR works independently of the translation LLM, supports cancellation and retains silent source text', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => ((window as any).__llmReady = false));
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Aide à la traduction', exact: true }).click();
  await page.locator('.source-transcription summary').click();
  const section = page.locator('.source-transcription');
  await section.getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await section.getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(
    section.getByRole('button', { name: 'Transcrire l’audio source', exact: true }),
  ).toBeEnabled();
  await section.getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await page.evaluate(() => (window as any).__completeSourceTranscription([], true));
  await expect(section.getByText(/Aucune parole exploitable détectée/)).toBeVisible();
  await expect(
    section.getByRole('button', { name: 'Appliquer au SRT original', exact: true }),
  ).toBeDisabled();
});
test('new and existing take gains are independent, persist and keep all archived takes', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('dialog', { name: 'Doublage', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  const next = panel.locator('.output-gain-control').filter({
    has: page.getByRole('slider', { name: 'Volume de sortie des nouveaux essais', exact: true }),
  });
  await next.getByRole('combobox').selectOption('150');
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingTts)).options.outputGain).toBe(1.5);
  await page.evaluate(() => (window as any).__completeTts());
  await page
    .getByRole('dialog', { name: 'Traitements', exact: true })
    .getByRole('button', { name: 'Fermer', exact: true })
    .click();
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const take = panel
    .locator('.output-gain-control')
    .filter({ has: page.getByRole('slider', { name: 'Volume de cet essai', exact: true }) });
  await expect(take.getByRole('slider')).toHaveValue('150');
  await take.getByRole('combobox').selectOption('175');
  const id = (await page.evaluate(() => (window as any).__getMockProject())).generations.at(-1).id;
  expect(
    (await page.evaluate(() => (window as any).__getMockProject())).voiceEdits[id].outputGain,
  ).toBe(1.5);
  await take.getByRole('button', { name: 'Appliquer le volume', exact: true }).click();
  await expect(take.getByRole('button')).toBeDisabled();
  await take.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/output-volume-fr.png' });
  let after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.voiceEdits[id].outputGain).toBe(1.75);
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations.at(-1).options.outputGain).toBe(1.5);
  await take.getByRole('combobox').selectOption('0');
  await take.getByRole('button').click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as any).__getMockProject())).voiceEdits[id].outputGain,
    )
    .toBe(0);
  await take.getByRole('combobox').selectOption('100');
  await take.getByRole('button').click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as any).__getMockProject())).voiceEdits[id].outputGain,
    )
    .toBeUndefined();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.length).toBe(before.generations.length + 1);
  expect(after.formatVersion).toBe(22);
});
test('batch generation uses the same gain presets', async ({ page }) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('dialog', { name: 'Doublage par lot', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await panel
    .getByRole('combobox', { name: 'Préréglage du volume de sortie', exact: true })
    .selectOption('175');
  await panel.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingBatch)).options.outputGain).toBe(1.75);
});
