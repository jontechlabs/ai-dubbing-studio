import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';
test('add dialogue validates a timed source/translation and selects it without changing existing lines or takes', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.getByRole('button', { name: 'Ajouter une réplique', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Ajouter une réplique', exact: true });
  await modal
    .getByRole('textbox', { name: 'Début de la nouvelle réplique', exact: true })
    .fill('00:00:03.500');
  await modal
    .getByRole('textbox', { name: 'Fin de la nouvelle réplique', exact: true })
    .fill('00:00:04.000');
  await modal
    .getByRole('textbox', { name: 'Texte original de la nouvelle réplique', exact: true })
    .fill('日本語の追加');
  await modal
    .getByRole('textbox', { name: 'Traduction de la nouvelle réplique', exact: true })
    .fill('Une réplique ajoutée.');
  await page.screenshot({ path: 'docs/screenshots/dialogue-add-fr.png' });
  await modal.getByRole('button', { name: 'Ajouter une réplique', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Sous-titre affiché', exact: true })).toHaveValue(
    'Une réplique ajoutée.',
  );
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.dialogues).toHaveLength(before.dialogues.length + 1);
  for (const line of before.dialogues)
    expect(after.dialogues.find((l: any) => l.id === line.id)).toEqual(line);
  expect(after.generations).toEqual(before.generations);
  expect(after.media).toEqual(before.media);
  await page.getByRole('button', { name: 'Ctrl+Z', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__getMockProject().dialogues.length))
    .toBe(before.dialogues.length);
});
test('right-click exclusion preserves both SRTs and all takes, survives reload and is undoable and restorable', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => (window as any).__getMockProject()),
    id = before.dialogues[0].id;
  await page.locator('.dialogue-card').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Exclure du doublage', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Exclure du doublage', exact: true });
  await expect(modal).toContainText('Les sous-titres source et traduits restent inchangés.');
  await modal.getByRole('button', { name: 'Exclure du doublage', exact: true }).click();
  await expect(page.locator('.dialogue-card')).toHaveCount(3);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.dialogues.find((l: any) => l.id === id).excludedFromDubbing).toBe(true);
  for (const field of ['sourceCues', 'targetCues', 'generations', 'voiceEdits', 'media'])
    expect(after[field]).toEqual(before[field]);
  await page.getByRole('button', { name: 'Ctrl+Z', exact: true }).click();
  await expect(page.locator('.dialogue-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'Ctrl+Y', exact: true }).click();
  await page.reload();
  await expect(page.locator('.dialogue-card')).toHaveCount(3);
  await page
    .getByRole('checkbox', { name: 'Afficher les répliques exclues (1)', exact: true })
    .check();
  await expect(page.locator('.dialogue-card')).toHaveCount(4);
  await page.locator('.dialogue-card.dialogue-excluded').scrollIntoViewIfNeeded();
  await expect(page.locator('.job-notifications')).not.toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/dialogue-exclusion-fr.png' });
  await page
    .locator('.dialogue-card.dialogue-excluded')
    .getByRole('button', { name: 'Réintégrer au doublage', exact: true })
    .click();
  await expect(page.locator('.dialogue-card.dialogue-excluded')).toHaveCount(0);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await page.evaluate(() => (window as any).__getMockProject())).generations).toEqual(
    before.generations,
  );
});
test('common review is withdrawn by spoken-text editing and a new selected take, retaining every earlier take', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const card = page.locator('.dialogue-card').first();
  await card
    .getByRole('button', { name: 'Valider la traduction de la réplique 1', exact: true })
    .click();
  await expect(card).toHaveClass(/translation-approved/);
  await card.locator('.line-select').click();
  await page.getByRole('button', { name: 'Prononciation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Texte pour la voix', exact: true })
    .fill('Une nouvelle diction.');
  await expect(card).toHaveClass(/translation-translated/);
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const p = await page.evaluate(() => (window as any).__getMockProject());
  expect(p.dialogues[0].status).toBe('review');
  expect(p.translationApprovals[p.dialogues[0].id]).toBeUndefined();
  expect(p.generations).toHaveLength(4);
});
