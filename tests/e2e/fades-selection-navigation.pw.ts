import {test,expect,type Page,type Locator} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function ready(page:Page,stems=false){await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(stems=>{(window as any).__seedDubbing();if(stems)(window as any).__completeSeparation();},stems);}
async function saved(page:Page){await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');return page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));}
async function selectRange(editor:Locator,start:number,end:number){await editor.getByRole('spinbutton',{name:'Début de la sélection (ms)',exact:true}).fill(String(start));await editor.getByRole('spinbutton',{name:'Fin de la sélection (ms)',exact:true}).fill(String(end));}
async function selectTrack(page:Page,index:number){const row=page.locator('.timeline-track.audio').nth(index);await row.scrollIntoViewIfNeeded();const b=(await row.boundingBox())!;await page.mouse.move(b.x+b.width*.1,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width*.2,b.y+b.height/2);await page.mouse.up();return row;}
test('adjustable fades persist, reach playback, undo and can be removed independently of volume',async({page})=>{
  await ready(page);await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();
  let editor=page.getByRole('region',{name:'Édition du doublage',exact:true});await selectRange(editor,500,1500);
  await editor.getByRole('spinbutton',{name:'Fondu d’entrée (ms)',exact:true}).fill('100');await editor.getByRole('spinbutton',{name:'Fondu de sortie (ms)',exact:true}).fill('200');await editor.getByRole('button',{name:'Appliquer les fondus',exact:true}).click();
  let p=await saved(page);expect(p.formatVersion).toBe(12);expect(p.voiceEdits['take-1'].pieces[1].envelope).toEqual([{atMs:0,level:0},{atMs:100,level:1},{atMs:800,level:1},{atMs:1000,level:0}]);
  await expect(editor.locator('.voice-wave-loading')).toHaveCount(0);await page.screenshot({path:'docs/screenshots/voice-fades-fr.png'});
  await editor.getByRole('button',{name:'Retirer les fondus',exact:true}).click();p=await saved(page);expect(p.voiceEdits['take-1'].pieces[1].envelope).toEqual([{atMs:0,level:1},{atMs:1000,level:1}]);
  await page.keyboard.press('Control+z');await saved(page);await page.reload();await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();editor=page.getByRole('region',{name:'Édition du doublage',exact:true});expect((await saved(page)).voiceEdits['take-1'].pieces[1].envelope[0].level).toBe(0);
  await page.locator('.player-mode').getByRole('button',{name:'Préparer le mix de doublage'}).click();await page.getByRole('button',{name:'Lecture',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='dubbing_path'&&c.args.edit?.pieces.some((p:any)=>p.envelope?.[0]?.level===0)))).toBe(true);await page.getByRole('button',{name:'Pause',exact:true}).click();
});
test('waveform selection boundaries can be resized without stretching the audio',async({page})=>{
  await ready(page);await page.getByRole('button',{name:'Doublage 1',exact:true}).dblclick();const editor=page.getByRole('region',{name:'Édition du doublage',exact:true});await selectRange(editor,500,1000);
  const before=await saved(page),end=editor.getByRole('button',{name:'Redimensionner la fin de la sélection vocale',exact:true}),b=(await end.boundingBox())!,wave=(await editor.locator('.voice-edit-wave').boundingBox())!;
  await page.mouse.move(b.x+3,b.y+8);await page.mouse.down();await page.mouse.move(b.x+3+wave.width*.1,b.y+8);await page.mouse.up();
  expect(Number(await editor.getByRole('spinbutton',{name:'Fin de la sélection (ms)',exact:true}).inputValue())).toBeGreaterThan(1190);expect((await saved(page)).voiceEdits).toEqual(before.voiceEdits);
});
test('free track selections resize with pointer and numeric bounds without changing audio',async({page})=>{
  await ready(page,true);await page.getByRole('button',{name:'Sélectionner une zone audio (ou Maj + glisser)',exact:true}).click();const row=await selectTrack(page,0),controls=page.getByRole('group',{name:'Réglage de la sélection audio',exact:true});
  const before=await saved(page),end=row.getByRole('button',{name:/Redimensionner la fin/});const b=(await end.boundingBox())!,r=(await row.boundingBox())!;
  await page.mouse.move(b.x+4,b.y+10);await page.mouse.down();await page.mouse.move(b.x+4+r.width*.1,b.y+10);await page.mouse.up();
  expect(Number(await controls.getByRole('spinbutton',{name:'Fin de la zone audio (ms)',exact:true}).inputValue())).toBeGreaterThan(4700);
  await controls.getByRole('spinbutton',{name:'Début de la zone audio (ms)',exact:true}).fill('1000');await controls.getByRole('spinbutton',{name:'Début de la zone audio (ms)',exact:true}).press('Enter');await expect(controls.getByRole('spinbutton',{name:'Début de la zone audio (ms)',exact:true})).toHaveValue('1000');expect((await saved(page)).tracks).toEqual(before.tracks);
});
test('all five audio tracks resize their applied region with gain/mute intact and Escape cancels the gesture',async({page})=>{
  test.setTimeout(60000);await ready(page,true);await page.getByRole('button',{name:'Sélectionner une zone audio (ou Maj + glisser)',exact:true}).click();
  const controls=page.getByRole('group',{name:'Réglage de la sélection audio',exact:true});
  for(const [i,id] of ['original','speech','music','sfx','dubbing'].entries()){
    const row=await selectTrack(page,i);await controls.getByRole('slider',{name:'Volume de la sélection',exact:true}).fill('0.5');let p=await saved(page),region=p.tracks.find((t:any)=>t.id===id).regions[0];const oldEnd=region.endMs;
    const end=row.getByRole('button',{name:/Redimensionner la fin/});await end.focus();await page.keyboard.press('ArrowRight');p=await saved(page);region=p.tracks.find((t:any)=>t.id===id).regions[0];expect(region.endMs).toBe(oldEnd+10);expect(region.gain).toBe(.5);
    await controls.getByRole('button',{name:'Rendre la zone silencieuse',exact:true}).click();p=await saved(page);const before=JSON.stringify(p.tracks.find((t:any)=>t.id===id).regions),b=(await end.boundingBox())!;
    await page.mouse.move(b.x+4,b.y+10);await page.mouse.down();await page.mouse.move(b.x+35,b.y+10);await page.keyboard.press('Escape');await page.mouse.up();p=await saved(page);expect(JSON.stringify(p.tracks.find((t:any)=>t.id===id).regions)).toBe(before);
    if(i===1)await page.screenshot({path:'docs/screenshots/audio-selection-resize-fr.png'});
    await controls.getByRole('button',{name:'Effacer la sélection audio',exact:true}).click();
  }
  await page.keyboard.press('Control+z');await saved(page);await page.reload();expect((await saved(page)).tracks.find((t:any)=>t.id==='dubbing').regions[0].mute).toBe(false);
});
test('clicking and re-clicking a reply reveals its playhead at the same zoom and the voice editor follows it',async({page})=>{
  await ready(page);await page.locator('.dialogue-card').first().click();await page.getByRole('button',{name:'Zoom sur la réplique',exact:true}).click();const zoom=await page.locator('.zoom-value').innerText(),scroll=page.locator('.timeline-scroll');
  const visible=()=>page.locator('.playhead').evaluate(e=>{const box=e.getBoundingClientRect(),view=e.closest('.timeline-scroll')!.getBoundingClientRect();return box.x>=view.x&&box.x<view.right;});
  await page.getByRole('button',{name:'Éditer une zone du doublage sélectionné',exact:true}).click();await page.locator('.dialogue-card').last().click();await expect.poll(visible).toBe(true);await expect(page.locator('.zoom-value')).toHaveText(zoom);await expect(page.locator('.voice-editor-title > span')).toHaveText('À vous de lui donner vie.');
  await expect.poll(()=>scroll.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);await scroll.evaluate(e=>e.scrollLeft=0);await page.locator('.dialogue-card').last().click();await expect.poll(visible).toBe(true);await expect(page.locator('.zoom-value')).toHaveText(zoom);await expect.poll(()=>page.locator('video').evaluate((v:HTMLVideoElement)=>v.currentTime)).toBe(11.75);
});
