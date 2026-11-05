import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
async function panel(page: Page) {
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  return page.getByRole('region', { name: 'Doublage par lot', exact: true });
}
async function history(page: Page) {
  const p = await panel(page);
  await p.getByRole('button', { name: 'Historique des doublages par lot', exact: true }).click();
  return page.getByRole('dialog', { name: 'Historique des doublages par lot', exact: true });
}
const project = (page: Page) => page.evaluate(() => (window as any).__getMockProject());

test('saved batch history survives reload without auto-start; retry failed rows preserves earlier takes and options', async ({
  page,
}) => {
  await ready(page);
  const p = await panel(page);
  await p.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await p.getByRole('spinbutton', { name: 'Graine' }).fill('17');
  await p.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.__advanceBatch();
    w.__advanceBatch('TTS_EMPTY_AUDIO');
    w.__advanceBatch('TTS_ENGINE_FAILED');
    w.__advanceBatch();
  });
  const before = await project(page);
  await page.reload();
  const h = await history(page);
  await expect(h.locator('.batch-recovery-row')).toHaveCount(1);
  await expect(h).toContainText('2 réussite(s) · 2 échec(s) · 0 non traitée(s)');
  await expect(h.locator('time')).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) =>
        ['generate_dubbing_batch', 'retry_dubbing_batch'].includes(c.command),
      ),
    ),
  ).toEqual([]);
  await h.screenshot({ path: 'docs/screenshots/batch-history-fr.png' });
  await h.getByRole('button', { name: 'Voir le bilan et relancer', exact: true }).click();
  const detail = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(detail.locator('.batch-recovery-row.failed')).toHaveCount(2);
  await detail.getByRole('button', { name: 'Relancer les échecs (2)', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.__advanceBatch();
    w.__advanceBatch();
  });
  await expect(detail).toContainText('Aucun échec ni réplique non traitée dans ce lot.');
  const after = await project(page);
  expect(after.generations).toHaveLength(4);
  for (const g of before.generations) expect(after.generations).toContainEqual(g);
  expect(after.generations.every((g: any) => g.options.seed === 17)).toBe(true);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  await page.reload();
  const reopened = await history(page);
  await expect(reopened.locator('.batch-recovery-row')).toHaveCount(1);
  await expect(reopened).toContainText('4 réussite(s) · 0 échec(s)');
  await expect(reopened).toContainText('1 relance(s)');
  await reopened
    .getByRole('checkbox', { name: 'Uniquement les lots à reprendre', exact: true })
    .check();
  await expect(reopened).toContainText('Aucun lot enregistré pour ce projet avec ce filtre.');
});

test('history paginates newest first, separates projects and target languages, and closing keeps journals', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject(),
      archive: any = {};
    for (let i = 0; i < 24; i++)
      archive[`saved-${i}`] = {
        reportId: `saved-${i}`,
        projectId: p.id,
        language: p.languages.target,
        createdAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
        options: { options: { variantId: 'cosy3-official' } },
        retryCount: 0,
        skipped: 0,
        rows: [{ id: p.dialogues[0].id, status: 'failed', error: 'TTS_EMPTY_AUDIO' }],
      };
    archive.foreign = { ...archive['saved-0'], reportId: 'foreign', projectId: 'other-project' };
    archive.english = { ...archive['saved-0'], reportId: 'english', language: 'en' };
    localStorage.setItem('nativeMockBatchHistory', JSON.stringify(archive));
  });
  const h = await history(page);
  await expect(h.locator('.batch-recovery-row')).toHaveCount(20);
  await expect(h.locator('time').first()).toHaveAttribute('datetime', '2026-01-24T00:00:00.000Z');
  await expect(h).toContainText('1–20 / 24');
  await h.getByRole('button', { name: 'Suivant', exact: true }).click();
  await expect(h.locator('.batch-recovery-row')).toHaveCount(4);
  await expect(h).toContainText('21–24 / 24');
  await h.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  const again = await history(page);
  await expect(again).toContainText('1–20 / 24');
  expect(
    await page.evaluate(
      () => Object.keys(JSON.parse(localStorage.getItem('nativeMockBatchHistory')!)).length,
    ),
  ).toBe(26);
});

test('an interrupted batch reopens with pending rows and can be dismissed without resuming', async ({
  page,
}) => {
  await ready(page);
  const p = await panel(page);
  await p.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  await p.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.__advanceBatch();
    w.__failBatchFatal();
  });
  const before = await project(page);
  await page.reload();
  const h = await history(page);
  await expect(h).toContainText('Incomplet / interrompu');
  await expect(h).toContainText('1 réussite(s) · 1 échec(s) · 2 non traitée(s)');
  await h.getByRole('button', { name: 'Voir le bilan et relancer', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(d.locator('.batch-recovery-row.pending')).toHaveCount(2);
  await d.getByRole('button', { name: 'Fermer le récapitulatif', exact: true }).click();
  expect((await project(page)).generations).toEqual(before.generations);
  expect(
    await page.evaluate(() =>
      (window as any).__calls.some((c: any) => c.command === 'retry_dubbing_batch'),
    ),
  ).toBe(false);
});
