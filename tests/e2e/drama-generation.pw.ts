import {test,expect} from '@playwright/test';
import {nativeMock} from './nativeMock';

test('Drama FP8 exposes verified install size and the RAM offload profile',async({page})=>{
 await nativeMock(page);await page.goto('/');await page.getByRole('button',{name:'Modèles',exact:true}).click();
 const panel=page.getByRole('dialog',{name:'Modèles'});
 const card=panel.locator('.model-card').filter({has:page.getByRole('heading',{name:'Fish Audio Drama 3 · FP8 · experts en RAM',exact:true})});
 await expect(card.getByText(/37.39 GiB/)).toBeVisible();await expect(card.getByText(/cache GPU plafonné à 4 Gio/)).toBeVisible();await expect(card.getByText(/Fish Audio Community License/)).toBeVisible();
 await card.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/drama3-install.png'});
 await card.getByRole('button',{name:'Vérifier / réparer cette variante'}).click();
 expect(await page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='install_voice_runtime'&&c.args.variantId==='drama3-comfy-fp8'))).toBe(true);
});

test('Drama uses the selected CUDA GPU, exact transcript and mood, then retains a distinct take',async({page})=>{
 await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();
 const panel=page.getByRole('dialog',{name:'Doublage'});
 await panel.getByRole('combobox',{name:'Moteur et variante de voix'}).selectOption('drama3-comfy-fp8');
 await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
 await panel.getByRole('combobox',{name:'Périphérique de génération'}).selectOption('cuda:0');
 await expect(panel.getByRole('combobox',{name:'Périphérique de génération'}).locator('option[value="cpu"]')).toHaveCount(0);
 const mood=panel.getByRole('combobox',{name:'Humeur'});await mood.selectOption('happy');
 await expect(panel.getByRole('combobox',{name:'Mode de clonage'})).toHaveValue('zeroShot');
 await page.screenshot({path:'docs/screenshots/drama3-generation.png'});
 await panel.getByRole('button',{name:'Générer un nouvel essai',exact:true}).click();
 const request=await page.evaluate(()=>(window as any).__pendingTts);expect(request.options).toMatchObject({variantId:'drama3-comfy-fp8',device:'cuda:0',mode:'zeroShot',mood:'happy'});
 await page.evaluate(()=>(window as any).__completeTts());
 await page.getByRole('button',{name:'Fermer',exact:true}).click();
 await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
 await expect(panel.locator('.generation-card')).toHaveCount(1);
 const generation=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!).generations.find((g:any)=>g.kind==='tts'));
 expect(generation.providerId).toBe('fish-drama3');expect(generation.modelId).toBe('drama3-comfy-fp8');
});
