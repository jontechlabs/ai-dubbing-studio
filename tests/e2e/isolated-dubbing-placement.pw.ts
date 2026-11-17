import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function separate(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await nativeMock(page);
  await page.goto('/');
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Ajouter un doublage', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true }),
    section = panel.locator('.speaker-separation');
  await section.locator('summary').click();
  await section
    .getByRole('combobox', { name: 'Séparateur de voix', exact: true })
    .selectOption('sepformer-3mix');
  await section
    .getByRole('combobox', { name: 'Fenêtre de traitement', exact: true })
    .selectOption('4');
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await section
    .getByRole('button', { name: 'Isoler les voix de cette réplique', exact: true })
    .click();
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await section
    .getByRole('combobox', { name: 'Utiliser les voix pour', exact: true })
    .selectOption('lanes');
  const placement = section.locator('.isolated-dubbing-placement');
  await expect(placement.locator('fieldset')).toHaveCount(3);
  return { panel, section, placement, before };
}
test('places selected isolated voices on distinct dubbing tracks and preserves every old take and subtitle', async ({
  page,
}) => {
  const { panel, placement, before } = await separate(page);
  await placement
    .locator('fieldset')
    .nth(2)
    .getByRole('checkbox', { name: 'Placer cette voix', exact: true })
    .uncheck();
  await placement
    .locator('fieldset')
    .first()
    .getByRole('textbox', { name: 'Nom de la nouvelle piste', exact: true })
    .fill('Cris du personnage A');
  await placement
    .getByRole('button', { name: 'Créer les essais et placer les voix', exact: true })
    .click();
  await expect(
    placement.getByRole('checkbox', { name: 'Voix déjà placée', exact: true }),
  ).toHaveCount(2);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  const voices = after.speakerDubbings.at(-1).voices;
  expect(voices).toHaveLength(2);
  expect(after.dubbingLanes.assignments[voices[0].lineId]).not.toEqual(
    after.dubbingLanes.assignments[voices[1].lineId],
  );
  expect(after.dubbingLanes.lanes.some((l: any) => l.name === 'Cris du personnage A')).toBe(true);
  expect(
    after.generations
      .slice(-2)
      .every(
        (g: any) =>
          g.takeOrigin.type === 'separation' &&
          g.takeOrigin.sourceLanguage === before.languages.source,
      ),
  ).toBe(true);
  await expect(panel).toBeVisible();
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
  await page.setViewportSize({ width: 1600, height: 1400 });
  await placement.locator('summary').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'docs/screenshots/isolated-dubbing-placement.png',
    fullPage: true,
  });
  // Remaining output can be placed later on an existing lane, without
  // duplicating the group or either already placed take.
  const last = placement.locator('fieldset').nth(2);
  await last.getByRole('checkbox', { name: 'Placer cette voix', exact: true }).check();
  await last.getByRole('combobox', { name: 'Piste de doublage', exact: true }).selectOption('main');
  await placement
    .getByRole('button', { name: 'Créer les essais et placer les voix', exact: true })
    .click();
  const more = await page.evaluate(() => (window as any).__getMockProject());
  expect(more.speakerDubbings).toHaveLength(1);
  expect(more.dialogues).toHaveLength(before.dialogues.length + 3);
  expect(more.generations).toHaveLength(before.generations.length + 3);
  expect(more.generations.slice(0, after.generations.length)).toEqual(after.generations);
  await expect(
    placement.getByRole('button', { name: 'Créer les essais et placer les voix', exact: true }),
  ).toBeDisabled();
});
test('free timeline selection can create missing dialogues and independent isolated takes', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const toolbox = page.locator('.audio-toolbox');
  await toolbox.locator('summary').click();
  await toolbox.getByRole('spinbutton', { name: 'Début (s)', exact: true }).fill('2.1');
  await toolbox.getByRole('spinbutton', { name: 'Fin (s)', exact: true }).fill('3.8');
  await toolbox
    .getByRole('combobox', { name: 'Outil de séparation', exact: true })
    .selectOption('mossformer2-16k');
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await toolbox.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  const placement = toolbox.locator('.isolated-dubbing-placement');
  await placement.locator('summary').click();
  await expect(placement.getByText(/La séparation ne traduit pas/)).toBeVisible();
  await placement
    .getByRole('button', { name: 'Créer les essais et placer les voix', exact: true })
    .click();
  await expect(
    placement.getByRole('button', { name: 'Créer les essais et placer les voix', exact: true }),
  ).toBeDisabled();
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.dialogues).toHaveLength(before.dialogues.length + 3);
  expect(
    after.dialogues
      .slice(-3)
      .every(
        (l: any) =>
          l.startMs === 2100 &&
          l.endMs === 3800 &&
          l.sourceCueIds.length === 0 &&
          l.targetCueIds.length === 0,
      ),
  ).toBe(true);
  expect(after.generations).toHaveLength(before.generations.length + 2);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
});
