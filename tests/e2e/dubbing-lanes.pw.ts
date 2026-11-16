import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function setup(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__seedDubbing();
  });
}
test('assigns simultaneous independent dialogues to distinct tracks with persistent per-track controls', async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject();
    p.dialogues[1].startMs = p.dialogues[0].startMs;
    p.dialogues[1].endMs = p.dialogues[0].endMs;
    w.__loadMockProject(p);
  });
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.getByRole('button', { name: 'Pistes de doublage', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Pistes de doublage', exact: true });
  await modal.getByRole('button', { name: 'Ajouter une piste de doublage', exact: true }).click();
  await modal
    .getByRole('combobox', { name: 'Dialogue à affecter', exact: true })
    .selectOption(before.dialogues[1].id);
  const laneId = await modal
    .getByRole('combobox', { name: 'Piste de doublage', exact: true })
    .locator('option')
    .nth(1)
    .getAttribute('value');
  await modal
    .getByRole('combobox', { name: 'Piste de doublage', exact: true })
    .selectOption(laneId!);
  await modal
    .getByRole('textbox', { name: 'Nom de la piste 2', exact: true })
    .fill('Voix secondaire');
  await modal.getByRole('textbox', { name: 'Nom de la piste 2', exact: true }).press('Enter');
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  const first = page.locator('[data-track-id="dubbing-lane:main"] .dubbing-block').first(),
    second = page.locator(`[data-track-id="dubbing-lane:${laneId}"] .dubbing-block`);
  await expect(first).toBeVisible();
  await expect(second).toHaveCount(1);
  await expect(second).toBeVisible();
  expect((await first.boundingBox())!.x).toBe((await second.boundingBox())!.x);
  expect((await second.boundingBox())!.y).toBeGreaterThan((await first.boundingBox())!.y);
  await page
    .getByRole('spinbutton', { name: 'Volume Voix secondaire (%)', exact: true })
    .fill('175');
  await page.getByRole('button', { name: 'Couper Voix secondaire', exact: false }).click();
  await expect
    .poll(async () => {
      const p = await page.evaluate(() => (window as any).__getMockProject());
      return p.dubbingLanes?.lanes[1];
    })
    .toMatchObject({ gain: 1.75, mute: true, name: 'Voix secondaire' });
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations).toEqual(before.generations);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  await page.screenshot({ path: 'docs/screenshots/dubbing-lanes-fr.png' });
  await page.reload();
  await expect(page.locator(`[data-track-id="dubbing-lane:${laneId}"] .dubbing-block`)).toHaveCount(
    1,
  );
  await expect(page.getByRole('button', { name: /Activer.*Voix secondaire/ })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});
test('clip context menu creates a new track and track removal keeps every take', async ({
  page,
}) => {
  await setup(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.locator('.dubbing-block').first().click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Nouvelle piste et y déplacer ce dialogue', exact: true })
    .click();
  await expect(page.locator('[data-track-id^="dubbing-lane:"]')).toHaveCount(2);
  await page.getByRole('button', { name: 'Pistes de doublage', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Pistes de doublage', exact: true });
  await modal.getByRole('button', { name: 'Supprimer Doublage 2', exact: true }).click();
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('[data-track-id^="dubbing-lane:"]')).toHaveCount(1);
  await expect
    .poll(async () => {
      const p = await page.evaluate(() => (window as any).__getMockProject());
      return p.dubbingLanes?.assignments;
    })
    .toEqual({});
  expect((await page.evaluate(() => (window as any).__getMockProject())).generations).toEqual(
    before.generations,
  );
});
