import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('saved Fish cross-language settings show the exact-transcript help and preserve CUDA generation', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedReference());
  await page.locator('.dialogue-card').first().getByRole('button', {name:'Doubler',exact:true}).click();
  const panel = page.getByRole('dialog', {name:'Doublage'});
  await expect(panel.getByRole('combobox', {name:'Mode de clonage'})).toHaveValue('zeroShot');
  await expect(panel.getByText(/Fish exige un audio de référence/)).toBeVisible();
  await expect(panel.getByText(/Aucune transcription de la référence/)).toHaveCount(0);
  await expect(panel.getByRole('button', {name:'Générer un nouvel essai'})).toBeDisabled();
  await panel.getByRole('combobox', {name:'Langue de l’audio de référence'}).selectOption('ja');
  await panel.getByRole('button', {name:'Transcrire automatiquement',exact:true}).click();
  await expect(panel.locator('.current-job-progress')).toContainText('Transcription de la référence vocale');await expect(page.getByRole('dialog',{name:'Traitements',exact:true})).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__pendingTranscription)).toEqual({characterId:'speaker-ja',referenceId:'reference-ja',language:'ja'});
  await page.evaluate(() => (window as any).__completeTranscription());
  await expect(panel.getByRole('textbox', {name:'Texte réellement prononcé'})).toHaveValue('彼の名前は坂本太郎です。');
  await expect(panel.getByRole('button', {name:'Générer un nouvel essai'})).toBeEnabled();
  await panel.getByRole('button', {name:'Générer un nouvel essai'}).click();
  const pending = await page.evaluate(() => (window as any).__pendingTts);
  expect(pending.options.mode).toBe('zeroShot'); expect(pending.options.device).toBe('cuda:0');
});

test('character references transcribe in their own language, stay editable and persist after reload', async ({page}) => {
  await nativeMock(page); await page.goto('/'); await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedReference());
  await page.getByRole('button', {name:'Personnages',exact:true}).click();
  const panel = page.getByRole('dialog', {name:'Personnages'});
  await expect(panel.getByRole('combobox', {name:'Langue de l’audio de référence'})).toHaveValue('auto');
  await panel.getByRole('button', {name:'Transcrire automatiquement',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__pendingTranscription.language)).toBe('auto');
  await page.evaluate(() => (window as any).__completeTranscription());
  await page.getByRole('button', {name:'Fermer',exact:true}).click();
  await page.getByRole('button', {name:'Personnages',exact:true}).click();
  const transcript = panel.getByRole('textbox', {name:'Texte réellement prononcé Japanese voice'});
  await expect(transcript).toHaveValue('彼の名前は坂本太郎です。');
  await transcript.fill('彼の名前は坂本です。'); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await panel.locator('.panel-body').evaluate((element) => { element.scrollTop = element.scrollHeight; }); await page.screenshot({path:'docs/screenshots/reference-transcription.png'});
  await page.reload(); await page.getByRole('button', {name:'Personnages',exact:true}).click();
  await expect(transcript).toHaveValue('彼の名前は坂本です。');
});

test('custom reference selection is respected and cancellation or failure preserves its previous text', async ({page}) => {
  await nativeMock(page); await page.goto('/'); await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedReference('日本語の参照です。',true));
  const open = async () => page.locator('.dialogue-card').first().getByRole('button', {name:'Doubler',exact:true}).click();
  await open(); const panel=page.getByRole('dialog', {name:'Doublage'});
  await panel.getByRole('button', {name:'Transcrire automatiquement',exact:true}).click();
  expect(await page.evaluate(() => (window as any).__pendingTranscription.referenceId)).toBe('reference-custom');
  await panel.locator('.current-job-progress').getByRole('button', {name:'Annuler',exact:true}).click();
  await page.evaluate(() => (window as any).__completeTranscription('Texte à ignorer'));
  await expect(panel.getByRole('textbox', {name:'Texte réellement prononcé'})).toHaveValue('日本語の参照です。');
  await panel.getByRole('button', {name:'Transcrire automatiquement',exact:true}).click(); await page.evaluate(() => (window as any).__failTranscription());
  await expect(panel.locator('.current-job-progress').getByRole('button', {name:'Réessayer',exact:true})).toBeVisible();
  await expect(panel.getByRole('textbox', {name:'Texte réellement prononcé'})).toHaveValue('日本語の参照です。');
});
