import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function ready(page:Page){await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());}
const project=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
async function saved(page:Page){await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');return project(page);}
async function panel(page:Page){await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();return page.getByRole('dialog',{name:'Doublage',exact:true});}

test('numeric timing drafts commit atomically, reject overflow, and cancel safely',async({page})=>{
 await ready(page);const before=await saved(page),dub=await panel(page),input=dub.getByRole('spinbutton',{name:'Durée demandée du doublage (ms)',exact:true});
 await expect(input).toHaveAttribute('max','3750');await input.fill('120000');await page.waitForTimeout(750);expect((await project(page)).dubbingTiming).toEqual(before.dubbingTiming);
 await input.press('Enter');await expect(dub.getByRole('alert')).toContainText('hors des limites');expect((await project(page)).dubbingTiming).toEqual(before.dubbingTiming);await expect(input).toHaveValue('2000');
 await input.fill('500');await input.press('Escape');await expect(input).toHaveValue('2000');expect((await project(page)).dubbingTiming).toEqual(before.dubbingTiming);
 await input.fill('3750');await input.press('Enter');const after=await saved(page);expect(after.dubbingTiming.durationsMs[after.dialogues[0].id].fr).toBe(3750);expect(after.generations).toEqual(before.generations);
 await page.reload();await panel(page);await expect(input).toHaveValue('3750');
});
test('timeline resizing stops at the next voice and film end, while moving preserves every audible duration',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);
 const block=page.getByRole('button',{name:'Doublage 1',exact:true}),b=(await block.boundingBox())!;
 await page.mouse.move(b.x+b.width-2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width+800,b.y+b.height/2,{steps:10});await page.mouse.up();let p=await saved(page);expect(p.dubbingTiming.durationsMs[p.dialogues[0].id].fr).toBe(3750);
 const last=page.getByRole('button',{name:'Doublage 4',exact:true}),l=(await last.boundingBox())!;await page.mouse.move(l.x+l.width-2,l.y+l.height/2);await page.mouse.down();await page.mouse.move(l.x+l.width+300,l.y+l.height/2,{steps:5});await page.mouse.up();p=await saved(page);expect(p.dubbingTiming.durationsMs[p.dialogues[3].id].fr).toBe(3500);
 // Undo the first resize before testing movement of a two-second take.
 await page.keyboard.press('Control+z');await saved(page);await page.keyboard.press('Control+z');await saved(page);
 const c=(await block.boundingBox())!;await page.mouse.move(c.x+c.width/2,c.y+c.height/2);await page.mouse.down();await page.mouse.move(1800,c.y+c.height/2,{steps:10});await page.mouse.up();p=await saved(page);
 expect(p.dubbingTiming.offsetsMs[p.dialogues[0].id].fr+p.dialogues[0].startMs).toBe(10500);expect(p.dubbingTiming.durationsMs?.[p.dialogues[0].id]?.fr).toBeUndefined();expect(errors).toEqual([]);
});
test('local stretching stops at the whole take maximum and further silence is refused without losing the edit',async({page})=>{
 await ready(page);await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();const editor=page.getByRole('region',{name:'Édition du doublage',exact:true});
 await editor.getByRole('spinbutton',{name:'Début de la sélection (ms)',exact:true}).fill('500');await editor.getByRole('spinbutton',{name:'Fin de la sélection (ms)',exact:true}).fill('1000');
 const wave=(await editor.locator('.voice-edit-wave').boundingBox())!,handle=editor.getByRole('button',{name:'Étirer la zone sélectionnée : tirer cette poignée',exact:true}),h=(await handle.boundingBox())!;
 await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+wave.width,h.y+h.height/2,{steps:10});await page.mouse.up();const before=await saved(page);expect(before.voiceEdits['take-1'].pieces.reduce((n:number,p:any)=>n+p.durationMs,0)).toBe(3750);
 await editor.getByRole('spinbutton',{name:'Durée (ms)',exact:true}).fill('1');await editor.getByRole('button',{name:'Insérer du silence',exact:true}).click();await expect(editor.getByRole('alert')).toContainText('dépasserait la réplique suivante');expect((await project(page)).voiceEdits).toEqual(before.voiceEdits);
 await editor.getByRole('button',{name:'Appliquer les fondus',exact:true}).click();await saved(page);await expect(editor.locator('.voice-wave-total')).toHaveText('3.750 s');await expect(editor.locator('.voice-wave-loading')).toHaveCount(0);await page.screenshot({path:'docs/screenshots/voice-duration-limits-fr.png'});
 await page.reload();await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();await expect(editor.locator('.voice-wave-total')).toHaveText('3.750 s');
});
test('legacy oversize durations reopen with a repair action, retain edits and support undo and redo',async({page})=>{
 await ready(page);let p=await saved(page);const id=p.dialogues[0].id;p.formatVersion=11;p.voiceEdits={'take-1':{pieces:[{sourceStartMs:0,sourceEndMs:2000,durationMs:2000,gain:0.5}]}};p.dubbingTiming={sourcePath:p.media.path,offsetsMs:{[id]:{fr:0}},durationsMs:{[id]:{fr:120000}}};await page.evaluate(p=>localStorage.setItem('nativeMockProject',JSON.stringify(p)),p);await page.reload();const dub=await panel(page);
 await expect(dub.getByRole('alert')).toContainText('dépasse le créneau');await expect(dub.getByRole('spinbutton',{name:'Durée demandée du doublage (ms)'})).toHaveValue('120000');await page.screenshot({path:'docs/screenshots/voice-duration-recovery-fr.png'});
 await dub.getByRole('button',{name:'Replacer dans un espace disponible',exact:true}).click();const after=await saved(page);expect(after.dubbingTiming.durationsMs[id].fr).toBe(3750);expect(after.voiceEdits).toEqual(p.voiceEdits);await expect(dub.getByRole('alert')).toHaveCount(0);
 await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.keyboard.press('Control+z');await saved(page);await panel(page);await expect(dub.getByRole('alert')).toBeVisible();await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.keyboard.press('Control+Shift+z');await saved(page);await panel(page);await expect(dub.getByRole('alert')).toHaveCount(0);
});
test('equal-onset legacy collisions can be recovered from the editor without a React crash',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await ready(page);let p=await saved(page);const id=p.dialogues[0].id;p.formatVersion=7;p.dubbingTiming={sourcePath:p.media.path,offsetsMs:{[id]:{fr:3750}}};await page.evaluate(p=>localStorage.setItem('nativeMockProject',JSON.stringify(p)),p);await page.reload();const dub=await panel(page);
 await expect(dub.getByRole('alert')).toContainText('créneau');await dub.getByRole('button',{name:'Replacer dans un espace disponible',exact:true}).click();p=await saved(page);expect(p.dubbingTiming.offsetsMs[id].fr).toBe(1750);expect(p.dubbingTiming.durationsMs[id].fr).toBe(2000);await expect(dub.getByRole('alert')).toHaveCount(0);expect(errors).toEqual([]);
});
