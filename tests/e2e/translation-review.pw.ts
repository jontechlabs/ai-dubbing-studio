import {test, expect} from '@playwright/test';
import {nativeMock} from './nativeMock';

test('translation colours distinguish empty, translated and explicitly approved text and persist after reload',async({page})=>{
  await page.setViewportSize({width:1440,height:1440});await nativeMock(page);await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(()=>(window as any).__clearTranslation(0));
  const cards=page.locator('.dialogue-card');
  await expect(cards.nth(0)).toHaveClass(/translation-untranslated/);
  await expect(cards.nth(1)).toHaveClass(/translation-translated/);
  await cards.nth(1).getByRole('button',{name:'Valider la traduction de la réplique 2',exact:true}).click();
  await expect(cards.nth(1)).toHaveClass(/translation-approved/);
  await expect(cards.nth(0)).toHaveCSS('border-left-color','rgb(125, 132, 145)');
  await expect(cards.nth(1)).toHaveCSS('border-left-color','rgb(32, 183, 99)');
  await expect(cards.nth(2)).toHaveCSS('border-left-color','rgb(184, 232, 186)');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.locator('.dialogues-pane').screenshot({path:'docs/screenshots/translation-review.png'});
  await page.reload();await expect(cards.nth(1)).toHaveClass(/translation-approved/);
  await cards.nth(1).getByRole('button',{name:'Retirer la validation de la traduction de la réplique 2',exact:true}).click();
  await expect(cards.nth(1)).toHaveClass(/translation-translated/);
});

test('editing a translation revokes its approval while voice status remains separate',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(()=>(window as any).__seedDubbing());
  const card=page.locator('.dialogue-card').first();
  await card.getByRole('button',{name:'Valider la traduction de la réplique 1',exact:true}).click();
  await expect(card).toHaveClass(/translation-approved/);
  await card.locator('.line-select').click();
  const translation=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true});
  await translation.fill('Une traduction corrigée.');
  await expect(card).toHaveClass(/translation-translated/);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const p=await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(p.translationApprovals?.[p.dialogues[0].id]).toBeUndefined();
  expect(p.generations.filter((g:any)=>g.kind==='tts')).toHaveLength(4);
  await page.reload();await expect(card).toHaveClass(/translation-translated/);
});
