import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

async function setup(page: Page, kind: 'conversion' | 'prosody') {
  await nativeMock(page);
  await page.goto('/');
  await page.locator('.dialogue-card').first().waitFor();
  await page.evaluate(() => {
    const w = window as any;
    w.__seedDubbing();
    const p = w.__getMockProject();
    p.voiceReferences = [
      {
        id: 'french',
        label: 'Référence française',
        path: 'references/french.wav',
        durationMs: 3000,
        transcript: 'Une voix française.',
      },
    ];
    localStorage.setItem('nativeMockProject', JSON.stringify(p));
  });
  await page.reload();
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('dialog', { name: 'Doublage', exact: true });
  await panel
    .locator(kind === 'conversion' ? '.conversion-panel summary' : '.prosody-transfer summary')
    .click();
  if (kind === 'conversion')
    await panel
      .getByRole('combobox', { name: 'Référence pour le timbre', exact: true })
      .selectOption('file:french');
  const launch = panel.getByRole('button', {
    name:
      kind === 'conversion'
        ? 'Créer un essai avec ce timbre'
        : 'Créer un nouvel essai avec cette intonation',
    exact: true,
  });
  return { panel, launch };
}

for (const kind of ['conversion', 'prosody'] as const)
  for (const order of ['jobFirst', 'projectFirst'] as const) {
    test(`${kind} stays inline and focuses its selected new take with ${order} event ordering`, async ({
      page,
    }) => {
      const { panel, launch } = await setup(page, kind),
        before = await page.evaluate(() => (window as any).__getMockProject());
      await launch.click();
      await expect(panel.locator('.current-job-progress')).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
      await page.evaluate((order) => (window as any).__completeDerived(order), order);
      if (order === 'jobFirst') {
        await expect(panel.locator('.generation-card')).toHaveCount(1);
        await page.evaluate(() => (window as any).__flushDerivedProject());
      } else {
        await expect(panel.locator('.generation-card')).toHaveCount(2);
        await expect(panel.locator('.generation-card.selected')).not.toBeFocused();
        await page.evaluate(() => (window as any).__finishDerivedJob());
      }
      const after = await page.evaluate(() => (window as any).__getMockProject()),
        id = after.generations.at(-1).id;
      expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
      expect(after.dialogues[0].selectedGenerationIds.fr).toBe(id);
      const card = panel.locator(`[data-generation-id="${id}"]`);
      await expect(card).toHaveClass(/selected/);
      await expect(card).toBeFocused();
      await expect(card).toBeInViewport({ ratio: 0.3 });
      await expect(
        panel.locator(kind === 'conversion' ? '.conversion-panel' : '.prosody-transfer'),
      ).toHaveAttribute('open', '');
      await expect(panel.locator('.current-job-progress')).toContainText('Terminé');
      await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
      if (kind === 'conversion' && order === 'jobFirst')
        await panel.screenshot({ path: 'docs/screenshots/dubbing-inline-result-fr.png' });
    });
  }

test('a conversion finishing before its start reply still selects and focuses only the new take', async ({
  page,
}) => {
  const { panel, launch } = await setup(page, 'conversion');
  await page.evaluate(() => ((window as any).__instantDerived = true));
  await launch.click();
  const card = panel.locator('.generation-card.selected');
  await expect(panel.locator('.generation-card')).toHaveCount(2);
  await expect(card).toBeFocused();
  await expect(panel.locator('.current-job-progress')).toContainText('Terminé');
  expect(await card.getAttribute('data-generation-id')).toBe(
    await page.evaluate(() => (window as any).__lastDerivedId),
  );
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});

test('inline cancellation, failure and retry preserve old takes and expose the successful retry result', async ({
  page,
}) => {
  const { panel, launch } = await setup(page, 'prosody'),
    before = await page.evaluate(() => (window as any).__getMockProject());
  await launch.click();
  const progress = panel.locator('.current-job-progress');
  await progress.getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.evaluate(() => (window as any).__completeDerived());
  expect((await page.evaluate(() => (window as any).__getMockProject())).generations).toEqual(
    before.generations,
  );
  await progress.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await page.evaluate(() => (window as any).__failPanelJob());
  await expect(progress.getByRole('alert')).toBeVisible();
  expect((await page.evaluate(() => (window as any).__getMockProject())).generations).toEqual(
    before.generations,
  );
  await progress.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await page.evaluate(() => (window as any).__completeDerived());
  await expect(panel.locator('.generation-card.selected')).toBeFocused();
  await expect(progress).toContainText('Terminé');
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations).toHaveLength(before.generations.length + 1);
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});

test('finishing after an intentional close never reopens or redirects the user to a different dialogue', async ({
  page,
}) => {
  const { panel, launch } = await setup(page, 'prosody');
  await launch.click();
  await panel.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.evaluate(() => (window as any).__completeDerived());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .locator('.dialogue-card')
    .nth(1)
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  await expect(panel.locator('.generation-card.selected')).toHaveAttribute(
    'data-generation-id',
    'take-2',
  );
  await expect(panel.locator('.generation-card.selected')).not.toBeFocused();
  await expect(panel.locator('.current-job-progress')).toHaveCount(0);
});

test('a rejected launch shows its error inline and a later successful launch still focuses the new take', async ({
  page,
}) => {
  const { panel, launch } = await setup(page, 'conversion');
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.evaluate(() => ((window as any).__rejectConversion = true));
  await launch.click();
  await expect(panel.locator('.current-job-progress').getByRole('alert')).toBeVisible();
  await expect(launch).toBeEnabled();
  expect((await page.evaluate(() => (window as any).__getMockProject())).generations).toEqual(
    before.generations,
  );
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
  await page.evaluate(() => ((window as any).__rejectConversion = false));
  await launch.click();
  await page.evaluate(() => (window as any).__completeDerived());
  await expect(panel.locator('.generation-card.selected')).toBeFocused();
  await expect(panel.locator('.current-job-progress')).toContainText('Terminé');
  await page.evaluate(() => {
    for (let i = 0; i < 105; i++)
      (window as any).__timedJob({
        id: `other-${i}`,
        projectId: 'other-project',
        kind: 'referenceTranscription',
        status: 'succeeded',
        stage: 'done',
        progress: 1,
        logs: [],
        error: null,
      });
  });
  await expect(panel.locator('.current-job-progress')).toContainText('Conversion du timbre');
  await expect(panel.locator('.current-job-progress')).toContainText('Terminé');
  await expect(launch).toBeEnabled();
});
