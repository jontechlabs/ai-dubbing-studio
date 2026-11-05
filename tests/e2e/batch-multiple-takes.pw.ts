import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
const project = (p: Page) => p.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
async function batch(page: Page) {
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const p = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await p.getByRole('combobox', { name: 'Référence vocale', exact: true }).selectOption('current');
  return p;
}
for (const count of [1, 2, 3, 4])
  test(`${count} new take(s) per dialogue keep previous takes, offset seeds and show the total`, async ({
    page,
  }) => {
    await ready(page);
    await page.evaluate(() => (window as any).__seedDubbing());
    const before = await project(page),
      p = await batch(page);
    await p
      .getByRole('combobox', { name: 'Essais par réplique', exact: true })
      .selectOption(String(count));
    await p.getByRole('spinbutton', { name: 'Graine', exact: true }).fill('7');
    await p.getByRole('checkbox', { name: /Forcer un nouvel essai/ }).check();
    const launch = p.getByRole('button', {
      name: count === 1 ? 'Doubler 4 répliques' : `Générer ${4 * count} essais`,
      exact: true,
    });
    await expect(launch).toBeEnabled();
    if (count === 4) {
      await p
        .getByRole('combobox', { name: 'Essais par réplique', exact: true })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await p.screenshot({ path: 'docs/screenshots/batch-multiple-takes-fr.png' });
    }
    await launch.click();
    expect(await page.evaluate(() => (window as any).__pendingBatch.takeCount ?? 1)).toBe(count);
    await page.evaluate((n) => {
      for (let i = 0; i < n; i++) (window as any).__advanceBatch();
    }, 4 * count);
    const after = await project(page);
    expect(after.generations).toHaveLength(before.generations.length + 4 * count);
    for (const g of before.generations) expect(after.generations).toContainEqual(g);
    for (const line of after.dialogues) {
      const fresh = after.generations
        .slice(before.generations.length)
        .filter((g: any) => g.dialogueId === line.id);
      expect(fresh.map((g: any) => g.options.seed)).toEqual(
        Array.from({ length: count }, (_, i) => 7 + i),
      );
    }
    expect(after.sourceCues).toEqual(before.sourceCues);
    expect(after.targetCues).toEqual(before.targetCues);
    await expect(p.locator('.current-job-progress')).toContainText(
      count > 1 ? `${4 * count} / ${4 * count} essais traités` : '4 / 4 traitées',
    );
  });
test('a failed alternative can be retried exactly without regenerating successful alternatives of the same dialogue', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole('checkbox', { name: 'Cocher la réplique 1 pour le lot', exact: true })
    .check();
  const p = await batch(page);
  await p.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('3');
  await p.getByRole('button', { name: 'Générer 3 essais', exact: true }).click();
  await page.evaluate(() => {
    const w = window as any;
    w.__advanceBatch();
    w.__advanceBatch('TTS_EMPTY_AUDIO');
    w.__advanceBatch();
  });
  const before = await project(page);
  await p.getByRole('button', { name: 'Répliques du lot · 1 échec(s)', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(d).toContainText('Essai 2 / 3');
  await d.getByRole('button', { name: 'Relancer la réplique 1, essai 2', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__retrySelection)).toEqual({
    scope: 'selected',
    lineIds: [],
    itemIndices: [1],
  });
  await page.evaluate(() => (window as any).__advanceBatch());
  await expect(d).toContainText('Aucun échec ni réplique non traitée dans ce lot.');
  const after = await project(page);
  expect(after.generations).toHaveLength(3);
  for (const g of before.generations) expect(after.generations).toContainEqual(g);
});
test('four-take count survives reload and cancellation resumes only unfinished alternatives', async ({
  page,
}) => {
  await ready(page);
  await page
    .getByRole('checkbox', { name: 'Cocher la réplique 1 pour le lot', exact: true })
    .check();
  const p = await batch(page);
  await p.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('4');
  await p.getByRole('button', { name: 'Générer 4 essais', exact: true }).click();
  await page.evaluate(() => (window as any).__advanceBatch());
  await p
    .locator('.current-job-progress')
    .getByRole('button', { name: 'Annuler', exact: true })
    .click();
  const before = await project(page);
  await page.reload();
  const reopened = await batch(page);
  await reopened
    .getByRole('button', { name: 'Historique des doublages par lot', exact: true })
    .click();
  const h = page.getByRole('dialog', { name: 'Historique des doublages par lot', exact: true });
  await expect(h).toContainText('4 essais par réplique');
  await expect(h).toContainText('1 essai(s) réussi(s) · 0 en échec · 3 non traité(s)');
  await h.getByRole('button', { name: 'Voir le bilan et relancer', exact: true }).click();
  const d = page.getByRole('dialog', { name: 'Résultats du doublage par lot', exact: true });
  await expect(d.locator('.batch-recovery-row.pending')).toHaveCount(3);
  await d
    .getByRole('button', { name: 'Relancer les échecs et les non-traitées', exact: true })
    .click();
  await page.evaluate(() => {
    for (let i = 0; i < 3; i++) (window as any).__advanceBatch();
  });
  await expect(d).toContainText('Aucun échec ni réplique non traitée dans ce lot.');
  const after = await project(page);
  expect(after.generations).toHaveLength(4);
  expect(after.generations).toContainEqual(before.generations[0]);
});
