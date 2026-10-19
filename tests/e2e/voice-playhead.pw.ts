import { test, expect, type Page, type Locator } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function open(page: Page) {
  await nativeMock(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
  const editor = page.getByRole('region', { name: 'Édition du doublage', exact: true });
  await expect(editor.locator('.voice-wave-loading')).toHaveCount(0);
  return editor;
}
async function range(editor: Locator, start: number, end: number) {
  await editor.getByRole('spinbutton', { name: 'Début de la sélection (ms)', exact: true }).fill(String(start));
  await editor.getByRole('spinbutton', { name: 'Fin de la sélection (ms)', exact: true }).fill(String(end));
}
const position = (editor: Locator) => editor.locator('.voice-wave-playhead').getAttribute('data-position-ms').then(Number);
const saved = (page: Page) => expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');

test('selection audition follows the audio clock, freezes on stop and places the edit cursor precisely', async ({ page }) => {
  const editor = await open(page); await range(editor, 500, 1700);
  await editor.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(() => position(editor)).toBeGreaterThan(650);
  expect(await position(editor)).toBeLessThan(1700);
  await editor.getByRole('button', { name: 'Arrêter l’écoute', exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const stopped = await position(editor);
  await expect(editor.getByLabel('Position de lecture du doublage', { exact: true })).toContainText(`${(stopped / 1000).toFixed(3)} / 2.000 s`);
  // The stopped marker must remain stable across several display frames.
  await page.waitForTimeout(150); expect(await position(editor)).toBe(stopped);
  await editor.getByRole('button', { name: 'Placer le curseur ici', exact: true }).click();
  await expect(editor.getByRole('spinbutton', { name: 'Début de la sélection (ms)', exact: true })).toHaveValue(String(stopped));
  await expect(editor.getByRole('spinbutton', { name: 'Fin de la sélection (ms)', exact: true })).toHaveValue(String(stopped));
  await page.screenshot({ path: 'docs/screenshots/voice-playhead-fr.png' });
});

test('natural selection end stops at its exact boundary and closing cancels an active audition', async ({ page }) => {
  const editor = await open(page); await range(editor, 650, 950);
  await editor.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(() => position(editor)).toBe(950);
  await expect(editor.getByRole('button', { name: 'Écouter la sélection', exact: true })).toBeVisible();
  await range(editor, 0, 2000);
  await editor.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(() => position(editor)).toBeGreaterThan(50);
  await editor.getByRole('button', { name: 'Fermer l’éditeur du doublage', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
  await expect(editor.getByRole('button', { name: 'Écouter la sélection', exact: true })).toBeVisible();
  const stopped = await position(editor); await page.waitForTimeout(100); expect(await position(editor)).toBe(stopped);
});

test('original audition identifies deleted audio rather than placing a misleading marker', async ({ page }) => {
  const editor = await open(page); await range(editor, 300, 1100);
  await editor.getByRole('button', { name: 'Supprimer et rapprocher', exact: true }).click(); await saved(page);
  await editor.getByRole('button', { name: 'Écouter l’essai d’origine', exact: true }).click();
  await expect(editor.getByLabel('Position de lecture du doublage', { exact: true })).toContainText('Passage supprimé de l’édition');
  await expect(editor.locator('.voice-wave-playhead')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Placer le curseur ici', exact: true })).toBeDisabled();
  await expect.poll(() => position(editor)).toBeGreaterThan(350);
  await editor.getByRole('button', { name: 'Arrêter l’écoute', exact: true }).click();
  expect(await position(editor)).toBeLessThan(1200);
  await expect(editor.getByLabel('Position de lecture du doublage', { exact: true })).toContainText('Original');
});

test('the dialogue audition and video seeking both drive the same edited waveform clock', async ({ page }) => {
  const editor = await open(page);
  await page.locator('.dialogue-card').first().getByTitle('Écouter le doublage sélectionné', { exact: true }).click();
  await expect.poll(() => position(editor)).toBeGreaterThan(150);
  // The mock WAV is four seconds while the displayed fitted clip is two.
  // Moving the video while paused must return to its own clip clock.
  await page.locator('.dialogue-card').first().getByTitle('Écouter le doublage sélectionné', { exact: true }).click();
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('nativeMockProject')!);
    const v = document.querySelector('video')!; v.currentTime = (p.dialogues[0].startMs + 900) / 1000;
  });
  await expect.poll(() => position(editor)).toBe(900);
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect.poll(() => position(editor)).toBeGreaterThan(1000);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});
