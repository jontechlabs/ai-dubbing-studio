import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
const zoom=(page:Page)=>page.locator('.zoom-value');
test('CapCut-style keyboard and wheel zoom preserve the playhead and pointer time, and Shift Z fits',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
  await page.locator('video').evaluate((video:HTMLVideoElement)=>video.currentTime=3);await expect.poll(()=>page.locator('.playhead').evaluate((element)=>element.style.transform)).not.toBe('translateX(0px)');
  const x=(await page.locator('.playhead').boundingBox())!.x;
  await page.keyboard.press('Control+Equal');await expect(zoom(page)).toHaveText('150%');expect(Math.abs((await page.locator('.playhead').boundingBox())!.x-x)).toBeLessThan(2);
  await page.keyboard.press('Control+Minus');await expect(zoom(page)).toHaveText('100%');
  const scroll=page.locator('.timeline-scroll'),box=(await scroll.boundingBox())!,pixel=box.width*.6;
  const time=()=>scroll.evaluate((element,pixel)=>{const body=element.querySelector('.timeline-content')!;return(element.scrollLeft+pixel)/body.getBoundingClientRect().width*16000;},pixel);
  const before=await time();await page.mouse.move(box.x+pixel,box.y+15);await page.keyboard.down('Control');await page.mouse.wheel(0,-180);await page.keyboard.up('Control');await expect(zoom(page)).not.toHaveText('100%');expect(Math.abs(await time()-before)).toBeLessThan(20);expect(await page.evaluate(()=>window.innerWidth)).toBe(1440);
  await page.keyboard.press('Shift+Z');await expect(zoom(page)).toHaveText('100%');await expect.poll(()=>scroll.evaluate((element)=>element.scrollLeft)).toBe(0);
  await page.getByPlaceholder('Rechercher une réplique…').focus();await page.keyboard.press('Control+Equal');await expect(zoom(page)).toHaveText('100%');
});
test('long films zoom to a voice beyond one hour with visible millisecond ruler ticks and draggable edges',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>{(window as any).__longFilm();(window as any).__seedDubbing();});
  await page.locator('.dialogue-card').first().click();await page.getByRole('button',{name:'Zoom sur la réplique',exact:true}).click();
  expect(Number((await zoom(page).innerText()).replace('%',''))).toBeGreaterThan(10000);await expect(page.getByRole('button',{name:'Doublage 1',exact:true})).toBeVisible();
  await expect.poll(()=>page.locator('.ruler').innerText()).toContain('01:00:');expect(await page.locator('.ruler > span').count()).toBeLessThan(100);
  await page.getByRole('slider',{name:'Zoom de la timeline',exact:true}).fill('100');await expect.poll(()=>page.locator('.ruler').innerText()).toMatch(/01:00:\d\d\.\d{3}/);
  await page.screenshot({path:'docs/screenshots/timeline-zoom.png'});
});
