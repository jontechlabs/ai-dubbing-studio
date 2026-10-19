import {test,expect,type Page} from '@playwright/test';
import {nativeMock} from './nativeMock';
async function open(page:Page){
 await nativeMock(page);await page.goto('/');await expect(page.getByRole('button',{name:'Lecture',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__seedDubbing());
 await page.getByRole('button',{name:'Synchronisation labiale par lot',exact:true}).click();
 return page.getByRole('dialog',{name:'Synchronisation labiale par lot',exact:true});
}
test('face proposals require review, retain manual framing and leave ambiguous shots unframed',async({page})=>{
 const panel=await open(page),face=panel.locator('.face-detection-action'),batch=panel.locator('.batch-inpaint');
 await page.locator('.mouth-selector').scrollIntoViewIfNeeded();const b=(await page.locator('.mouth-selector').boundingBox())!;
 await page.mouse.move(b.x+b.width*.3,b.y+b.height*.1);await page.mouse.down();await page.mouse.move(b.x+b.width*.8,b.y+b.height*.9,{steps:4});await page.mouse.up();
 await panel.getByRole('button',{name:/Conserver ce cadrage pour la réplique 1/}).click();
 await expect(batch.getByRole('status')).toContainText('1 prêtes');
 const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
 await face.getByRole('button',{name:'Détecter les visages du lot',exact:true}).click();
 expect(await page.evaluate(()=>(window as any).__pendingFaceDetection.profile)).toBe('auto');
 await page.evaluate(()=>(window as any).__completeFaceDetection(true));
 await expect(face.getByRole('status')).toContainText('Propositions : 1 · À cadrer manuellement : 2');
 await expect(batch.getByRole('status').last()).toContainText('1 prêtes');
 await face.getByRole('button',{name:'Utiliser les cadrages proposés (1)',exact:true}).click();
 await expect(batch.getByRole('status').last()).toContainText('2 prêtes');
 await face.getByRole('button',{name:'Utiliser les cadrages proposés (1)',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/face-detection-batch-fr.png'});
 await batch.getByRole('button',{name:'Synchroniser 2 répliques',exact:true}).click();
 const selection=await page.evaluate(()=>(window as any).__pendingLipBatch);
 expect(Object.keys(selection.crops)).toHaveLength(2);expect(selection.crops[before.dialogues[0].id].face.x).toBeCloseTo(.3,1);expect(selection.crops[before.dialogues[1].id].face.x).toBe(.15);
 const after=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));expect(after.media).toEqual(before.media);expect(after.generations).toEqual(before.generations);
});
test('cancelled and stale face detection cannot apply late crops or change the project',async({page})=>{
 const panel=await open(page),face=panel.locator('.face-detection-action');
 const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
 await face.getByRole('combobox',{name:'Type de détection des visages'}).selectOption('anime');
 await face.getByRole('button',{name:'Détecter les visages du lot',exact:true}).click();
 await face.getByRole('button',{name:'Annuler',exact:true}).click();await page.evaluate(()=>(window as any).__completeFaceDetection());
 await expect(face.getByRole('button',{name:/Utiliser les cadrages proposés/})).toHaveCount(0);
 expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!)))).toEqual(before);
 await face.getByRole('button',{name:'Détecter les visages du lot',exact:true}).click();await page.evaluate(()=>(window as any).__completeFaceDetection());
 await expect(face.getByRole('status')).toContainText('Propositions : 4');
 await page.evaluate(()=>(window as any).__moveFirstDubbing(100));
 await expect(face.getByRole('status')).toContainText('Propositions : 0');
 await expect(face.getByRole('button',{name:'Utiliser les cadrages proposés (0)',exact:true})).toBeDisabled();
});
