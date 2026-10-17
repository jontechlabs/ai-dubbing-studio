import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('direct reference import auditions, edits, persists and reuses a file without a character', async ({page}) => {
  await nativeMock(page); await page.goto('/');
  const open = () => page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
  await open(); const panel=page.getByRole('dialog',{name:'Doublage'});
  await page.evaluate(()=>{(window as any).__dialogPath='C:/Audio/voix française.mp3';});
  await panel.getByRole('button',{name:'Charger un fichier de référence'}).click();
  await expect(panel.getByRole('combobox',{name:'Référence vocale',exact:true})).toHaveValue('file');
  await expect(panel.locator('audio')).toHaveAttribute('src',/\/audio\/.+\.wav/);
  await panel.locator('audio').evaluate(async(audio:HTMLAudioElement)=>{await audio.play();});
  await expect.poll(()=>panel.locator('audio').evaluate((audio:HTMLAudioElement)=>audio.currentTime)).toBeGreaterThan(0);
  await panel.locator('audio').evaluate((audio:HTMLAudioElement)=>{audio.pause();audio.currentTime=0;});
  await panel.getByRole('textbox',{name:'Texte réellement prononcé'}).fill('Bonjour, voici une référence française.');
  const accent=panel.getByRole('combobox',{name:'Accent souhaité (consigne)',exact:true});
  await accent.selectOption('fr-FR');
  await expect(panel.getByRole('combobox',{name:'Mode de clonage'})).toBeDisabled();
  await expect(panel.getByRole('button',{name:'Générer un nouvel essai'})).toBeEnabled();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await panel.getByRole('button',{name:'Charger un fichier de référence'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:'docs/screenshots/reference-file-accent.png'});
  await accent.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/voice-accent.png'});
  await page.reload();await open();await expect(accent).toHaveValue('fr-FR');
  await expect(panel.getByRole('textbox',{name:'Texte réellement prononcé'})).toHaveValue('Bonjour, voici une référence française.');
  await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();
  const request=await page.evaluate(()=>(window as any).__pendingTts);
  expect(request.options.referenceMode).toBe('file');expect(request.options.accent).toBe('fr-FR');expect(request.options.mode).toBe('crossLingual');
  await page.evaluate(()=>(window as any).__completeTts());await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.locator('.dialogue-card').nth(1).getByRole('button',{name:'Doubler',exact:true}).click();
  await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('file');
  await expect(panel.getByRole('textbox',{name:'Texte réellement prononcé'})).toHaveValue('Bonjour, voici une référence française.');
});

test('import cancellation and decode failure keep the previous reference selected',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Doublage'}),button=panel.getByRole('button',{name:'Charger un fichier de référence'});
  await button.click();await expect(panel.getByRole('combobox',{name:'Référence vocale',exact:true})).toHaveValue('file');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
  await page.evaluate(()=>{(window as any).__dialogPath=null;});await button.click();
  await expect(button).toBeEnabled();
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).voiceReferences).toEqual(before.voiceReferences);
  await page.evaluate(()=>{(window as any).__dialogPath='broken.mp3';(window as any).__referenceImportError=true;});await button.click();
  await expect(button).toBeEnabled();expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).voiceReferences).toEqual(before.voiceReferences);
});

test('Fish transcribes imported reference independently and Qwen disables accent selection',async({page})=>{
  await nativeMock(page);await page.goto('/');const open=()=>page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();await open();
  const panel=page.getByRole('dialog',{name:'Doublage'}),engine=panel.getByRole('combobox',{name:'Moteur et variante de voix'});
  await engine.selectOption('fish-s2-fp8');await panel.getByRole('button',{name:'Charger un fichier de référence'}).click();
  await expect(panel.getByRole('button',{name:'Générer un nouvel essai'})).toBeDisabled();
  await panel.getByRole('combobox',{name:'Langue de l’audio de référence'}).selectOption('ja');
  await panel.getByRole('button',{name:'Transcrire automatiquement',exact:true}).click();
  expect((await page.evaluate(()=>(window as any).__pendingTranscription)).characterId).toBeNull();
  await page.evaluate(()=>(window as any).__completeTranscription());await page.getByRole('button',{name:'Fermer',exact:true}).click();await open();
  await expect(panel.getByRole('textbox',{name:'Texte réellement prononcé'})).toHaveValue('彼の名前は坂本太郎です。');
  await expect(panel.getByRole('button',{name:'Générer un nouvel essai'})).toBeEnabled();
  const accent=panel.getByRole('combobox',{name:'Accent souhaité (consigne)',exact:true});await accent.selectOption('fr-CA');
  await engine.selectOption('qwen3-06b-gguf-q8');await expect(accent).toBeDisabled();await expect(accent).toHaveValue('auto');
});
