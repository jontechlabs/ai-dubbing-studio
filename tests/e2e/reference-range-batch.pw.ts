import {test,expect} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function openDub(page:any){await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();return page.getByRole('dialog',{name:'Doublage',exact:true});}

test('reference excerpt can start after twenty seconds, previews only its range and imports exact bounds',async({page})=>{
  await nativeMock(page);await page.goto('/');const panel=await openDub(page);
  await panel.getByRole('button',{name:'Charger un fichier de référence'}).click();
  const start=panel.getByRole('spinbutton',{name:'Début de l’extrait (s)'}),end=panel.getByRole('spinbutton',{name:'Fin de l’extrait (s)'}),use=panel.getByRole('button',{name:'Utiliser cet extrait',exact:true});
  await expect(panel.getByRole('button',{name:'Début à la position du lecteur'})).toBeEnabled();
  await panel.getByRole('button',{name:'Charger un fichier de référence'}).click();
  await expect(panel.getByRole('button',{name:'Début à la position du lecteur'})).toBeEnabled();
  await start.fill('21.25');await end.fill('44');await expect(use).toBeDisabled();await end.fill('80');await expect(use).toBeDisabled();await end.fill('23.75');await expect(use).toBeEnabled();
  await panel.getByRole('button',{name:'Écouter cet extrait',exact:true}).click();
  const audio=panel.locator('audio');await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(21.25);
  await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);expect(await audio.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeLessThan(24.25);
  await start.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/reference-range.png'});
  await use.click();await expect(panel.getByRole('combobox',{name:'Référence vocale',exact:true})).toHaveValue('file');
  const call=await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.command==='import_dubbing_reference').at(-1));expect(call.args.range).toEqual({startMs:21250,endMs:23750});
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).voiceReferences[0].durationMs).toBe(2500);
});

test('player markers choose a character reference excerpt and cancelling does not create another reference',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();await page.evaluate(()=>(window as any).__seedReference('日本語'));
  await page.getByRole('button',{name:'Personnages',exact:true}).click();const panel=page.getByRole('dialog',{name:'Personnages',exact:true});
  await panel.getByRole('button',{name:'Importer un audio',exact:true}).click();
  const audio=panel.locator('audio[aria-label="Écouter le fichier source de référence"]');
  await expect(panel.getByRole('button',{name:'Début à la position du lecteur'})).toBeEnabled();
  await audio.evaluate((a:HTMLAudioElement)=>{a.currentTime=29;});await panel.getByRole('button',{name:'Début à la position du lecteur'}).click();
  await audio.evaluate((a:HTMLAudioElement)=>{a.currentTime=33;});await panel.getByRole('button',{name:'Fin à la position du lecteur'}).click();
  await expect(panel.getByRole('spinbutton',{name:'Début de l’extrait (s)'})).toHaveValue('29');await expect(panel.getByRole('spinbutton',{name:'Fin de l’extrait (s)'})).toHaveValue('33');
  await panel.getByRole('button',{name:'Utiliser cet extrait',exact:true}).click();
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).characters[0].references.at(-1).durationMs).toBe(4000);
  await panel.getByRole('button',{name:'Importer un audio',exact:true}).click();await panel.getByRole('button',{name:'Annuler',exact:true}).click();
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).characters[0].references).toHaveLength(2);
});

test('shift checked selection excludes missing translations and dispatches a common batch configuration',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();await page.evaluate(()=>(window as any).__clearTranslation(1));
  await page.getByRole('checkbox',{name:'Cocher la réplique 1 pour le lot',exact:true}).click();await page.getByRole('checkbox',{name:'Cocher la réplique 3 pour le lot',exact:true}).click({modifiers:['Shift']});
  await expect(page.getByRole('checkbox',{name:'Cocher la réplique 2 pour le lot',exact:true})).toBeChecked();
  await page.getByRole('button',{name:/Doublage par lot/}).click();const panel=page.getByRole('dialog',{name:'Doublage par lot',exact:true});
  await expect(panel.getByRole('combobox',{name:'Répliques à doubler'})).toHaveValue('selected');
  await panel.getByRole('button',{name:'Charger un fichier de référence'}).click();await panel.getByRole('spinbutton',{name:'Début de l’extrait (s)'}).fill('30');await panel.getByRole('spinbutton',{name:'Fin de l’extrait (s)'}).fill('38');await panel.getByRole('button',{name:'Utiliser cet extrait'}).click();
  await panel.getByRole('combobox',{name:'Périphérique de génération'}).selectOption('cuda:0');await panel.getByRole('combobox',{name:'Humeur / interprétation'}).selectOption('calm');await panel.getByRole('combobox',{name:'Accent souhaité (consigne)'}).selectOption('fr-FR');
  await panel.getByRole('spinbutton',{name:'Graine'}).fill('42');await panel.getByRole('slider',{name:/^Vitesse/}).focus();await panel.getByRole('slider',{name:/^Vitesse/}).press('ArrowRight');
  await expect(panel.getByText(/2 à générer · 0 déjà doublées · 1 sans traduction/)).toBeVisible();
  await panel.getByRole('button',{name:'Doubler 2 répliques',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/batch-configuration.png'});
  await panel.getByRole('button',{name:'Doubler 2 répliques',exact:true}).click();const selection=await page.evaluate(()=>(window as any).__pendingBatch);
  expect(selection.scope).toBe('selected');expect(selection.lineIds).toHaveLength(3);expect(selection.options).toMatchObject({device:'cuda:0',referenceMode:'file',mood:'calm',accent:'fr-FR',seed:42,speed:1.05,mode:'crossLingual'});
});

test('all-translated batch keeps current takes unless forced and retains earlier takes after success',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();await page.evaluate(()=>(window as any).__seedDubbing());
  await page.getByRole('button',{name:/Doublage par lot/}).click();const panel=page.getByRole('dialog',{name:'Doublage par lot',exact:true});
  await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
  await expect(panel.getByText(/0 à générer · 4 déjà doublées/)).toBeVisible();await expect(panel.getByRole('button',{name:'Doubler 0 répliques'})).toBeDisabled();
  await panel.getByRole('checkbox',{name:/Forcer un nouvel essai/}).check();await expect(panel.getByRole('button',{name:'Doubler 4 répliques'})).toBeEnabled();await panel.getByRole('button',{name:'Doubler 4 répliques'}).click();
  expect((await page.evaluate(()=>(window as any).__pendingBatch)).force).toBe(true);
  await page.evaluate(()=>{(window as any).__advanceBatch();(window as any).__advanceBatch();(window as any).__advanceBatch();(window as any).__advanceBatch();});
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).generations.filter((g:any)=>g.kind==='tts')).toHaveLength(8);
  await expect(panel.locator('.current-job-progress')).toContainText('4 / 4 traitées · 4 réussies');await expect(panel.locator('.generation-card.selected')).toBeFocused();await expect(page.getByRole('dialog',{name:'Traitements',exact:true})).toHaveCount(0);
});

test('batch progress survives cancel and retry resumes remaining lines with the same settings',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:/Doublage par lot/}).click();const panel=page.getByRole('dialog',{name:'Doublage par lot',exact:true});
  await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');await panel.getByRole('spinbutton',{name:'Graine'}).fill('17');await panel.getByRole('button',{name:'Doubler 4 répliques'}).click();
  await page.evaluate(()=>(window as any).__advanceBatch());await expect(page.getByText(/1 \/ 4 traitées · 1 réussies/)).toBeVisible();
  await panel.locator('.current-job-progress').getByRole('button',{name:'Annuler',exact:true}).click();await page.getByRole('button',{name:'Réessayer',exact:true}).click();
  await page.evaluate(()=>{(window as any).__advanceBatch();(window as any).__advanceBatch();(window as any).__advanceBatch();});await expect(panel.locator('.current-job-progress')).toContainText('4 / 4 traitées · 4 réussies');await expect(panel.locator('.generation-card.selected')).toBeFocused();await expect(page.getByRole('dialog',{name:'Traitements',exact:true})).toHaveCount(0);
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));expect(saved.generations.filter((g:any)=>g.kind==='tts')).toHaveLength(4);expect(saved.generations.every((g:any)=>g.options.seed===17)).toBe(true);
  await page.screenshot({path:'docs/screenshots/batch-progress.png'});
});
