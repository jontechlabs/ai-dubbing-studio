import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
async function setup(page: Page) {
  const p = demoProject();
  p.characters = [
    { id: 'alpha', name: 'Alice', color: '#a48bd4', references: [], defaultReferenceId: null },
    { id: 'beta', name: 'Bob', color: '#82bda0', references: [], defaultReferenceId: null },
  ];
  p.dialogues.forEach((l, i) => (l.characterId = i === 3 ? null : i === 1 ? 'beta' : 'alpha'));
  await nativeMock(page, false, p);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  return p;
}
const data = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function open(page: Page) {
  await page.getByRole('button', { name: 'Pistes de doublage', exact: true }).click();
  return page.getByRole('dialog', { name: 'Pistes de doublage', exact: true });
}
test('automatic character tracks follow character changes while manual main assignments survive reload and can return to auto', async ({
  page,
}) => {
  const before = await setup(page);
  const original = await data(page);
  let modal = await open(page);
  await modal
    .getByRole('checkbox', {
      name: 'Affecter automatiquement les dialogues par personnage',
      exact: true,
    })
    .check();
  await expect(modal.getByRole('textbox', { name: /Nom de la piste/ })).toHaveCount(3);
  await expect
    .poll(async () => (await data(page)).dubbingLanes?.assignments[before.dialogues[0].id])
    .toBe('character-1');
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.locator('.dialogue-card').first().getByRole('combobox').selectOption('beta');
  await expect
    .poll(async () => (await data(page)).dubbingLanes.assignments[before.dialogues[0].id])
    .toBe('character-2');
  modal = await open(page);
  await modal
    .getByRole('combobox', { name: 'Dialogue à affecter', exact: true })
    .selectOption(before.dialogues[0].id);
  await modal
    .getByRole('combobox', { name: 'Piste de doublage', exact: true })
    .selectOption('lane:main');
  await expect(modal.getByText('Affectation manuelle conservée.', { exact: false })).toBeVisible();
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.locator('.dialogue-card').first().getByRole('combobox').selectOption('alpha');
  await expect
    .poll(async () => (await data(page)).dubbingLanes.byCharacter.manualLineIds)
    .toContain(before.dialogues[0].id);
  await page.reload();
  await expect(
    page.locator('[data-track-id="dubbing-lane:main"] .dubbing-block').first(),
  ).toBeVisible();
  await page
    .locator('[data-track-id="dubbing-lane:main"] .dubbing-block')
    .first()
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', { name: 'Rétablir la piste du personnage', exact: true })
    .click();
  await expect
    .poll(async () => (await data(page)).dubbingLanes.assignments[before.dialogues[0].id])
    .toBe('character-1');
  expect((await data(page)).generations).toEqual(original.generations);
  expect((await data(page)).sourceCues).toEqual(original.sourceCues);
  expect((await data(page)).targetCues).toEqual(original.targetCues);
  modal = await open(page);
  await modal
    .getByRole('checkbox', {
      name: 'Affecter automatiquement les dialogues par personnage',
      exact: true,
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'docs/screenshots/character-lanes-fr.png' });
});
test('reuses a character track with its levels and reroutes manual choices only on explicit request', async ({
  page,
}) => {
  const before = await setup(page);
  await page.evaluate((id) => {
    const w = window as any,
      p = w.__getMockProject();
    p.formatVersion = 32;
    p.dubbingLanes = {
      sourcePath: p.media.path,
      lanes: [
        { id: 'main', name: 'Doublage 1', mute: false, solo: false, gain: 1 },
        { id: 'existing', name: 'Alice', mute: true, solo: false, gain: 1.75 },
      ],
      assignments: { [id]: 'existing' },
    };
    w.__loadMockProject(p);
  }, before.dialogues[0].id);
  const modal = await open(page);
  await modal
    .getByRole('checkbox', {
      name: 'Affecter automatiquement les dialogues par personnage',
      exact: true,
    })
    .check();
  await expect
    .poll(async () => {
      const p = await data(page);
      return p.dubbingLanes?.lanes.find((l: any) => l.id === 'existing');
    })
    .toMatchObject({ characterId: 'alpha', gain: 1.75, mute: true });
  await expect(modal.getByRole('textbox', { name: /Nom de la piste/ })).toHaveCount(3);
  await modal
    .getByRole('combobox', { name: 'Dialogue à affecter', exact: true })
    .selectOption(before.dialogues[0].id);
  await modal
    .getByRole('combobox', { name: 'Piste de doublage', exact: true })
    .selectOption('lane:main');
  await expect(
    modal.getByRole('button', { name: 'Réaffecter aussi les dialogues manuels', exact: true }),
  ).toBeEnabled();
  await modal
    .getByRole('button', { name: 'Réaffecter aussi les dialogues manuels', exact: true })
    .click();
  await expect
    .poll(async () => (await data(page)).dubbingLanes?.assignments[before.dialogues[0].id])
    .toBe('existing');
  await expect
    .poll(async () => (await data(page)).dubbingLanes.byCharacter.manualLineIds)
    .toEqual([]);
});
test('MCP project edits automatically route new character assignments and disabling the mode freezes them', async ({
  page,
}) => {
  const p = await setup(page);
  let modal = await open(page);
  await modal
    .getByRole('checkbox', {
      name: 'Affecter automatiquement les dialogues par personnage',
      exact: true,
    })
    .check();
  await expect.poll(async () => (await data(page)).formatVersion).toBe(33);
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Activer le pilotage MCP local', exact: true }).check();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  const patch = async (patches: unknown[]) =>
    page.evaluate(async (patches) => {
      const w = window as any,
        ctx = (await w.__mcp('studio_get_state', {})).context;
      return w.__mcp('studio_project_patch', { context: ctx, patches });
    }, patches);
  const r = await patch([{ op: 'replace', path: '/dialogues/3/characterId', value: 'beta' }]);
  expect(r.applied).toBe(true);
  await expect
    .poll(async () => (await data(page)).dubbingLanes.assignments[p.dialogues[3].id])
    .toBe('character-2');
  await patch([
    { op: 'replace', path: '/dubbingLanes/byCharacter/enabled', value: false },
    { op: 'replace', path: '/dialogues/3/characterId', value: 'alpha' },
  ]);
  expect((await data(page)).dubbingLanes.assignments[p.dialogues[3].id]).toBe('character-2');
  modal = await open(page);
  await expect(
    modal.getByRole('checkbox', {
      name: 'Affecter automatiquement les dialogues par personnage',
      exact: true,
    }),
  ).not.toBeChecked();
});
