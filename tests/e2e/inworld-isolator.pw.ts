import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('Inworld previews both outputs before reversible same-time placement and preserves earlier takes and subtitles', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const section = page.locator('.audio-toolbox');
  await section.locator('summary').click();
  await section
    .getByRole('combobox', { name: 'Outil de séparation', exact: true })
    .selectOption('inworld-voice-isolator-v1');
  await expect(
    section.getByRole('combobox', { name: 'Fenêtre de traitement', exact: true }),
  ).toHaveValue('2');
  await expect(section).toContainText('aucun personnage à cibler');
  await section
    .getByRole('combobox', { name: 'Périphérique de séparation', exact: true })
    .selectOption('cuda:0');
  await section.getByRole('spinbutton', { name: 'Début (s)', exact: true }).fill('1');
  await section.getByRole('spinbutton', { name: 'Fin (s)', exact: true }).fill('3');
  await section.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__pendingToolbox)).toMatchObject({
    modelId: 'inworld-voice-isolator-v1',
    device: 'cuda:0',
    windowSeconds: 2,
    startMs: 1000,
    endMs: 3000,
  });
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect(section.locator('.toolbox-output audio')).toHaveCount(2);
  await expect(
    section.getByRole('button', { name: 'Appliquer les sorties choisies', exact: true }),
  ).toBeDisabled();
  await section
    .getByRole('combobox', { name: 'Destination : Voix', exact: true })
    .selectOption('role:speech');
  await section
    .getByRole('combobox', { name: 'Destination : Fond retiré', exact: true })
    .selectOption('role:sfx');
  await section
    .getByRole('checkbox', { name: 'Rendre muette la section de la piste source', exact: true })
    .check();
  await section
    .getByRole('button', { name: 'Appliquer les sorties choisies', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/inworld-isolator.png' });
  await section
    .getByRole('button', { name: 'Appliquer les sorties choisies', exact: true })
    .click();
  await expect(
    section.getByText('Sorties appliquées à la timeline.', { exact: true }),
  ).toBeVisible();
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.media).toEqual(before.media);
  expect(after.generations.filter((g: any) => g.kind === 'audioPatch')).toHaveLength(2);
});

test('Inworld can be frozen in the separation-then-dubbing queue with two-second windows', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  const composer = panel.locator('.workflow-composer');
  await composer
    .getByRole('combobox', { name: 'Actions du lot', exact: true })
    .selectOption('separateDub');
  await expect(
    composer.getByRole('combobox', { name: 'Outil de séparation', exact: true }),
  ).toBeEnabled();
  await composer
    .getByRole('combobox', { name: 'Outil de séparation', exact: true })
    .selectOption('inworld-voice-isolator-v1');
  await expect(composer).toContainText('aucun personnage à cibler');
  await composer.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
  await expect(composer.getByRole('status').filter({ hasText: 'Tâche ajoutée' })).toBeVisible();
  const calls = await page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.command === 'enqueue_workflow'),
  );
  expect(calls.at(-1).args.spec.separation).toMatchObject({
    modelId: 'inworld-voice-isolator-v1',
    windowSeconds: 2,
  });
});
