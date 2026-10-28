import {test,expect} from '@playwright/test';
import {nativeMock} from './nativeMock';

test('CosyVoice installation defaults to CUDA, exposes measured devices and distinguishes future variants',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Modèles',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:/Installer CUDA 12.8/})).toBeChecked();await expect(page.getByText('NVIDIA RTX 5060 Ti',{exact:false})).toBeVisible();
  await expect(page.getByText('CosyVoice3 0.5B RL',{exact:true}).first()).toBeVisible();await page.screenshot({path:'docs/screenshots/cosyvoice-model.png'});
  await page.getByRole('button',{name:'Vérifier / réparer CosyVoice3'}).click();await expect(page.getByRole('dialog',{name:'Traitements'})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__calls.find((c:any)=>c.command==='install_tts_runtime').args.cuda)).toBe(true);
  await page.getByRole('button',{name:'Annuler',exact:true}).click();await expect(page.getByText('Annulé',{exact:true})).toBeVisible();
});

test('generates independent takes on selected RTX, reviews, compares and persists the chosen take',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await nativeMock(page);await page.goto('/');
  await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Doublage'});await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');await panel.getByRole('combobox',{name:'Périphérique de génération'}).selectOption('cuda:0');
  await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();await expect(panel.locator('.current-job-progress')).toContainText('Génération de la voix');await page.evaluate(()=>(window as any).__completeTts());await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();await expect(panel.locator('.generation-card')).toHaveCount(1);await panel.getByRole('button',{name:'Valider',exact:true}).click();await expect(panel.getByText('Validé',{exact:true})).toBeVisible();
  await panel.getByRole('spinbutton',{name:'Graine',exact:true}).fill('8');await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();await page.evaluate(()=>(window as any).__completeTts(4000));await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  await expect(panel.locator('.generation-card')).toHaveCount(2);await expect(panel.getByText(/Cet essai original dépasse le créneau/)).toBeVisible();await expect(panel.getByText('Comparaison A/B',{exact:true})).toBeVisible();
  await panel.locator('.generation-card').last().getByRole('button',{name:'Choisir',exact:true}).click();await panel.getByRole('button',{name:'Valider',exact:true}).click();await page.screenshot({path:'docs/screenshots/dubbing-line.png'});
  await panel.locator('.generation-card').last().getByRole('button',{name:'Écouter',exact:true}).click();await expect(panel.getByRole('button',{name:'Arrêter l’écoute du doublage'})).toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='generation_path'))).toBe(true);
  await panel.locator('.generation-card').last().getByRole('button',{name:'WAV',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='export_generation'))).toBe(true);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();await expect(panel.locator('.generation-card.selected').getByText(/Essai 1/)).toBeVisible();await expect(panel.locator('.generation-card')).toHaveCount(2);
  const calls=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.command==='replace_project'));expect(calls.at(-1)?.args.project.formatVersion??5).toBe(5);expect(errors).toEqual([]);
});

test('missing references block generation and an edited line cannot validate its old take',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();const panel=page.getByRole('dialog',{name:'Doublage'});
  await expect(panel.getByRole('button',{name:'Générer un nouvel essai'})).toBeDisabled();await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();await page.evaluate(()=>(window as any).__completeTts());await page.getByRole('button',{name:'Fermer',exact:true}).click();
  await page.getByRole('textbox',{name:'Sous-titre affiché',exact:true}).fill('Un texte corrigé après génération.');await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();await expect(panel.getByText(/ont changé depuis cet essai/)).toBeVisible();await expect(panel.getByRole('button',{name:'Valider',exact:true})).toBeDisabled();
  await panel.getByRole('button',{name:'Retirer l’essai 1'}).click();await expect(panel.locator('.generation-card')).toHaveCount(0);await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
});
