import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
test.use({ timezoneId: 'Indian/Reunion' });
const project = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
async function start(page: Page) {
  await ready(page);
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await panel.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  return panel;
}
test('existing takes show the stored generation date and second-precise local time', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const h = window as any;
    h.__seedDubbing();
    const p = h.__getMockProject();
    for (const g of p.generations) g.createdAt = '2026-11-04T10:15:16Z';
    h.__loadMockProject(p);
  });
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  await page
    .locator('.dub-navigation')
    .getByRole('button', { name: 'Essais', exact: true })
    .click();
  await expect(page.locator('.generation-card time')).toContainText('04/11/2026 14:15:16');
  await expect(page.locator('.generation-card time')).toHaveAttribute(
    'datetime',
    '2026-11-04T10:15:16Z',
  );
  await page.screenshot({ path: 'docs/screenshots/take-created-at-fr.png' });
});
test('batch errors can be retried together then individually without repeating successful takes; summary can be dismissed and restored', async ({
  page,
}) => {
  const panel = await start(page);
  await page.evaluate(() => {
    const h = window as any;
    h.__advanceBatch();
    h.__advanceBatch('TTS_EMPTY_AUDIO');
    h.__advanceBatch('TTS_ENGINE_FAILED');
    h.__advanceBatch();
  });
  const before = await project(page);
  await panel.getByRole('button', { name: 'Répliques du lot · 2 échec(s)', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(modal.locator('.batch-recovery-row.failed')).toHaveCount(2);
  await modal
    .getByRole('checkbox', { name: 'Sélectionner la réplique 2 à relancer', exact: true })
    .check();
  await modal
    .getByRole('checkbox', { name: 'Sélectionner la réplique 3 à relancer', exact: true })
    .check();
  await modal.screenshot({ path: 'docs/screenshots/batch-recovery-fr.png' });
  await modal.getByRole('button', { name: 'Relancer la sélection (2)', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__retrySelection)).toEqual({
    scope: 'selected',
    lineIds: before.dialogues.slice(1, 3).map((l) => l.id),
  });
  await page.evaluate(() => {
    const h = window as any;
    h.__advanceBatch();
    h.__advanceBatch('TTS_EMPTY_AUDIO');
  });
  await expect(modal.locator('.batch-recovery-row.failed')).toHaveCount(1);
  await modal.getByRole('button', { name: 'Relancer la réplique 3', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceBatch());
  await expect(
    modal.getByText('Aucun échec ni réplique non traitée dans ce lot.', { exact: true }),
  ).toBeVisible();
  await modal
    .getByRole('checkbox', {
      name: 'Afficher aussi les réussites et les répliques ignorées',
      exact: true,
    })
    .check();
  await expect(modal.locator('.batch-recovery-row.succeeded')).toHaveCount(4);
  const after = await project(page);
  expect(after.generations).toHaveLength(4);
  for (const g of before.generations) expect(after.generations).toContainEqual(g);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  await modal.getByRole('button', { name: 'Fermer le récapitulatif', exact: true }).click();
  await expect(panel.locator('.current-job-progress')).toHaveCount(0);
  await expect(panel.locator('.generation-card')).toBeVisible();
  await panel.getByRole('button', { name: 'Réafficher le suivi', exact: true }).click();
  await expect(panel.locator('.current-job-progress')).toBeVisible();
});
test('fatal interruption keeps unprocessed lines distinct and retries only failures and remaining dialogues', async ({
  page,
}) => {
  const panel = await start(page);
  await page.evaluate(() => {
    const h = window as any;
    h.__advanceBatch();
    h.__failBatchFatal();
  });
  const before = await project(page);
  await panel.getByRole('button', { name: 'Répliques du lot · 1 échec(s)', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(modal.locator('.batch-recovery-row.failed')).toHaveCount(1);
  await expect(modal.locator('.batch-recovery-row.pending')).toHaveCount(2);
  await modal
    .getByRole('button', { name: 'Relancer les échecs et les non-traitées', exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__batchRows.map((r: any) => r.id))).toEqual(
    before.dialogues.slice(1).map((l) => l.id),
  );
  await page.evaluate(() => {
    const h = window as any;
    h.__advanceBatch();
    h.__advanceBatch();
    h.__advanceBatch();
  });
  await expect(
    modal.getByText('Aucun échec ni réplique non traitée dans ce lot.', { exact: true }),
  ).toBeVisible();
  expect((await project(page)).generations).toContainEqual(before.generations[0]);
});
