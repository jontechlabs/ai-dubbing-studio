import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function setup(page:Page){
 await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();
 await page.evaluate(()=>{(window as any).__seedDubbing();});
 await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
 const panel=page.getByRole('dialog',{name:'Doublage',exact:true});await panel.locator('.prosody-transfer summary').click();return panel;
}
test('transfers a selected take through typed options and preserves old takes while queued',async({page})=>{
 const panel=await setup(page),before=await page.evaluate(()=>(window as any).__getMockProject());
 await panel.getByRole('slider',{name:'Intensité du transfert'}).fill('0.6');
 await panel.getByLabel('Rythme',{exact:true}).uncheck();
 await panel.locator('.prosody-transfer').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/prosody-transfer-fr.png'});
 await panel.getByRole('button',{name:'Créer un nouvel essai avec cette intonation'}).click();
 const options=await page.evaluate(()=>(window as any).__pendingProsody);
 expect(options).toMatchObject({generationId:'take-1',referenceMode:'dialogue',referenceId:null,strength:.6,pitch:true,rhythm:false,energy:true});
 expect((await page.evaluate(()=>(window as any).__getMockProject())).generations).toEqual(before.generations);
});
test('prevents an empty transfer and rejects takes longer than the supported window',async({page})=>{
 const panel=await setup(page),button=panel.getByRole('button',{name:'Créer un nouvel essai avec cette intonation'});
 for(const part of ['Mélodie','Rythme','Énergie'])await panel.getByLabel(part,{exact:true}).uncheck();
 await expect(button).toBeDisabled();await panel.getByLabel('Mélodie',{exact:true}).check();await expect(button).toBeEnabled();
 await page.evaluate(()=>{const p=(window as any).__getMockProject();p.generations[0].durationMs=31000;localStorage.setItem('nativeMockProject',JSON.stringify(p));});
 await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
 await panel.locator('.prosody-transfer summary').click();await expect(button).toBeDisabled();await expect(panel.locator('.prosody-transfer')).toContainText('entre 150 ms et 30 secondes');
});
