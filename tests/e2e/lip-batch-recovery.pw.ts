import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
const data=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
async function open(page:Page,selected=false){
  await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.evaluate(()=>(window as any).__seedDubbing());
  if(selected)await page.getByRole('checkbox',{name:'Cocher la réplique 1 pour le lot',exact:true}).check();
  await page.getByRole('button',{name:'Synchronisation labiale par lot',exact:true}).click();
  return page.getByRole('dialog',{name:'Synchronisation labiale par lot',exact:true});
}
async function face(page:Page){await page.locator('.mouth-selector').scrollIntoViewIfNeeded();const b=(await page.locator('.mouth-selector').boundingBox())!;await page.mouse.move(b.x+b.width*.2,b.y+b.height*.1);await page.mouse.down();await page.mouse.move(b.x+b.width*.7,b.y+b.height*.9,{steps:4});await page.mouse.up();}
test('all dubbed dialogue batch requires framing and retains independent inactive variants',async({page})=>{
 const panel=await open(page),action=panel.locator('.batch-inpaint');
 await expect(action.getByRole('status')).toContainText('0 prêtes');await face(page);
 await expect(action.getByRole('checkbox',{name:'Utiliser le cadrage affiché pour les répliques sans cadrage'})).not.toBeChecked();
 await panel.getByRole('button',{name:/Conserver ce cadrage pour la réplique 1/}).click();
 await expect(action.getByRole('status')).toContainText('1 prêtes');
 await action.getByRole('checkbox',{name:'Utiliser le cadrage affiché pour les répliques sans cadrage'}).check();
 await expect(action.getByRole('status')).toContainText('4 prêtes');
 await expect(action.getByRole('checkbox',{name:'Activer les nouvelles variantes après leur génération'})).not.toBeChecked();
 await action.getByRole('button',{name:'Synchroniser 4 répliques',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/lip-batch-fr.png'});
 const before=await data(page);await action.getByRole('button',{name:'Synchroniser 4 répliques',exact:true}).click();
 const sent=await page.evaluate(()=>(window as any).__pendingLipBatch);expect(sent.scope).toBe('all');expect(sent.options.device).toBe('cuda:0');expect(Object.keys(sent.crops)).toEqual([before.dialogues[0].id]);
 for(let i=0;i<4;i++)await page.evaluate(()=>(window as any).__advanceLipBatch());
 await expect.poll(async()=>(await data(page)).generations.filter((g:any)=>g.kind==='lipVideo').length).toBe(4);
 const after=await data(page),clips=after.generations.filter((g:any)=>g.kind==='lipVideo');
 expect(clips.every((v:any)=>!v.enabled)).toBe(true);expect(new Set(clips.map((v:any)=>v.path)).size).toBe(4);
 expect(after.media).toEqual(before.media);expect(after.generations.filter((g:any)=>g.kind==='tts')).toEqual(before.generations.filter((g:any)=>g.kind==='tts'));
});
test('checked scope keeps finished clips through cancellation and resumes pending only',async({page})=>{
 const panel=await open(page,true),action=panel.locator('.batch-inpaint');await face(page);
 await action.getByRole('checkbox',{name:'Utiliser le cadrage affiché pour les répliques sans cadrage'}).check();
 await expect(action.getByRole('combobox',{name:'Portée de la synchronisation labiale'})).toHaveValue('selected');
 await expect(action.getByRole('status')).toContainText('1 prêtes sur 1');
 await action.getByRole('combobox',{name:'Portée de la synchronisation labiale'}).selectOption('all');
 await action.getByRole('checkbox',{name:'Activer les nouvelles variantes après leur génération'}).check();
 await action.getByRole('button',{name:'Synchroniser 4 répliques',exact:true}).click();
 await page.evaluate(()=>(window as any).__advanceLipBatch());
 const jobs=page.getByRole('dialog',{name:'Traitements',exact:true});await jobs.getByRole('button',{name:'Annuler',exact:true}).click();
 await page.evaluate(()=>(window as any).__advanceLipBatch());
 expect((await data(page)).generations.filter((g:any)=>g.kind==='lipVideo')).toHaveLength(1);
 await jobs.getByRole('button',{name:'Réessayer',exact:true}).click();
 for(let i=0;i<3;i++)await page.evaluate(()=>(window as any).__advanceLipBatch());
 const clips=(await data(page)).generations.filter((g:any)=>g.kind==='lipVideo');expect(clips).toHaveLength(4);expect(clips.every((v:any)=>v.enabled)).toBe(true);
});
test('audio edit is committed only after rendering succeeds and failure preserves auditionable original',async({page})=>{
 await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());
 await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();
 const editor=page.getByRole('region',{name:'Édition du doublage',exact:true}),before=await data(page);
 await editor.getByRole('spinbutton',{name:'Début de la sélection (ms)',exact:true}).fill('1057');
 await editor.getByRole('spinbutton',{name:'Fin de la sélection (ms)',exact:true}).fill('1212');
 await page.evaluate(()=>(window as any).__deferEdit=true);
 await editor.getByRole('button',{name:'Fixer la durée de la zone',exact:true}).click();
 await expect(editor.getByText('Vérification du rendu avant d’enregistrer la modification…',{exact:true})).toBeVisible();
 expect((await data(page)).voiceEdits).toEqual(before.voiceEdits);
 await page.evaluate(()=>(window as any).__releaseEdit(true));
 await expect(editor.getByRole('alert')).toContainText('La version précédente et l’essai d’origine sont conservés');
 expect((await data(page)).generations).toEqual(before.generations);expect((await data(page)).voiceEdits).toEqual(before.voiceEdits);
 await editor.getByRole('button',{name:'Écouter l’essai d’origine',exact:true}).click();await expect(editor.getByRole('button',{name:'Arrêter l’écoute',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__calls.filter((c:any)=>c.command==='generation_path').at(-1).args.edit)).toBeNull();
 await page.screenshot({path:'docs/screenshots/voice-edit-recovery-fr.png'});
 await editor.getByRole('button',{name:'Arrêter l’écoute',exact:true}).click();
 await page.evaluate(()=>(window as any).__deferEdit=false);
 await editor.getByRole('button',{name:'Fixer la durée de la zone',exact:true}).click();
 await expect.poll(async()=>(await data(page)).voiceEdits?.['take-1']?.pieces[1].durationMs).toBe(250);
});
test('multiline dialogue rows remain separated through filtering, scrolling and pane resizing',async({page})=>{
 await nativeMock(page,true);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();await page.evaluate(()=>(window as any).__multilineCards());
 const overlap=()=>page.locator('[data-dialogue-row]').evaluateAll(rows=>{const boxes=rows.map(r=>r.getBoundingClientRect()).sort((a,b)=>a.y-b.y);return boxes.some((r,i)=>i>0&&r.y<boxes[i-1].bottom+5);});
 await expect.poll(overlap).toBe(false);
 expect(await page.locator('.dialogue-card').count()).toBeLessThan(25);
 await page.setViewportSize({width:1100,height:940});await expect.poll(overlap).toBe(false);
 await page.locator('.dialogue-scroll').evaluate(e=>e.scrollTop=60000);await expect.poll(overlap).toBe(false);
 await page.getByPlaceholder('Rechercher une réplique…').fill('Tu vois');await expect.poll(overlap).toBe(false);
 await page.locator('.dialogue-scroll').evaluate(e=>e.scrollTop=0);
 await page.screenshot({path:'docs/screenshots/dialogue-layout-fixed-fr.png'});
});
