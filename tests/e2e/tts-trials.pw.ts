import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function open(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  return panel;
}
for (const count of [1, 2, 3, 4]) {
  test(`${count} takes stay inline, preserve history and focus the last completed alternative`, async ({
    page,
  }) => {
    const panel = await open(page),
      select = panel.getByRole('combobox', { name: 'Nombre d’essais', exact: true });
    await expect(select).toHaveValue('1');
    await expect(select.locator('option')).toHaveText(['1', '2', '3', '4']);
    const before = await page.evaluate(() => (window as any).__getMockProject());
    await select.selectOption(String(count));
    await panel.getByRole('spinbutton', { name: 'Graine', exact: true }).fill('4294967294');
    await panel
      .getByRole('button', {
        name: count === 1 ? 'Générer un nouvel essai' : `Générer ${count} nouveaux essais`,
        exact: true,
      })
      .click();
    await expect(panel).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
    await expect(select).toBeDisabled();
    const pending = await page.evaluate(() => (window as any).__pendingTts);
    expect(pending.count ?? 1).toBe(count);
    for (let i = 0; i < count; i++) {
      if (count === 1) await page.evaluate(() => (window as any).__completeTts());
      else {
        await expect(panel.locator('.current-job-progress')).toContainText(
          `${i} / ${count} essais terminés`,
        );
        await page.evaluate(() => (window as any).__advanceTrial());
      }
    }
    await expect(panel.locator('.generation-card')).toHaveCount(count + 1);
    await expect(panel.locator('.generation-card:focus')).toContainText(`Essai ${count + 1}`);
    await expect(select).toBeEnabled();
    await page.getByRole('button', { name: 'Fermer', exact: true }).click();
    await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
    await page.reload();
    const after = await page.evaluate(() => (window as any).__getMockProject());
    expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
    const added = after.generations.slice(before.generations.length);
    expect(added).toHaveLength(count);
    expect(added.map((g: any) => g.options.seed)).toEqual(
      Array.from({ length: count }, (_, i) => (4294967294 + i) >>> 0),
    );
    expect(after.dialogues[0].selectedGenerationIds.fr).toBe(added.at(-1).id);
    expect(after.sourceCues).toEqual(before.sourceCues);
    expect(after.targetCues).toEqual(before.targetCues);
  });
}
for (const error of [null, 'TTS_EMPTY_AUDIO']) {
  test(`partial series ${error ? 'failure' : 'cancellation'} keeps the completed alternative and stops`, async ({
    page,
  }) => {
    const panel = await open(page);
    await panel.getByRole('combobox', { name: 'Nombre d’essais' }).selectOption('4');
    await panel.getByRole('button', { name: 'Générer 4 nouveaux essais', exact: true }).click();
    await page.evaluate(() => (window as any).__advanceTrial());
    if (error) await page.evaluate((e) => (window as any).__advanceTrial(e), error);
    else
      await panel
        .locator('.current-job-progress')
        .getByRole('button', { name: 'Annuler', exact: true })
        .click();
    await expect(panel.locator('.generation-card')).toHaveCount(2);
    await expect(panel.locator('.generation-card:focus')).toContainText('Essai 2');
    await page.evaluate(() => (window as any).__advanceTrial());
    await expect(panel.locator('.generation-card')).toHaveCount(2);
    await expect(panel.getByRole('combobox', { name: 'Nombre d’essais' })).toBeEnabled();
  });
}
test('two-stage dubbing repeats the complete pipeline and keeps its intermediate takes', async ({
  page,
}) => {
  const panel = await open(page);
  await panel.getByRole('checkbox', { name: 'Doublage en 2 étapes : TTS puis timbre' }).check();
  await panel.getByRole('combobox', { name: 'Nombre d’essais' }).selectOption('2');
  await panel.getByRole('button', { name: 'Générer 2 nouveaux essais', exact: true }).click();
  for (let i = 0; i < 2; i++) await page.evaluate(() => (window as any).__advanceTrial());
  await expect(panel.locator('.generation-card')).toHaveCount(5);
  await expect(panel.locator('.generation-card:focus')).toContainText('Essai 5');
  const p = await page.evaluate(() => (window as any).__getMockProject()),
    finals = p.generations.filter((g: any) => g.dubbingPipeline);
  expect(finals).toHaveLength(2);
  expect(finals.map((g: any) => g.options.seed)).toEqual([0, 1]);
  expect(p.generations.filter((g: any) => g.dialogueId === p.dialogues[0].id)).toHaveLength(5);
});
