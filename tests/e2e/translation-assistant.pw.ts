import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('translation filters intersect search and visible checkbox selection', async ({ page }) => {
  await nativeMock(page); await page.goto('/');
  const cards = page.locator('.dialogue-card'); await expect(cards.first()).toBeVisible();
  await page.evaluate(() => (window as any).__clearTranslation(0));
  await cards.nth(1).getByRole('button', {name:'Valider la traduction de la réplique 2',exact:true}).click();
  const filter=page.getByRole('combobox',{name:'Statut de traduction',exact:true});
  await filter.selectOption('untranslated');await expect(cards).toHaveCount(1);await expect(cards.first()).toHaveClass(/translation-untranslated/);
  await filter.selectOption('approved');await expect(cards).toHaveCount(1);await expect(cards.first()).toHaveClass(/translation-approved/);
  await page.getByRole('button',{name:'Tout cocher (filtre actuel)',exact:true}).click();
  await expect(cards.first().getByRole('checkbox')).toBeChecked();
  await filter.selectOption('translated');await expect(cards).toHaveCount(2);
  await page.getByPlaceholder('Rechercher une réplique…').fill('absentxyz');await expect(cards).toHaveCount(0);
  await page.getByPlaceholder('Rechercher une réplique…').fill('');await expect(cards).toHaveCount(2);
  await filter.selectOption('all');await expect(cards).toHaveCount(4);
});

test('approved-only batch intersects selection and force without dubbing pending translations', async ({page}) => {
  await nativeMock(page);await page.goto('/');const cards=page.locator('.dialogue-card');await expect(cards.first()).toBeVisible();
  await cards.first().getByRole('button',{name:'Valider la traduction de la réplique 1',exact:true}).click();
  await page.getByRole('button',{name:'Tout cocher (filtre actuel)',exact:true}).click();
  await page.getByRole('button',{name:/Doublage par lot/}).click();const panel=page.getByRole('dialog',{name:'Doublage par lot',exact:true});
  await panel.getByRole('combobox',{name:'Référence vocale',exact:true}).selectOption('current');
  await panel.getByRole('checkbox',{name:'Uniquement les traductions validées',exact:true}).check();
  await panel.getByRole('checkbox',{name:/Forcer un nouvel essai/}).check();
  await expect(panel.getByText(/1 à générer .*3 non validées/)).toBeVisible();
  await panel.getByRole('button',{name:'Doubler 1 répliques',exact:true}).click();
  const pending=await page.evaluate(()=>(window as any).__pendingBatch);
  expect(pending).toMatchObject({scope:'selected',approvedOnly:true,force:true});
  expect(await page.evaluate(()=>(window as any).__batchRows)).toHaveLength(1);
});

test('local proposal is editable, leaves subtitles unchanged until applying, and is never auto-approved',async({page})=>{
  await page.setViewportSize({width:1440,height:1800});
  await nativeMock(page);await page.goto('/');const card=page.locator('.dialogue-card').first();await expect(card).toBeVisible();
  await card.locator('.line-select').click();await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Périphérique de traduction'})).toHaveValue('Vulkan1');
  const field=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true}),before=await field.inputValue();
  await page.getByRole('button',{name:'Proposer une traduction',exact:true}).click();await expect(page.getByText('Proposition de traduction en cours',{exact:true})).toBeVisible();
  await expect(field).toHaveValue(before);await page.evaluate(()=>(window as any).__completeTranslation());
  const proposal=page.getByRole('textbox',{name:'Proposition de sous-titre 1',exact:true});await expect(proposal).toHaveValue('Une traduction proposée.');
  await proposal.fill('Une proposition corrigée.');await expect(field).toHaveValue(before);
  await page.locator('.editor').evaluate((e)=>e.scrollTop=0);await page.screenshot({path:'docs/screenshots/translation-assistant.png'});
  await page.getByRole('button',{name:'Appliquer la proposition',exact:true}).click();await expect(field).toHaveValue('Une proposition corrigée.');await expect(card).toHaveClass(/translation-translated/);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await page.evaluate(()=>JSON.parse(localStorage.getItem('nativeMockProject')!))).translationApprovals??{}).toEqual({});

});

test('text edits during translation block stale proposals and cancellation allows a new request',async({page})=>{
  await nativeMock(page);await page.goto('/');await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();await page.getByRole('button',{name:'Proposer une traduction',exact:true}).click();
  const field=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true});await field.fill('Correction pendant la génération.');
  await page.evaluate(()=>(window as any).__completeTranslation());await expect(page.getByRole('button',{name:'Appliquer la proposition',exact:true})).toBeDisabled();
  await expect(field).toHaveValue('Correction pendant la génération.');
  await page.getByRole('button',{name:'Proposer une traduction',exact:true}).click();await page.locator('.translation-suggestion').getByRole('button',{name:'Annuler',exact:true}).click();
  await expect(page.getByRole('button',{name:'Proposer une traduction',exact:true})).toBeEnabled();await page.evaluate(()=>(window as any).__completeTranslation());
  await expect(field).toHaveValue('Correction pendant la génération.');
});

test('translation installation checks disk first and offers the installed model after completion',async({page})=>{
  await nativeMock(page);await page.goto('/');await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(()=>{(window as any).__llmReady=false;(window as any).__llmSpace=1024;});
  await page.locator('.dialogue-card').first().locator('.line-select').click();await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();
  await expect(page.getByRole('button',{name:'Installer le modèle de traduction',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).__calls.some((c:any)=>c.command==='install_translation_model'))).toBe(false);
  await page.evaluate(()=>(window as any).__llmSpace=10*1024**3);
  await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();
  await page.getByRole('button',{name:'Installer le modèle de traduction',exact:true}).click();
  await page.evaluate(()=>(window as any).__completeTranslationInstall());
  await expect(page.getByRole('button',{name:'Proposer une traduction',exact:true})).toBeEnabled();
});

test('translation direction is sent explicitly, retained on this PC and shown with its unapplied proposal',async({page})=>{
  await page.setViewportSize({width:1440,height:1800});
  await nativeMock(page); await page.goto('/');
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();
  const direction='Phrase prononcée par un méchant, il est vulgaire. La longueur de la réplique traduite doit correspondre à la source.';
  const input=page.getByRole('textbox',{name:'Orientation de traduction (facultatif)',exact:true});
  await input.fill(direction);
  const translated=page.getByRole('textbox',{name:'Sous-titre affiché',exact:true}), before=await translated.inputValue();
  await page.getByRole('button',{name:'Proposer une traduction',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__pendingTranslation.direction)).toBe(direction);
  await expect(input).toBeDisabled(); await expect(translated).toHaveValue(before);
  await page.evaluate(()=>(window as any).__completeTranslation(['Tu vas payer, sale idiot !']));
  await expect(page.getByText('Orientation utilisée : '+direction,{exact:true})).toBeVisible();
  await expect(translated).toHaveValue(before);
  await page.locator('.editor').evaluate(e=>e.scrollTop=0);
  await page.screenshot({path:'docs/screenshots/translation-direction-fr.png'});
  await page.reload(); await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button',{name:'Aide à la traduction',exact:true}).click();
  await expect(input).toHaveValue(direction);
  await input.fill(''); await page.getByRole('button',{name:'Proposer une traduction',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__pendingTranslation.direction)).toBe('');
});
