import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function setup(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__seedDubbing();
    const p = w.__getMockProject();
    p.dubbingTiming = {
      sourcePath: p.media.path,
      offsetsMs: { [p.dialogues[0].id]: { fr: 175 } },
      durationsMs: { [p.dialogues[0].id]: { fr: 1750 } },
    };
    w.__loadMockProject(p);
  });
  await page.locator('.dialogue-check').nth(0).check();
  await page.locator('.dialogue-check').nth(1).check();
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await panel.getByRole('button', { name: 'Harmoniser le timbre', exact: true }).click();
  return panel;
}
test('harmonizes checked selected takes with one generated reference and keeps editor and all previous takes', async ({
  page,
}) => {
  const p = await setup(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await p.getByRole('spinbutton', { name: 'Début de l’extrait (s)', exact: true }).fill('0.25');
  await p.getByRole('spinbutton', { name: 'Fin de l’extrait (s)', exact: true }).fill('1.75');
  await p
    .getByRole('combobox', { name: 'Périphérique de conversion du timbre', exact: true })
    .selectOption('cuda:0');
  await expect(
    p.getByRole('button', { name: 'Harmoniser 2 dialogues', exact: true }),
  ).toBeEnabled();
  await page.screenshot({ path: 'docs/screenshots/batch-timbre-fr.png' });
  await p.getByRole('button', { name: 'Harmoniser 2 dialogues', exact: true }).click();
  const o = await page.evaluate(() => (window as any).__pendingVoiceBatch);
  expect(o.lineIds).toEqual(before.dialogues.slice(0, 2).map((l: any) => l.id));
  expect(o.reference).toMatchObject({
    referenceMode: 'generation',
    referenceId: before.dialogues[0].selectedGenerationIds.fr,
    referenceRange: { startMs: 250, endMs: 1750 },
    device: 'cuda:0',
  });
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
  await expect(page.locator('video').first()).toBeVisible();
  await expect(page.locator('.timeline-pane').first()).toBeVisible();
  await page.evaluate(() => (window as any).__finishVoiceBatch());
  await expect(p.locator('.timbre-result')).toHaveCount(2);
  await expect(p.getByText('Nouvel essai créé', { exact: false })).toHaveCount(2);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations.length).toBe(before.generations.length + 2);
  expect(after.dubbingTiming).toEqual(before.dubbingTiming);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  await p.getByRole('button', { name: 'Écouter l’essai harmonisé', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});
test('supports imported reference ranges, rejects invalid generation ranges, and retries only failed rows', async ({
  page,
}) => {
  const p = await setup(page);
  await p.getByRole('spinbutton', { name: 'Fin de l’extrait (s)', exact: true }).fill('0.1');
  await expect(p.getByRole('button', { name: /^Harmoniser \d+ dialogue/ })).toBeDisabled();
  await p.getByRole('combobox', { name: 'Référence commune', exact: true }).selectOption('file');
  await p.getByRole('button', { name: 'Charger un fichier de référence', exact: true }).click();
  await p.getByRole('spinbutton', { name: 'Début de l’extrait (s)', exact: true }).fill('25');
  await p.getByRole('spinbutton', { name: 'Fin de l’extrait (s)', exact: true }).fill('30');
  await p.getByRole('button', { name: 'Utiliser cet extrait', exact: true }).click();
  await expect(
    p.getByRole('button', { name: 'Harmoniser 2 dialogues', exact: true }),
  ).toBeEnabled();
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await p.getByRole('button', { name: 'Harmoniser 2 dialogues', exact: true }).click();
  expect(
    (await page.evaluate(() => (window as any).__pendingVoiceBatch)).reference.referenceMode,
  ).toBe('reference');
  const id = before.dialogues[1].id;
  await page.evaluate((id) => (window as any).__finishVoiceBatch([id]), id);
  await expect(p.getByRole('button', { name: 'Relancer ce dialogue', exact: true })).toHaveCount(1);
  const first = await page.evaluate(() => (window as any).__getMockProject());
  await p.getByRole('button', { name: 'Relancer ce dialogue', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__voiceRetry)).lineIds).toEqual([id]);
  await page.evaluate(() => (window as any).__finishVoiceBatch());
  await expect(p.getByText('Nouvel essai créé', { exact: false })).toHaveCount(1);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.length).toBe(first.generations.length + 1);
  expect(after.dialogues[0].selectedGenerationIds.fr).toBe(
    first.dialogues[0].selectedGenerationIds.fr,
  );
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  await p.getByRole('button', { name: 'Harmoniser le timbre', exact: true }).click();
  await expect(
    p
      .getByRole('combobox', { name: 'Historique des harmonisations', exact: true })
      .locator('option'),
  ).toHaveCount(3);
});
