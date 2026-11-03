import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';

function fixture() {
  let p = demoProject();
  for (const name of ['Speaker A', 'Speaker B', 'Sans réplique']) p = addCharacter(p, name);
  p.characters.forEach((character, i) => {
    character.id = `character-${i}`;
  });
  p.dialogues[0].characterId = 'character-0';
  p.dialogues[1].characterId = 'character-1';
  p.dialogues[2].characterId = 'character-0';
  return p;
}
async function ready(page: Page) {
  const p = fixture();
  await nativeMock(page, false, p);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.locator('.dialogue-card').first().click();
  return p;
}
const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject') || 'null'));
async function openPortraits(page: Page) {
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page
    .locator('.character-metadata summary')
    .filter({ hasText: 'Choisir ou recadrer' })
    .click();
}
async function capture(page: Page) {
  await page.locator('.character-metadata input[type="checkbox"]').uncheck();
  await page.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
}

test('switching speaker captures its own dialogue while the editor selection stays on another speaker', async ({
  page,
}) => {
  const p = await ready(page);
  await openPortraits(page);
  await expect(page.getByRole('combobox', { name: 'Réplique pour la vignette' })).toHaveValue(
    p.dialogues[0].id,
  );
  await capture(page);
  const first = (await saved(page)).characterProfiles['character-0'].portrait;
  await page.getByRole('combobox', { name: 'Personnage', exact: true }).selectOption('character-1');
  await page
    .locator('.character-metadata summary')
    .filter({ hasText: 'Choisir ou recadrer' })
    .click();
  await expect(page.getByRole('combobox', { name: 'Réplique pour la vignette' })).toHaveValue(
    p.dialogues[1].id,
  );
  await capture(page);
  const after = await saved(page);
  expect(after.characterProfiles['character-1'].portrait.lineId).toBe(p.dialogues[1].id);
  expect(after.characterProfiles['character-0'].portrait).toEqual(first);
  expect(after.dialogues).toEqual(p.dialogues);
  expect(after.generations).toEqual(p.generations);
  const requests = await page.evaluate(() =>
    (window as any).__calls
      .filter((c: any) => c.command === 'capture_character_portrait')
      .map((c: any) => c.args.options),
  );
  expect(requests).toMatchObject([
    { characterId: 'character-0', lineId: p.dialogues[0].id },
    { characterId: 'character-1', lineId: p.dialogues[1].id },
  ]);
});

test('a custom video time is cleared when changing the portrait dialogue', async ({ page }) => {
  const p = await ready(page);
  await openPortraits(page);
  const time = page.getByRole('spinbutton', { name: 'Position vidéo (s, facultatif)' });
  await time.fill('1.25');
  await capture(page);
  expect((await saved(page)).characterProfiles['character-0'].portrait.atMs).toBe(1250);
  await page
    .getByRole('combobox', { name: 'Réplique pour la vignette' })
    .selectOption(p.dialogues[2].id);
  await expect(time).toHaveValue('');
  await capture(page);
  const request = await page.evaluate(
    () =>
      (window as any).__calls.filter((c: any) => c.command === 'capture_character_portrait').at(-1)
        .args.options,
  );
  expect(request).toMatchObject({ characterId: 'character-0', lineId: p.dialogues[2].id });
  expect(request).not.toHaveProperty('atMs');
});

test('an unassigned speaker requires an explicit dialogue choice instead of copying the editor selection', async ({
  page,
}) => {
  const p = await ready(page);
  await openPortraits(page);
  await page.getByRole('combobox', { name: 'Personnage', exact: true }).selectOption('character-2');
  await page
    .locator('.character-metadata summary')
    .filter({ hasText: 'Choisir ou recadrer' })
    .click();
  const line = page.getByRole('combobox', { name: 'Réplique pour la vignette' });
  await expect(line).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Capturer la vignette', exact: true }),
  ).toBeDisabled();
  await line.selectOption(p.dialogues[0].id);
  await capture(page);
  expect((await saved(page)).characterProfiles['character-2'].portrait.lineId).toBe(
    p.dialogues[0].id,
  );
});

test('a selected dialogue belonging to the character is preferred to its first dialogue', async ({
  page,
}) => {
  const p = await ready(page);
  await page.locator('.dialogue-card').nth(2).click();
  await openPortraits(page);
  await expect(page.getByRole('combobox', { name: 'Réplique pour la vignette' })).toHaveValue(
    p.dialogues[2].id,
  );
});
