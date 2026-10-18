import { test,expect,type Page } from '@playwright/test';
import {nativeMock} from './nativeMock';
async function setup(page:Page){await nativeMock(page);await page.addInitScript(()=>{const host=window as any;host.__voiceStarts=[];const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args:any[]){host.__voiceStarts.push(args);return (start as any).apply(this,args);};});await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();return page.getByRole('region',{name:'Édition du doublage',exact:true});}
const saved=(page:Page)=>expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
const project=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
async function range(editor:ReturnType<Page['getByRole']>,start:number,end:number){await editor.getByRole('spinbutton',{name:'Début de la sélection (ms)',exact:true}).fill(String(start));await editor.getByRole('spinbutton',{name:'Fin de la sélection (ms)',exact:true}).fill(String(end));}
test('inserts silence at a cursor, stores the edit and restores it through undo/redo and reopening',async({page})=>{
  let editor=await setup(page);await range(editor,500,500);await editor.getByRole('button',{name:'Insérer du silence',exact:true}).click();await saved(page);
  let p=await project(page);expect(p.voiceEdits['take-1'].pieces.map((x:any)=>x.durationMs)).toEqual([500,250,1500]);expect(p.formatVersion).toBe(11);
  await page.keyboard.press('Control+z');await saved(page);expect((await project(page)).voiceEdits?.['take-1']).toBeUndefined();
  await page.keyboard.press('Control+Shift+z');await saved(page);expect((await project(page)).voiceEdits['take-1'].pieces).toHaveLength(3);
  await page.reload();await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();editor=page.getByRole('region',{name:'Édition du doublage',exact:true});await expect(editor.locator('.voice-wave-total')).toHaveText('2.250 s');
});
test('sets local gain, mutes and deletes only the selected range without shifting subtitles',async({page})=>{
  const editor=await setup(page);const before=await project(page);await range(editor,400,900);
  await editor.getByRole('slider').fill('1.5');await editor.getByRole('button',{name:'Appliquer le volume',exact:true}).click();await saved(page);
  expect((await project(page)).voiceEdits['take-1'].pieces[1].gain).toBe(1.5);
  await editor.getByRole('button',{name:'Rendre muet',exact:true}).click();await saved(page);expect((await project(page)).voiceEdits['take-1'].pieces[1].gain).toBe(0);
  await editor.getByRole('button',{name:'Supprimer et rapprocher',exact:true}).click();await saved(page);
  const after=await project(page);expect(after.voiceEdits['take-1'].pieces.map((p:any)=>p.durationMs)).toEqual([400,1100]);expect(after.targetCues).toEqual(before.targetCues);expect(after.generations).toEqual(before.generations);
});
test('drags a selection and stretches its right handle, with Escape cancelling the change',async({page})=>{
  const editor=await setup(page);const wave=editor.getByRole('group',{name:'Forme d’onde : sélectionner une zone du doublage',exact:true});const box=(await wave.boundingBox())!;
  await page.mouse.move(box.x+box.width*.2,box.y+20);await page.mouse.down();await page.mouse.move(box.x+box.width*.5,box.y+20);await page.mouse.up();
  await expect(editor.getByRole('spinbutton',{name:'Début de la sélection (ms)',exact:true})).toHaveValue('400');
  const handle=editor.getByRole('button',{name:'Étirer la zone sélectionnée : tirer cette poignée',exact:true});const h=(await handle.boundingBox())!;
  await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+h.width/2+box.width*.1,h.y+h.height/2);await page.mouse.up();await saved(page);
  expect((await project(page)).voiceEdits['take-1'].pieces[1].durationMs).toBeGreaterThan(790);
  const previous=await project(page);const h2=(await handle.boundingBox())!;await page.mouse.move(h2.x+4,h2.y+4);await page.mouse.down();await page.mouse.move(h2.x+100,h2.y+4);await page.keyboard.press('Escape');await page.mouse.up();await saved(page);expect((await project(page)).voiceEdits).toEqual(previous.voiceEdits);
});
test('rejects an overlap without modifying audio and passes current edits to synchronized playback',async({page})=>{
  const editor=await setup(page);await range(editor,0,0);await editor.getByRole('spinbutton',{name:'Durée (ms)',exact:true}).fill('5000');await editor.getByRole('button',{name:'Insérer du silence',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('dépasserait la réplique suivante');expect((await project(page)).voiceEdits).toBeUndefined();
  await range(editor,500,900);await editor.getByRole('button',{name:'Rendre muet',exact:true}).click();await saved(page);
  await page.locator('.player-mode').getByRole('button',{name:'Préparer le mix de doublage'}).click();await page.getByRole('button',{name:'Lecture',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='dubbing_path'&&c.args.id==='take-1'&&c.args.edit?.pieces.some((p:any)=>p.gain===0)))).toBe(true);
  await page.getByRole('button',{name:'Pause',exact:true}).click();
});
test('captures the local editor and resets edits to the untouched take',async({page})=>{
  const editor=await setup(page);await range(editor,650,1100);await editor.getByRole('spinbutton',{name:'Durée (ms)',exact:true}).fill('700');await editor.getByRole('button',{name:'Fixer la durée de la zone',exact:true}).click();await saved(page);
  await expect(editor.locator('.voice-wave-loading')).toHaveCount(0);await editor.getByRole('button',{name:'Écouter la sélection',exact:true}).click();await expect(editor.getByRole('button',{name:'Arrêter l’écoute',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__voiceStarts.at(-1))).toEqual([0,.65,.7]);await editor.getByRole('button',{name:'Arrêter l’écoute',exact:true}).click();await page.screenshot({path:'docs/screenshots/voice-region-editor-fr.png'});
  await editor.getByRole('button',{name:'Restaurer l’audio original',exact:true}).click();await saved(page);expect((await project(page)).voiceEdits?.['take-1']).toBeUndefined();await expect(editor.locator('.voice-wave-total')).toHaveText('2.000 s');
});
