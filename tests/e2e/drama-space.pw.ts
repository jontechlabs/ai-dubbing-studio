import {test,expect} from '@playwright/test';
import {nativeMock} from './nativeMock';
test('Drama checks free space before enabling installation and refreshes after space is freed',async({page})=>{
 await nativeMock(page);await page.goto('/');await page.evaluate(()=>{(window as any).__dramaReady=false;(window as any).__dramaSpace={path:'F:/AI/models/voice-engines',availableBytes:8*1024**3,requiredBytes:40144065412+18*1024**3,modelBytes:40144065412,downloadBytes:4*1024**3,runtimeBytes:12*1024**3,marginBytes:2*1024**3,enough:false};});
 await page.getByRole('button',{name:'Modèles',exact:true}).click();const card=page.locator('.drama-models');
 await expect(card.getByText('F:/AI/models/voice-engines')).toBeVisible();await expect(card.getByText(/Disponibles : 8.00 Gio/)).toBeVisible();await expect(card.getByRole('button',{name:'Installer Drama 3 FP8',exact:true})).toBeDisabled();
 await card.locator('.drama-space').scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/drama3-space.png'});
 expect(await page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='install_voice_runtime'))).toBe(false);
 await page.evaluate(()=>{Object.assign((window as any).__dramaSpace,{availableBytes:70*1024**3,enough:true});});
 await card.getByRole('button',{name:'Vérifier l’espace disque',exact:true}).click();await expect(card.getByRole('button',{name:'Installer Drama 3 FP8',exact:true})).toBeEnabled();
 // Capacity can change after the displayed check. Clicking must recheck it.
 await page.evaluate(()=>{(window as any).__dramaSpace.enough=false;});await card.getByRole('button',{name:'Installer Drama 3 FP8',exact:true}).click();
 await expect(card.getByRole('button',{name:'Installer Drama 3 FP8',exact:true})).toBeDisabled();expect(await page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='install_voice_runtime'))).toBe(false);
});
test('an unavailable storage drive fails closed and exposes a retry',async({page})=>{
 await nativeMock(page);await page.goto('/');await page.evaluate(()=>(window as any).__spaceError=true);await page.getByRole('button',{name:'Modèles',exact:true}).click();const card=page.locator('.drama-models');
 await expect(card.getByText(/Impossible de vérifier/)).toBeVisible();await expect(card.getByRole('button',{name:'Vérifier / réparer Drama 3 FP8'})).toBeDisabled();
 await page.evaluate(()=>(window as any).__spaceError=false);await card.getByRole('button',{name:'Vérifier l’espace disque',exact:true}).click();await expect(card.getByRole('button',{name:'Vérifier / réparer Drama 3 FP8'})).toBeEnabled();
});
