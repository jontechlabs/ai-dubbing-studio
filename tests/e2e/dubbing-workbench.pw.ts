import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function start(page:Page){await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();await page.evaluate(()=>(window as any).__seedDubbing());await page.locator('.dialogue-card').first().locator('.line-select').click();await page.getByRole('button',{name:'Ajouter un doublage',exact:true}).click();return page.getByRole('dialog',{name:'Doublage',exact:true});}
test('dubbing workbench edits shared voice/source text, previews chosen track and keeps current progress and all takes',async({page})=>{
 await page.setViewportSize({width:1600,height:1100});const panel=await start(page);
 const before=await page.evaluate(()=>(window as any).__getMockProject());
 await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
 await panel.getByRole('textbox',{name:'Texte qui sera prononcé',exact:true}).fill('Une interprétation française expressive.');
 await panel.getByRole('textbox',{name:'Texte original de la réplique',exact:true}).fill('日本語の訂正です。');
 await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
 await panel.getByRole('button',{name:'Écouter la référence vocale actuelle',exact:true}).click();
 const audio=panel.locator('.current-reference-audio audio');await expect(audio).toBeVisible();await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.readyState)).toBeGreaterThanOrEqual(1);await audio.evaluate((a:HTMLAudioElement)=>a.pause());
 await panel.getByRole('button',{name:'Générer un nouvel essai',exact:true}).click();
 await expect(panel).toBeVisible();await expect(page.getByRole('dialog',{name:'Traitements',exact:true})).toHaveCount(0);
 await expect(panel.locator('.current-job-progress')).toContainText('Génération');
 await page.screenshot({path:'docs/screenshots/dubbing-workbench-fr.png'});
 await page.evaluate(()=>(window as any).__completeTts());await expect(panel.locator('.generation-card')).toHaveCount(2);
 const after=await page.evaluate(()=>(window as any).__getMockProject());expect(after.generations.slice(0,before.generations.length)).toEqual(before.generations);expect(after.dialogues[0].ttsText).toBe('Une interprétation française expressive.');expect(after.sourceCues[0].text).toBe('日本語の訂正です。');expect(after.targetCues).toEqual(before.targetCues);
 await expect(panel.getByRole('button',{name:'Générer un nouvel essai',exact:true})).toBeEnabled();
 await panel.getByRole('button',{name:'Fermer',exact:true}).click();await page.getByRole('button',{name:'Prononciation',exact:true}).click();await expect(page.getByRole('textbox',{name:'Texte pour la voix',exact:true})).toHaveValue('Une interprétation française expressive.');
});
test('two-stage option passes independent timbre reference and retains each stage for comparison',async({page})=>{
 const panel=await start(page),before=await page.evaluate(()=>(window as any).__getMockProject());
 await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
 await panel.getByRole('checkbox',{name:'Doublage en 2 étapes : TTS puis timbre',exact:true}).check();
 await panel.getByRole('combobox',{name:'Périphérique de conversion du timbre',exact:true}).selectOption('cuda:0');
 await panel.getByRole('slider',{name:'Guide d’intonation de la réplique source (expérimental)',exact:true}).fill('25');
 await panel.getByRole('button',{name:'Générer un nouvel essai',exact:true}).click();
 const options=await page.evaluate(()=>(window as any).__pendingPipeline);expect(options).toMatchObject({guideStrength:.25,conversion:{referenceMode:'current',device:'cuda:0'}});
 await expect(panel.locator('.current-job-progress')).toContainText('Doublage en 2 étapes');
 await page.evaluate(()=>(window as any).__completePipeline());await expect(panel.locator('.generation-card')).toHaveCount(4);
 const after=await page.evaluate(()=>(window as any).__getMockProject());expect(after.generations.slice(0,before.generations.length)).toEqual(before.generations);expect(after.generations.at(-1).dubbingPipeline.stageIds).toHaveLength(3);
});
test('toolbox uses timeline selection, auditions before mapping and applies only chosen outputs at the same timestamp',async({page})=>{
 await page.setViewportSize({width:1600,height:1100});await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Sélectionner une zone audio (ou Maj + glisser)',exact:true}).click();
 const row=page.locator('.timeline-track[data-track-id="original"]');await row.scrollIntoViewIfNeeded();const box=(await row.boundingBox())!;
 await page.mouse.move(box.x+box.width*.1,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.2,box.y+box.height/2);await page.mouse.up();
 const selected=(await row.locator('.audio-range-selection.persistent').boundingBox())!;await page.mouse.click(selected.x+selected.width/2,selected.y+selected.height/2,{button:'right'});
 await page.getByRole('menuitem',{name:'Isoler les voix · Mel-Band RoFormer Kim',exact:true}).click();
 const section=page.locator('.audio-toolbox');await expect(section).toBeVisible();const before=await page.evaluate(()=>(window as any).__getMockProject());
 await section.getByRole('spinbutton',{name:'Début (s)',exact:true}).fill('1');await section.getByRole('spinbutton',{name:'Fin (s)',exact:true}).fill('3');
 await section.getByRole('button',{name:'Isoler la sélection',exact:true}).click();await expect(section.locator('.current-job-progress')).toBeVisible();await page.evaluate(()=>(window as any).__completeToolbox());
 await expect(section.locator('.toolbox-output audio')).toHaveCount(2);await expect(section.getByRole('button',{name:'Appliquer les sorties choisies',exact:true})).toBeDisabled();expect((await page.evaluate(()=>(window as any).__getMockProject())).generations).toEqual(before.generations);
 await section.getByRole('combobox',{name:'Destination : Voix',exact:true}).selectOption('role:speech');await page.screenshot({path:'docs/screenshots/audio-toolbox-fr.png'});
 await section.getByRole('button',{name:'Appliquer les sorties choisies',exact:true}).click();await expect(section.getByText('Sorties appliquées à la timeline.',{exact:true})).toBeVisible();
 const after=await page.evaluate(()=>(window as any).__getMockProject());expect(after.generations).toHaveLength(before.generations.length+1);expect(after.generations.at(-1)).toMatchObject({startMs:1000,endMs:3000,trackId:'speech',mode:'replace'});expect(after.media).toEqual(before.media);
});
