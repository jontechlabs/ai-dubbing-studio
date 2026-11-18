import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function panel(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await nativeMock(page);
  await page.goto('/');
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Ajouter un doublage', exact: true }).click();
  const dub = page.getByRole('region', { name: 'Doublage', exact: true }),
    section = dub.locator('.speaker-separation');
  await section.locator('summary').click();
  return { dub, section };
}
test('TF-GridNet exposes safe 16 GB and manual profiles and preserves the explicitly selected GPU', async ({
  page,
}) => {
  const { dub, section } = await panel(page);
  await section
    .getByRole('combobox', { name: 'Séparateur de voix', exact: true })
    .selectOption('tf-gridnet-wsj0-2mix');
  const profile = section.getByRole('combobox', { name: 'Profil de séparation', exact: true }),
    window = section.getByRole('combobox', { name: 'Fenêtre de traitement', exact: true });
  await expect(profile).toHaveValue('gpu16');
  await expect(window).toHaveValue('2');
  await expect(window).toBeDisabled();
  await expect(
    section.getByRole('combobox', { name: 'Nombre de voix à séparer', exact: true }),
  ).toHaveCount(0);
  await profile.selectOption('quality');
  await expect(window).toHaveValue('4');
  await profile.selectOption('manual');
  await expect(window).toBeEnabled();
  await window.selectOption('8');
  await profile.selectOption('gpu16');
  await section
    .getByRole('combobox', { name: 'Périphérique de génération', exact: true })
    .selectOption('cuda:0');
  await section
    .getByRole('button', { name: 'Isoler les voix de cette réplique', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__speakerOptions)).toMatchObject({
    modelId: 'tf-gridnet-wsj0-2mix',
    speakerCount: 2,
    memoryProfile: 'gpu16',
    windowSeconds: 2,
    device: 'cuda:0',
  });
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(section.locator('audio')).toHaveCount(2);
  await expect(section.getByText(/Fenêtre utilisée : 2 s/)).toBeVisible();
  await expect(dub).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});
test('SR-CorrNet places five voices on independent tracks and persists the new project format and previous takes', async ({
  page,
}) => {
  const { section } = await panel(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await section
    .getByRole('combobox', { name: 'Séparateur de voix', exact: true })
    .selectOption('sr-corrnet-wsj-2-5spk');
  await section
    .getByRole('combobox', { name: 'Nombre de voix à séparer', exact: true })
    .selectOption('5');
  await section
    .getByRole('button', { name: 'Isoler les voix de cette réplique', exact: true })
    .click();
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(section.locator('audio')).toHaveCount(5);
  await section
    .getByRole('combobox', { name: 'Utiliser les voix pour', exact: true })
    .selectOption('lanes');
  const placement = section.locator('.isolated-dubbing-placement');
  await placement
    .getByRole('button', { name: 'Créer les essais et placer les voix', exact: true })
    .click();
  await expect(
    placement.getByRole('checkbox', { name: 'Voix déjà placée', exact: true }),
  ).toHaveCount(5);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.formatVersion).toBe(35);
  expect(after.dubbingLanes.lanes).toHaveLength(6);
  const contained = await page.locator('.timeline-track').evaluateAll((rows) =>
    rows.every((row) =>
      Array.from(row.querySelectorAll('.dubbing-block')).every((clip) => {
        const c = clip.getBoundingClientRect(),
          r = row.getBoundingClientRect();
        return c.top >= r.top && c.bottom <= r.bottom;
      }),
    ),
  );
  expect(contained).toBe(true);

  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations).toHaveLength(before.generations.length + 5);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
  await section
    .getByRole('combobox', { name: 'Nombre de voix à séparer', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/spectral-separation.png', fullPage: true });
  await page.reload();
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__getMockProject().speakerDubbings?.[0]?.voices.length),
    )
    .toBe(5);
});
test('free-region previews are discarded when the requested stream count or memory profile changes', async ({
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
    .selectOption('sr-corrnet-wsj-2-5spk');
  const count = toolbox.getByRole('combobox', { name: 'Nombre de voix à séparer', exact: true }),
    profile = toolbox.getByRole('combobox', { name: 'Profil de séparation', exact: true });
  await count.selectOption('3');
  await toolbox.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(toolbox.locator('.toolbox-results audio')).toHaveCount(3);
  await count.selectOption('5');
  await expect(toolbox.locator('.toolbox-results')).toHaveCount(0);
  await profile.selectOption('quality');
  await toolbox.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__speakerOptions)).toMatchObject({
    speakerCount: 5,
    memoryProfile: 'quality',
    windowSeconds: 4,
  });
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(toolbox.locator('.toolbox-results audio')).toHaveCount(5);
});
