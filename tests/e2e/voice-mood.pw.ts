import {test,expect} from '@playwright/test';
import {nativeMock} from './nativeMock';

test('mood is dispatched and saved for CosyVoice and both Fish backends, while Qwen Base disables it',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().getByRole('button',{name:'Doubler',exact:true}).click();const panel=page.getByRole('dialog',{name:'Doublage'});
  await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
  const mood=panel.getByRole('combobox',{name:'Humeur / interprétation',exact:true}),engine=panel.getByRole('combobox',{name:'Moteur et variante de voix'});
  await expect(mood).toHaveValue('default');await mood.selectOption('angry');await expect(panel.getByRole('combobox',{name:'Mode de clonage'})).toBeDisabled();
  await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();let args=await page.evaluate(()=>(window as any).__pendingTts);expect(args.options.mood).toBe('angry');expect(args.options.mode).toBe('crossLingual');
  await page.evaluate(()=>(window as any).__completeTts());await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  await expect(panel.locator('.generation-card').getByText('En colère',{exact:false})).toBeVisible();
  for(const variant of ['fish-s2-fp8','fish-s2-gguf-q8']){
    await engine.selectOption(variant);await mood.selectOption('happy');await panel.getByRole('button',{name:'Générer un nouvel essai'}).click();args=await page.evaluate(()=>(window as any).__pendingTts);expect(args.options.mood).toBe('happy');expect(args.options.mode).toBe('zeroShot');
    await page.evaluate(()=>(window as any).__completeTts());await page.getByRole('button',{name:'Fermer',exact:true}).click();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();
  }
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');await page.reload();await page.locator('.dialogue-card').first().getByRole('button',{name:'Régénérer',exact:true}).click();await expect(mood).toHaveValue('happy');
  await mood.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/screenshots/voice-mood.png'});
  await engine.selectOption('qwen3-06b-gguf-q8');await expect(mood).toHaveValue('default');await expect(mood).toBeDisabled();await expect(panel.getByText(/variantes Qwen3-TTS Base intégrées/)).toBeVisible();
});
