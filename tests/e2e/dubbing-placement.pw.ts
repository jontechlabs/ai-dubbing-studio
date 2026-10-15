import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('resizes a voice from its edge, persists exact duration and resets to automatic fitting',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());
  const block=page.getByRole('button',{name:'Doublage 1',exact:true}),box=(await block.boundingBox())!;
  await page.mouse.move(box.x+box.width-3,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width+25,box.y+box.height/2,{steps:10});await page.mouse.up();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!)),id=saved.dialogues[0].id;
  expect(saved.dubbingTiming.durationsMs[id].fr).toBeGreaterThan(2000);expect(saved.dubbingTiming.offsetsMs[id].fr).toBe(0);
  await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();const panel=page.getByRole('dialog',{name:'Doublage'});
  const duration=panel.getByRole('spinbutton',{name:'Durée demandée du doublage (ms)'});await duration.fill('500');await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();await expect(duration).toHaveValue('500');
  await panel.getByRole('button',{name:'Durée automatique',exact:true}).click();await expect(duration).toHaveValue('2000');await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
});

test('dragging and fine nudging a voice saves its placement without retiming subtitles, then resets and undoes', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
  const block=page.getByRole('button',{name:'Doublage 1',exact:true});
  await expect(block).toBeVisible(); const box=(await block.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
  await page.mouse.move(box.x+box.width/2+60,box.y+box.height/2,{steps:10}); await page.mouse.up();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const moved=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
  await page.locator('.timeline-scroll').evaluate((element)=>element.scrollTop=element.scrollHeight);await page.screenshot({path:'docs/screenshots/timeline-dubbing.png'});
  const offset=moved.dubbingTiming.offsetsMs[before.dialogues[0].id].fr;
  expect(offset).toBeGreaterThan(100); expect(moved.formatVersion).toBe(7);
  expect(moved.sourceCues).toEqual(before.sourceCues); expect(moved.targetCues).toEqual(before.targetCues); expect(moved.dialogues).toEqual(before.dialogues); expect(moved.generations).toEqual(before.generations);
  await block.focus(); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect(await page.evaluate((id)=>JSON.parse(localStorage.getItem('nativeMockProject')!).dubbingTiming.offsetsMs[id].fr,before.dialogues[0].id)).toBe(offset-11);
  await page.reload(); await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Doublage'});
  await expect(panel.getByRole('spinbutton',{name:'Décalage du doublage (ms)'})).toHaveValue(String(offset-11));
  await panel.getByRole('spinbutton',{name:'Décalage du doublage (ms)'}).fill('-250');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({path:'docs/screenshots/dubbing-placement.png'});
  await panel.getByRole('button',{name:'Réinitialiser le calage'}).click();
  await expect(panel.getByRole('spinbutton',{name:'Décalage du doublage (ms)'})).toHaveValue('0');
  await page.getByRole('button',{name:'Fermer',exact:true}).click(); await page.keyboard.press('Control+z');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await expect.poll(()=>page.evaluate((id)=>JSON.parse(localStorage.getItem('nativeMockProject')!).dubbingTiming.offsetsMs[id].fr,before.dialogues[0].id)).toBe(-250);
});
