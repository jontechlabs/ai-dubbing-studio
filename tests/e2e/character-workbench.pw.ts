import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';
import type { Page } from '@playwright/test';

function fixture() {
  const p = addCharacter(addCharacter(demoProject(), 'Personnage 01'), 'Personnage 02'); p.formatVersion = 20;
  p.characters.forEach((c, i) => { c.id = `character-${i}`; c.references = [{ id: `ref-${i}`, label: `Voix ${i + 1}`, path: `characters/ref-${i}.wav`, durationMs: 4000, transcript: 'Une voix de référence.' }]; c.defaultReferenceId = `ref-${i}`; p.dialogues[i].characterId = c.id; });
  p.characterProfiles = Object.fromEntries(p.characters.map((c) => [c.id, { temporaryName: true, portrait: { path: `characters/${c.id}.png`, sourcePath: p.media!.path, lineId: p.dialogues[0].id, atMs: 1000, crop: { x: 0, y: 0, width: 1, height: 1 }, differenceHash: '0000ffff0000ffff', colors: Array(48).fill(1 / 16), confirmed: false }, vocalRegister: { medianHz: 180, confidence: .9, analyzedMs: 2000 } }]));
  for (const role of ['speech', 'music', 'sfx'] as const) p.tracks.push({ id: role, kind: 'audio', role, path: `stems/${role}.wav`, durationMs: p.media!.durationMs, sourcePath: p.media!.path, language: 'ja', mute: false, solo: false, gain: 1 });
  return p;
}
const saved = (page: Page) => page.evaluate(async () => JSON.parse(localStorage.getItem('nativeMockProject') || 'null') ?? await (window as any).__TAURI_INTERNALS__.invoke('restore_project'));
async function ready(page: Page) {
  await nativeMock(page, false, fixture());
  await page.route('**/*character-*.png', (route) => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#36304a"/><circle cx="128" cy="90" r="44" fill="#b6a4d6"/><path d="M45 245v-35a83 83 0 0 1 166 0v35" fill="#b6a4d6"/></svg>' }));
  await page.goto('/'); await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
test('gallery proposes similar thumbnails, manual gender, sample playback and lossless merge with undo', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await expect(page.locator('.character-gallery .character-card')).toHaveCount(2); await expect(page.locator('.character-group-label')).toContainText('2');
  await page.getByRole('combobox', { name: 'Genre · saisie manuelle' }).selectOption('man');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé'); expect((await saved(page)).characterProfiles['character-0'].gender).toBe('man');
  await page.locator('.character-samples button').filter({ hasText: 'Écouter' }).first().click(); await expect(page.locator('.character-samples audio')).toHaveAttribute('src', /preview/);
  await page.getByRole('checkbox', { name: 'Sélectionner Personnage 01 pour fusionner' }).check(); await page.getByRole('checkbox', { name: 'Sélectionner Personnage 02 pour fusionner' }).check();
  await page.locator('.character-gallery').scrollIntoViewIfNeeded(); await expect.poll(() => page.locator('.character-gallery img').evaluateAll((rows: HTMLImageElement[]) => rows.every((im) => im.complete && im.naturalWidth > 0))).toBe(true); await page.screenshot({ path: 'test-results/screenshots/character-workbench.png' });
  const before = await saved(page); await page.getByRole('button', { name: 'Fusionner les fiches', exact: true }).click(); await expect(page.locator('.character-gallery .character-card')).toHaveCount(1); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  let after = await saved(page); expect(after.characters[0].references).toHaveLength(2); expect(after.dialogues.slice(0, 2).map((l: any) => l.characterId)).toEqual(['character-0', 'character-0']); expect(after.generations).toEqual(before.generations);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click(); await page.keyboard.press('Control+z'); await expect.poll(async () => (await saved(page)).characters.length).toBe(2);
});
test('merge trims and joins selected references as one new default while retaining originals', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  for (const name of ['Personnage 01', 'Personnage 02']) await page.getByRole('checkbox', { name: `Sélectionner ${name} pour fusionner` }).check();
  for (let i = 0; i < 2; i++) await page.getByRole('checkbox', { name: `Utiliser Voix ${i + 1} de Personnage 0${i + 1}` }).check();
  await page.getByRole('spinbutton', { name: 'Début de référence (s) ref-0', exact: true }).fill('1');
  await page.getByRole('button', { name: 'Fusionner et créer la référence' }).click(); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await expect.poll(async () => (await saved(page)).characters.length).toBe(1); const p = await saved(page);
  expect(p.characters[0].references).toHaveLength(3); expect(p.characters[0].references[2].durationMs).toBe(7000); expect(p.characters[0].references[2].transcript).toBe('');
  expect(await page.evaluate(() => (window as any).__calls.find((c: any) => c.command === 'prepare_character_reference').args.segments[0])).toMatchObject({ startMs: 1000, endMs: 4000 });
});
test('bounded guided identification preserves assignments until explicit replacement is chosen', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page.getByRole('combobox', { name: 'Zone à analyser' }).selectOption('range');
  await page.getByRole('spinbutton', { name: 'Début de l’analyse (s)' }).fill('0'); await page.getByRole('spinbutton', { name: 'Fin de l’analyse (s)' }).fill('4');
  await page.getByRole('combobox', { name: 'Référence pour retrouver un personnage (facultatif)' }).selectOption('character-1');
  await page.getByRole('combobox', { name: 'Piste pour identifier les voix' }).selectOption('music');
  await page.getByRole('button', { name: 'Identifier les locuteurs par IA', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__pendingSpeakerScope)).toMatchObject({ startMs: 0, endMs: 4000, trackId: 'music', referenceCharacterId: 'character-1', replaceAssigned: false });
  await page.evaluate(() => (window as any).__completeSpeakerAnalysis()); await page.getByRole('button', { name: 'Fermer', exact: true }).click(); await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page.getByRole('button', { name: 'Créer les personnages et assigner les répliques' }).click(); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await saved(page)).dialogues[0].characterId).toBe('character-0'); expect((await saved(page)).characters).toHaveLength(2);
});
test('local separation is previewed before application and can guide identification on the corrected Speech stem', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const panel = page.locator('.local-separation'); await panel.getByRole('combobox', { name: 'Piste à séparer localement' }).selectOption('music');
  await panel.getByRole('spinbutton', { name: 'Début de séparation locale (s)' }).fill('1'); await panel.getByRole('spinbutton', { name: 'Fin de séparation locale (s)' }).fill('3');
  const before = await saved(page); await panel.getByRole('button', { name: 'Séparer et préparer une préécoute' }).click(); await page.evaluate(() => (window as any).__completeLocalSeparation());
  await page.getByRole('button', { name: 'Fermer', exact: true }).click(); await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await expect(panel.locator('audio')).toHaveCount(3); expect((await saved(page)).generations).toEqual(before.generations);
  await page.screenshot({ path: 'test-results/screenshots/local-separation-review.png' });
  await panel.getByRole('button', { name: 'Appliquer ces trois résultats' }).click(); await expect(panel.getByRole('button', { name: 'Réidentifier les voix de cette zone' })).toBeVisible();
  const p = await saved(page), patches = p.generations.filter((g: any) => g.operation === 'separation'); expect(patches).toHaveLength(3); expect(patches.map((g: any) => [g.trackId, g.mode])).toEqual([['speech', 'add'], ['music', 'replace'], ['sfx', 'add']]); expect(p.media).toEqual(before.media);
  await panel.getByRole('combobox', { name: 'Référence pour réidentifier après séparation' }).selectOption('character-0'); await panel.getByRole('button', { name: 'Réidentifier les voix de cette zone' }).click();
  expect(await page.evaluate(() => (window as any).__pendingSpeakerScope)).toMatchObject({ startMs: 1000, endMs: 3000, trackId: 'speech', referenceCharacterId: 'character-0' });
});
