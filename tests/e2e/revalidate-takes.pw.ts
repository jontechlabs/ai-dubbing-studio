import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
}
const project = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
const button = (page: Page) =>
  page.locator('.dialogue-card').first().locator('.translation-review button');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Valider cet essai existant ?' });
test('changed timing can be reviewed after cancellation; approval persists and preserves every take and cue', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).__setFirstSlot(3450));
  const before = await project(page);
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect(dialog(page)).toContainText('Le créneau de la réplique a changé.');
  await dialog(page).getByRole('button', { name: 'Annuler', exact: true }).click();
  expect((await project(page)).translationApprovals?.[before.dialogues[0].id]).toBeFalsy();
  await button(page).click();
  await dialog(page).screenshot({ path: 'docs/screenshots/revalidate-existing-take-fr.png' });
  await dialog(page).getByRole('button', { name: 'Valider l’essai tel quel', exact: true }).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  let after = await project(page);
  for (const key of ['generations', 'sourceCues', 'targetCues'])
    expect(after[key]).toEqual(before[key]);
  await page.reload();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await button(page).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.keyboard.press('Control+z');
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  after = await project(page);
  expect(after.generations).toEqual(before.generations);
});
test('changed text shows generated and current wording and a later correction revokes approval again', async ({
  page,
}) => {
  await ready(page);
  const before = await project(page);
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page
    .getByRole('textbox', { name: 'Sous-titre affiché', exact: true })
    .fill('Nouvelle traduction à vérifier.');
  await button(page).click();
  await expect(
    dialog(page).getByRole('textbox', { name: 'Texte de l’essai généré', exact: true }),
  ).toHaveValue(before.generations[0].text);
  await expect(
    dialog(page).getByRole('textbox', { name: 'Texte à prononcer actuellement', exact: true }),
  ).toHaveValue('Nouvelle traduction à vérifier.');
  await dialog(page).getByRole('button', { name: 'Valider l’essai tel quel', exact: true }).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('textbox', { name: 'Sous-titre affiché', exact: true })
    .fill('Encore une correction.');
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
  expect((await project(page)).generations).toEqual(before.generations);
});
test('a changed take during confirmation cannot be accepted accidentally', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__setFirstSlot(3450));
  await button(page).click();
  await page.evaluate(() => (window as any).__setFirstSlot(3500));
  await expect(dialog(page).getByRole('alert')).toContainText(
    'a changé pendant cette confirmation',
  );
  await expect(
    dialog(page).getByRole('button', { name: 'Valider l’essai tel quel', exact: true }),
  ).toBeDisabled();
  await dialog(page).getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'false');
});
test('the dubbing panel and V shortcut use the same review confirmation', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__setFirstSlot(3450));
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  await page
    .locator('.dub-navigation')
    .getByRole('button', { name: 'Essais', exact: true })
    .click();
  const validate = page
    .locator('.generation-review')
    .getByRole('button', { name: 'Valider', exact: true });
  await expect(validate).toBeEnabled();
  await validate.click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Annuler', exact: true }).click();
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.keyboard.press('v');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Valider l’essai tel quel', exact: true }).click();
  await expect(button(page)).toHaveAttribute('aria-pressed', 'true');
});
