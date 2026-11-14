import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('mockMcpEnabled', 'true'));
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
  });
}
async function batch(page: Page) {
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  return panel;
}
const saved = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
test('queues a frozen selected separation/dubbing workflow with exact routing and three retained-model takes', async ({
  page,
}) => {
  await setup(page);
  await page.locator('.dialogue-check').nth(0).check();
  await page.locator('.dialogue-check').nth(1).check();
  const before = await saved(page),
    p = await batch(page),
    c = p.locator('.workflow-composer');
  await p.getByRole('combobox', { name: 'Essais par réplique', exact: true }).selectOption('3');
  await p.getByRole('spinbutton', { name: 'Graine', exact: true }).fill('7');
  await c
    .getByRole('combobox', { name: 'Actions du lot', exact: true })
    .selectOption('separateDub');
  await expect(c.getByRole('combobox', { name: 'Outil de séparation', exact: true })).toBeEnabled();
  await c.getByRole('checkbox', { name: 'Accompagnement → piste Musique', exact: true }).check();
  await c
    .getByRole('combobox', { name: 'Piste source à isoler', exact: true })
    .selectOption('original');
  await c
    .getByRole('combobox', { name: 'Périphérique de génération', exact: true })
    .selectOption('cuda:0');
  await c
    .getByRole('textbox', { name: 'Nom de la tâche (facultatif)', exact: true })
    .fill('Isoler puis doubler');
  await c.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
  await expect(c.getByRole('status').filter({ hasText: 'Tâche ajoutée' })).toBeVisible();
  const q = await page.evaluate(() => (window as any).__getWorkflowQueue()),
    spec = await page.evaluate(() => (window as any).__workflowSpecs['workflow-1']);
  expect(spec.selection.lineIds).toEqual(before.dialogues.slice(0, 2).map((l: any) => l.id));
  expect(spec.selection.takeCount).toBe(3);
  expect(spec.selection.options.seed).toBe(7);
  expect(spec.separation).toEqual({
    modelId: 'mel-band-roformer-kim',
    sourceTrackId: 'original',
    device: 'cuda:0',
    windowSeconds: 4,
    vocals: true,
    music: true,
    muteSource: false,
  });
  expect(spec.dubbing).toBe(true);
  expect(q.entries[0].status).toBe('pending');
  expect((await saved(page)).generations).toEqual(before.generations);
  expect((await saved(page)).sourceCues).toEqual(before.sourceCues);
  await c.screenshot({ path: 'docs/screenshots/workflow-composer-fr.png' });
});
test('another batch can be configured and queued while a workflow runs, preserving each configuration', async ({
  page,
}) => {
  await setup(page);
  const p = await batch(page),
    c = p.locator('.workflow-composer');
  await c.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
  await expect(c).toContainText('Tâche ajoutée');
  await page.evaluate(() => {
    const w = window as any,
      q = w.__getWorkflowQueue();
    q.entries[0].status = 'running';
    q.entries[0].stage = 'dubbing';
    w.__setWorkflowQueue(q);
  });
  await expect(p.getByRole('button', { name: /^Doubler \d+ répliques$/ })).toBeDisabled();
  await p.getByRole('spinbutton', { name: 'Graine', exact: true }).fill('42');
  await c
    .getByRole('textbox', { name: 'Nom de la tâche (facultatif)', exact: true })
    .fill('Autre réglage');
  await c.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__getWorkflowQueue().entries.length))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).__workflowSpecs['workflow-1'].selection.options.seed),
  ).not.toBe(42);
  expect(
    await page.evaluate(() => (window as any).__workflowSpecs['workflow-2'].selection.options.seed),
  ).toBe(42);
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});
test('queue controls reorder, cancel and clear tasks, persist across reload and are exposed through MCP', async ({
  page,
}) => {
  await setup(page);
  const p = await batch(page),
    c = p.locator('.workflow-composer');
  for (const name of ['Premier', 'Deuxième']) {
    await c.getByRole('textbox', { name: 'Nom de la tâche (facultatif)', exact: true }).fill(name);
    await c.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__getWorkflowQueue().entries.length))
      .toBe(name === 'Premier' ? 1 : 2);
  }
  await c.getByRole('button', { name: 'File des tâches', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'File des tâches', exact: true });
  await modal.getByRole('button', { name: 'Pause après le lot courant', exact: true }).click();
  await modal
    .locator('[data-queue-id="workflow-2"]')
    .getByRole('button', { name: 'Avancer la tâche dans la file', exact: true })
    .click();
  await expect(modal.locator('.queue-entry').first()).toContainText('Deuxième');
  await modal
    .locator('[data-queue-id="workflow-1"]')
    .getByRole('button', { name: 'Annuler cette tâche', exact: true })
    .click();
  await expect(modal.locator('[data-queue-id="workflow-1"]')).toContainText('Annulé');
  await modal.screenshot({ path: 'docs/screenshots/task-queue-fr.png' });
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.getByRole('button', { name: /^File des tâches/ }).click();
  await expect(modal.getByRole('button', { name: 'Reprendre la file', exact: true })).toBeEnabled();
  await expect(modal.locator('.queue-entry').first()).toContainText('Deuxième');
  const result = await page.evaluate(
    async () => await (window as any).__mcp('studio_task_queue_status', {}),
  );
  expect(result.paused).toBe(true);
  expect(result.entries).toHaveLength(2);
  await modal.getByRole('button', { name: 'Retirer l’historique terminé', exact: true }).click();
  await expect(modal.locator('.queue-entry')).toHaveCount(1);
});
test('separation-only routing may target music alone and does not require a dubbing take', async ({
  page,
}) => {
  await setup(page);
  const before = await saved(page),
    p = await batch(page),
    c = p.locator('.workflow-composer');
  await c.getByRole('combobox', { name: 'Actions du lot', exact: true }).selectOption('separate');
  await c.getByRole('checkbox', { name: 'Voix isolées → piste Voix', exact: true }).uncheck();
  await expect(c.getByRole('button', { name: 'Ajouter à la file', exact: true })).toBeDisabled();
  await c.getByRole('checkbox', { name: 'Accompagnement → piste Musique', exact: true }).check();
  await c.getByRole('button', { name: 'Ajouter à la file', exact: true }).click();
  await expect(c).toContainText('Tâche ajoutée');
  const spec = await page.evaluate(() => (window as any).__workflowSpecs['workflow-1']);
  expect(spec.dubbing).toBe(false);
  expect(spec.separation.vocals).toBe(false);
  expect(spec.separation.music).toBe(true);
  expect((await saved(page)).generations).toEqual(before.generations);
});
