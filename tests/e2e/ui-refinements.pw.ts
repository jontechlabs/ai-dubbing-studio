import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';
const project = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
}
async function dub(page: Page) {
  await ready(page);
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Ajouter un doublage', exact: true }).click();
  return page.getByRole('region', { name: 'Doublage', exact: true });
}

test('dubbing text and generation remain easy to reach, with auxiliary tools below settings and inline completion focused', async ({
  page,
}) => {
  const panel = await dub(page),
    before = await project(page);
  await expect(panel.locator('.dub-tools')).not.toBeInViewport();
  await expect(
    panel.getByRole('textbox', { name: 'Texte qui sera prononcé', exact: true }),
  ).toBeInViewport();
  await expect(
    panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }),
  ).toBeInViewport();
  await panel
    .getByRole('textbox', { name: 'Texte qui sera prononcé', exact: true })
    .fill('Une voix française plus expressive.');
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await panel.getByRole('button', { name: 'Outils', exact: true }).click();
  await expect(panel.locator('.dub-tools')).toBeInViewport();
  await expect(
    panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }),
  ).toBeInViewport();
  await panel.getByRole('button', { name: 'Texte', exact: true }).click();
  await expect(
    panel.getByRole('textbox', { name: 'Texte qui sera prononcé', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: 'test-results/screenshots/ui-dubbing-compact-fr.png' });
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  await expect(panel.locator('.current-job-progress')).toBeInViewport();
  const nav = (await panel.locator('.dub-navigation').boundingBox())!,
    progress = (await panel.locator('.dub-task-progress').boundingBox())!;
  expect(progress.y).toBeGreaterThanOrEqual(nav.y + nav.height - 1);
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
  await page.evaluate(() => (window as any).__completeTts());
  await expect(panel.locator('.generation-card')).toHaveCount(2);
  await expect(panel.locator('.generation-card.selected')).toBeFocused();
  expect((await project(page)).generations.slice(0, before.generations.length)).toEqual(
    before.generations,
  );
});

for (const width of [1280, 1024])
  test(`voice editing stays within its dock and keeps tracks visible at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await ready(page);
    await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
    const editor = page.getByRole('region', { name: 'Édition du doublage', exact: true });
    await expect(editor.locator('.voice-wave-loading')).toHaveCount(0);
    const box = (await editor.boundingBox())!,
      tracks = (await page.locator('.timeline-body').boundingBox())!;
    expect(box.height).toBeLessThanOrEqual(215);
    expect(tracks.height).toBeGreaterThanOrEqual(60);
    for (const button of await editor.locator('.voice-edit-controls > button').all()) {
      await expect(button).toHaveAttribute('aria-label', /.+/);
      await expect(button).toHaveAttribute('title', /.+/);
      await expect(button).toBeInViewport();
    }
    expect(await editor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/screenshots/ui-voice-dock-${width}-fr.png` });
  });

test('fade and effect dialogs preserve the selection and keep changes undoable', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
  const editor = page.getByRole('region', { name: 'Édition du doublage', exact: true }),
    before = await project(page);
  await editor
    .getByRole('spinbutton', { name: 'Début de la sélection (ms)', exact: true })
    .fill('400');
  await editor
    .getByRole('spinbutton', { name: 'Fin de la sélection (ms)', exact: true })
    .fill('900');
  await editor.getByRole('button', { name: 'Fondus', exact: true }).click();
  const fades = page.getByRole('dialog', { name: 'Fondus', exact: true });
  await fades.getByRole('spinbutton', { name: 'Fondu d’entrée (ms)', exact: true }).fill('100');
  await fades.getByRole('button', { name: 'Appliquer les fondus', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.keyboard.press('Escape');
  await expect(fades).toHaveCount(0);
  await expect(
    editor.getByRole('spinbutton', { name: 'Début de la sélection (ms)', exact: true }),
  ).toHaveValue('400');
  await editor.getByRole('button', { name: 'Effets audio', exact: true }).click();
  const effects = page.getByRole('dialog', { name: 'Effets audio', exact: true });
  await expect(
    effects.getByRole('combobox', { name: 'Effet à ajouter', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(effects).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await project(page)).voiceEdits).toEqual(before.voiceEdits);
  expect((await project(page)).generations).toEqual(before.generations);
});

test('characters are visible before advanced analysis and compact controls retain their accessible names', async ({
  page,
}) => {
  let p = addCharacter(demoProject(), 'Adèle');
  p = addCharacter(p, 'Malik');
  p.formatVersion = 26;
  p.dialogues[0].characterId = p.characters[0].id;
  p.dialogues[1].characterId = p.characters[1].id;
  await nativeMock(page, false, p);
  await page.goto('/');
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Personnages', exact: true });
  await expect(panel.locator('.character-analysis')).not.toHaveAttribute('open');
  await expect(
    panel.getByRole('list', { name: 'Galerie des personnages', exact: true }),
  ).toBeInViewport();
  await panel
    .getByRole('combobox', { name: 'Personnage', exact: true })
    .selectOption(p.characters[1].id);
  await expect(
    panel.getByRole('textbox', { name: 'Renommer le personnage', exact: true }),
  ).toHaveValue('Malik');
  await expect(
    panel.getByRole('button', { name: 'Remettre les locuteurs à zéro', exact: true }),
  ).toHaveAttribute('title', 'Remettre les locuteurs à zéro');
  await page.screenshot({ path: 'test-results/screenshots/ui-characters-compact-fr.png' });
});
