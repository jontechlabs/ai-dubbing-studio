import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';

async function ready(page: Page) {
  const p = addCharacter(addCharacter(demoProject(), 'Speaker A'), 'Speaker B');
  p.formatVersion = 26;
  p.characters.forEach((c, i) => {
    c.references = [
      {
        id: `ref-${i}`,
        label: c.name,
        path: `characters/ref-${i}.wav`,
        durationMs: 2000,
        transcript: 'Référence.',
      },
    ];
    c.defaultReferenceId = `ref-${i}`;
    p.dialogues[i].characterId = c.id;
  });
  p.characterProfiles = { [p.characters[0].id]: { gender: 'man' } };
  p.speakerAnalysis = {
    id: 'analysis',
    sourcePath: p.media!.path,
    lines: p.dialogues.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    assignments: p.dialogues.map((line) => ({
      dialogueId: line.id,
      speaker: 0,
      similarity: 0.9,
      reason: 'identified',
    })),
    clusters: [
      {
        speaker: 0,
        referencePath: 'characters/ref-0.wav',
        durationMs: 2000,
        referenceDialogueId: p.dialogues[0].id,
      },
    ],
  };
  await nativeMock(page, false, p);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  return p;
}
const data = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function openReset(page: Page) {
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page.getByRole('button', { name: 'Remettre les locuteurs à zéro', exact: true }).click();
  return page.getByRole('dialog', { name: 'Remettre les locuteurs à zéro', exact: true });
}

test('cancel leaves everything intact; default reset preserves profiles, references and all takes, with undo', async ({
  page,
}) => {
  await ready(page);
  const before = await data(page);
  let modal = await openReset(page);
  await expect(
    modal.getByRole('radio', {
      name: 'Conserver les fiches, vignettes et références vocales',
      exact: true,
    }),
  ).toBeChecked();
  await modal.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(await data(page)).toEqual(before);
  await page.getByRole('button', { name: 'Remettre les locuteurs à zéro', exact: true }).click();
  modal = page.getByRole('dialog', { name: 'Remettre les locuteurs à zéro', exact: true });
  await modal.getByRole('button', { name: 'Confirmer la remise à zéro', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const after = await data(page);
  expect(after.speakerAnalysis).toBeNull();
  expect(after.dialogues.every((line: any) => line.characterId === null)).toBe(true);
  for (const key of [
    'characters',
    'characterProfiles',
    'generations',
    'targetCues',
    'sourceCues',
    'tracks',
  ])
    expect(after[key]).toEqual(before[key]);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await data(page)).dialogues.map((l: any) => l.characterId))
    .toEqual(before.dialogues.map((l: any) => l.characterId));
  expect((await data(page)).characters).toEqual(before.characters);
});

test('explicit full reset removes character records but keeps dubbing, subtitle and track history after reload', async ({
  page,
}) => {
  await ready(page);
  const before = await data(page),
    modal = await openReset(page);
  await modal
    .getByRole('radio', {
      name: 'Retirer aussi les fiches, vignettes et références des personnages du projet',
      exact: true,
    })
    .check();
  await modal.getByRole('button', { name: 'Confirmer la remise à zéro', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  let after = await data(page);
  expect(after.characters).toEqual([]);
  expect(after.characterProfiles).toBeUndefined();
  for (const key of ['generations', 'targetCues', 'sourceCues', 'tracks'])
    expect(after[key]).toEqual(before[key]);
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  after = await data(page);
  expect(after.characters).toEqual([]);
  expect(after.generations).toEqual(before.generations);
  expect(after.dialogues.every((line: any) => line.characterId === null)).toBe(true);
});

test('a running identification disables an already-open reset confirmation', async ({ page }) => {
  await ready(page);
  const modal = await openReset(page),
    before = await data(page);
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('identify_speakers', {
      threshold: 0.75,
      scope: null,
    }),
  );
  await expect(
    modal.getByRole('button', { name: 'Confirmer la remise à zéro', exact: true }),
  ).toBeDisabled();
  expect(await data(page)).toEqual(before);
});

test('MCP speaker reset rejects active work and stale context, then supports both modes with undo', async ({
  page,
}) => {
  await ready(page);
  await expect.poll(() => page.evaluate(() => (window as any).__mcpReady)).toBe(true);
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page
    .getByRole('region', { name: 'Contrôle IA / MCP', exact: true })
    .getByRole('checkbox', { name: 'Activer le pilotage MCP local', exact: true })
    .check();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  const call = (tool: string, args: unknown = {}) =>
    page.evaluate(({ tool, args }) => (window as any).__mcp(tool, args), { tool, args });
  const context = (await call('studio_get_state')).context,
    before = await data(page);
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('identify_speakers', {
      threshold: 0.75,
      scope: null,
    }),
  );
  expect((await call('studio_reset_speakers', { context, mode: 'characters' })).error).toContain(
    'BUSY',
  );
  await page.evaluate(() => (window as any).__completeSpeakerAnalysis());
  expect((await call('studio_reset_speakers', { context, mode: 'assignments' })).error).toContain(
    'STALE_REVISION',
  );
  const live = (await call('studio_get_state')).context;
  expect(
    (await call('studio_reset_speakers', { context: live, mode: 'assignments' })).applied,
  ).toBe(true);
  expect((await data(page)).characters).toEqual(before.characters);
  expect((await data(page)).dialogues.every((l: any) => !l.characterId)).toBe(true);
  expect(
    (
      await call('studio_reset_speakers', {
        context: (await call('studio_get_state')).context,
        mode: 'characters',
      })
    ).applied,
  ).toBe(true);
  expect((await data(page)).characters).toEqual([]);
  await call('studio_history', {
    context: (await call('studio_get_state')).context,
    direction: 'undo',
  });
  expect((await data(page)).characters).toEqual(before.characters);
  expect((await data(page)).generations).toEqual(before.generations);
});
