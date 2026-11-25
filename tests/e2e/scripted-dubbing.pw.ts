import { expect, test, type Page } from '@playwright/test';
import { demoProject } from '../../src/domain/project';
import { nativeMock } from './nativeMock';

async function open(page: Page) {
  const p = demoProject();
  p.formatVersion = 31;
  p.modelPreferences = { ttsProviderId: 'zonos3', voiceVariantId: 'zonos3-mini-gguf' };
  p.voiceReferences = [
    {
      id: 'woman',
      label: 'Femme française',
      path: 'characters/woman.wav',
      durationMs: 5000,
      transcript: 'Bonjour.',
    },
    {
      id: 'girl',
      label: 'Jeune fille française',
      path: 'characters/girl.wav',
      durationMs: 3000,
      transcript: 'Oui !',
    },
  ];
  await nativeMock(page, false, p);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  await page.getByRole('button', { name: 'Script', exact: true }).click();
  return page.getByRole('region', { name: 'Script multi-personnages', exact: true });
}
async function prepare(page: Page) {
  const panel = await open(page);
  await panel
    .getByRole('textbox', { name: 'Script à doubler', exact: true })
    .fill('[Speaker 1: Femme adulte] Mademoiselle Natsuki Kodama.\n[Speaker 2: Jeune fille] Oui !');
  await panel.getByRole('textbox', { name: 'Début du script', exact: true }).fill('00:00:01.000');
  await panel.getByRole('button', { name: 'Préparer les interventions', exact: true }).click();
  await panel
    .locator('.script-speaker')
    .nth(0)
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('file:woman');
  await panel
    .locator('.script-speaker')
    .nth(1)
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('file:girl');
  const second = panel.locator('.script-turns fieldset').nth(1);
  await second.getByRole('spinbutton', { name: 'Début (s)', exact: true }).fill('2');
  await second.getByRole('spinbutton', { name: 'Fin (s)', exact: true }).fill('3');
  return panel;
}
test('tagged script creates overlapping independent dialogues and generates with each reference, preserving all old takes', async ({
  page,
}) => {
  const panel = await prepare(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await panel
    .getByRole('button', { name: 'Vérifier le script et les références', exact: true })
    .click();
  await expect(panel.getByRole('status')).toContainText('Prêt : 2 interventions');
  await panel.locator('details.settings-section > summary').first().click();
  await panel
    .getByRole('button', { name: 'Créer les répliques et les pistes', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/script-dubbing-fr.png' });
  await panel
    .getByRole('button', { name: 'Créer les répliques et les pistes', exact: true })
    .click();
  await panel.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('2');
  await panel.getByRole('button', { name: 'Générer 4 nouveaux essais', exact: true }).click();
  await expect(panel.locator('.current-job-progress').first()).toContainText('0 / 4');
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
  for (let i = 0; i < 4; i++) await page.evaluate(() => (window as any).__advanceBatch());
  await expect(panel.locator('.script-take')).toHaveCount(4);
  await expect(panel.locator('.script-take:focus')).toHaveCount(1);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.media).toEqual(before.media);
  for (const cue of before.targetCues) expect(after.targetCues).toContainEqual(cue);
  const created = after.dialogues.filter(
    (l: any) => !before.dialogues.some((old: any) => old.id === l.id),
  );
  expect(created.map((l: any) => [l.startMs, l.endMs])).toEqual([
    [1000, 4000],
    [2000, 3000],
  ]);
  expect(new Set(created.map((l: any) => after.dubbingLanes.assignments[l.id])).size).toBe(2);
  const added = after.generations.slice(before.generations.length);
  expect(added.map((g: any) => g.options.referenceId)).toEqual(['woman', 'woman', 'girl', 'girl']);
  expect(added.map((g: any) => g.text)).toEqual([
    'Mademoiselle Natsuki Kodama.',
    'Mademoiselle Natsuki Kodama.',
    'Oui !',
    'Oui !',
  ]);
  await panel.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('1');
  await panel.getByRole('button', { name: 'Générer 2 nouveaux essais', exact: true }).click();
  for (let i = 0; i < 2; i++) await page.evaluate(() => (window as any).__advanceBatch());
  await expect(panel.locator('.script-take')).toHaveCount(6);
  const regenerated = await page.evaluate(() => (window as any).__getMockProject());
  expect(regenerated.dialogues).toHaveLength(after.dialogues.length);
  expect(regenerated.generations.slice(0, after.generations.length)).toEqual(after.generations);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.documentElement.scrollHeight <= window.innerHeight + 1,
    ),
  ).toBeTruthy();
  await page.reload();
  expect((await page.evaluate(() => (window as any).__getMockProject())).dubbingLanes).toEqual(
    after.dubbingLanes,
  );
});
test('malformed speaker tags are rejected before creating dialogues', async ({ page }) => {
  const panel = await open(page),
    before = await page.evaluate(() => (window as any).__getMockProject());
  await panel
    .getByRole('textbox', { name: 'Script à doubler', exact: true })
    .fill('[Speaker 1] Bonjour [Speaker 2] Oui');
  await panel.getByRole('button', { name: 'Préparer les interventions', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Utilisez un bloc par intervention');
  await expect(
    panel.getByRole('button', { name: 'Créer les répliques et les pistes', exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__getMockProject())).toEqual(before);
});
test('native validation errors stay inline and invalidate a previously checked plan', async ({
  page,
}) => {
  const panel = await prepare(page);
  await page.evaluate(() => ((window as any).__scriptError = 'SCRIPT_SPEAKER_OVERLAP'));
  await panel
    .getByRole('button', { name: 'Vérifier le script et les références', exact: true })
    .click();
  await expect(panel.getByRole('alert')).toContainText(
    'Deux interventions de la même voix se chevauchent',
  );
  await expect(
    panel.getByRole('button', { name: 'Créer les répliques et les pistes', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => ((window as any).__scriptError = ''));
  await panel
    .getByRole('button', { name: 'Vérifier le script et les références', exact: true })
    .click();
  await expect(
    panel.getByRole('button', { name: 'Créer les répliques et les pistes', exact: true }),
  ).toBeEnabled();
  await panel
    .locator('.script-turns fieldset')
    .first()
    .getByRole('spinbutton', { name: 'Fin (s)', exact: true })
    .fill('5');
  await expect(
    panel.getByRole('button', { name: 'Créer les répliques et les pistes', exact: true }),
  ).toBeDisabled();
});
test('cancelling a script batch keeps its completed takes and dialogues', async ({ page }) => {
  const panel = await prepare(page);
  await panel
    .getByRole('button', { name: 'Vérifier le script et les références', exact: true })
    .click();
  await panel
    .getByRole('button', { name: 'Créer les répliques et les pistes', exact: true })
    .click();
  await panel.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('4');
  await panel.getByRole('button', { name: 'Générer 8 nouveaux essais', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceBatch());
  await panel
    .locator('.current-job-progress')
    .first()
    .getByRole('button', { name: 'Annuler', exact: true })
    .click();
  await page.evaluate(() => (window as any).__advanceBatch());
  await expect(panel.locator('.script-take')).toHaveCount(1);
  await expect(
    panel.getByRole('button', { name: 'Générer 8 nouveaux essais', exact: true }),
  ).toBeEnabled();
});
