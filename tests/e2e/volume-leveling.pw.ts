import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { dubbingLevelingScope } from '../../src/domain/volumeLeveling';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('studio.timelineHeight', '420');
    localStorage.setItem('mockMcpEnabled', 'true');
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sinkId: { type: 'none' } } as AudioContextOptions);
      }
    };
  });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
});
const saved = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function select(page: Page, id = 'speech', start = 1200, end = 3000) {
  const tool = page.getByRole('button', {
    name: 'Sélectionner une zone audio (ou Maj + glisser)',
    exact: true,
  });
  if (!(await tool.getAttribute('class'))?.split(' ').includes('active')) await tool.click();
  const row = page.locator(`.timeline-track.audio[data-track-id="${id}"]`);
  await row.scrollIntoViewIfNeeded();
  const b = (await row.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.2, b.y + b.height / 2);
  await page.mouse.up();
  const controls = page.getByRole('group', { name: 'Réglage de la sélection audio', exact: true });
  for (const [name, v] of [
    ['Début de la zone audio (ms)', start],
    ['Fin de la zone audio (ms)', end],
  ] as const) {
    const input = controls.getByRole('spinbutton', { name, exact: true });
    await input.fill(String(v));
    await input.press('Enter');
  }
  await row.getByRole('button', { name: /Redimensionner le début/ }).click({ button: 'right' });
  return { row, controls };
}
async function open(page: Page, id = 'speech') {
  await select(page, id);
  await page.getByRole('menuitem', { name: 'Égaliser le volume…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Égaliser le volume de la sélection', exact: true });
}
test('compare both previews before explicit application; only the selected range changes and selection clears', async ({
  page,
}) => {
  const modal = await open(page);
  const before = await saved(page);
  await expect(modal.getByRole('combobox', { name: 'Niveau cible' })).toHaveValue('low');
  await expect(modal.getByRole('button', { name: 'Valider et appliquer' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await expect(modal.getByRole('region', { name: 'Traitement de cette opération' })).toBeVisible();
  expect((await saved(page)).generations).toEqual(before.generations);
  await page.evaluate(() => (window as any).__completeLeveling());
  const a = modal.locator('audio[aria-label="Avant égalisation"]'),
    b = modal.locator('audio[aria-label="Après égalisation"]');
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  await a.evaluate((e: HTMLAudioElement) => e.play());
  await expect.poll(() => a.evaluate((e: HTMLAudioElement) => e.paused)).toBe(false);
  await b.evaluate((e: HTMLAudioElement) => e.play());
  await expect.poll(() => a.evaluate((e: HTMLAudioElement) => e.paused)).toBe(true);
  await expect.poll(() => b.evaluate((e: HTMLAudioElement) => e.paused)).toBe(false);
  expect(await page.locator('video').evaluate((e: HTMLVideoElement) => e.paused)).toBe(true);
  expect((await saved(page)).generations).toEqual(before.generations);
  await modal.getByRole('button', { name: 'Valider et appliquer' }).click();
  await expect(modal).not.toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Réglage de la sélection audio', exact: true }),
  ).not.toBeVisible();
  const after = await saved(page);
  expect(after.generations.length).toBe(before.generations.length + 1);
  expect(after.generations.at(-1)).toMatchObject({
    operation: 'leveling',
    trackId: 'speech',
    startMs: 1200,
    endMs: 3000,
    mode: 'replace',
  });
  expect(after.tracks).toEqual(before.tracks);
  expect(after.dialogues).toEqual(before.dialogues);
  expect(after.sourceCues).toEqual(before.sourceCues);
});
test('changing target invalidates the previous preview and cancelled windows preserve their selection', async ({
  page,
}) => {
  const modal = await open(page, 'music'),
    before = await saved(page);
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(modal.locator('audio')).toHaveCount(2);
  const first = await page.evaluate(() => (window as any).__levelingId);
  await modal.getByRole('combobox', { name: 'Niveau cible' }).selectOption('high');
  await expect(modal.locator('audio')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Valider et appliquer' })).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => (window as any).__levelingDiscarded))
    .toContain(first);
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  expect(await page.evaluate(() => (window as any).__lastLeveling.options)).toMatchObject({
    trackId: 'music',
    startMs: 1200,
    endMs: 3000,
    mode: 'high',
  });
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(modal).not.toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Réglage de la sélection audio', exact: true }),
  ).toBeVisible();
  expect((await saved(page)).generations).toEqual(before.generations);
});
test('changed projects and failed preparation cannot apply an old result', async ({ page }) => {
  const modal = await open(page);
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(modal.locator('audio')).toHaveCount(2);
  await modal
    .locator('audio')
    .last()
    .evaluate((e: HTMLAudioElement) => {
      (window as any).__levelingAudio = e;
      return e.play();
    });
  await page.evaluate(async () => {
    const w = window as any;
    const s = await w.__mcp('studio_get_state', {});
    const response = await w.__mcp('studio_project_patch', {
      context: s.context,
      patches: [{ op: 'replace', path: '/name', value: 'Changed during preview' }],
    });
    if (response?.isError) throw Error(JSON.stringify(response));
  });
  await expect(modal.getByRole('alert')).toContainText('Le projet a changé');
  await expect.poll(() => page.evaluate(() => (window as any).__levelingAudio.paused)).toBe(true);
  await expect(modal.getByRole('button', { name: 'Valider et appliquer' })).toBeDisabled();
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await page.evaluate(() => (window as any).__completeLeveling('VOLUME_LEVELING_SILENT'));
  await expect(modal.getByRole('region', { name: 'Traitement de cette opération' })).toContainText(
    'Aucun passage assez audible',
  );
  await expect(modal.locator('audio')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Valider et appliquer' })).toBeDisabled();
});
test('dubbing selections are supported without replacing any generated take', async ({ page }) => {
  const before = await saved(page),
    modal = await open(page, 'dubbing');
  await page.evaluate(
    (scope) => {
      (window as any).__levelingDubbingScope = scope;
    },
    dubbingLevelingScope(before, 1200, 3000),
  );
  await modal.getByRole('combobox', { name: 'Niveau cible' }).selectOption('high');
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(modal.locator('audio')).toHaveCount(2);
  await modal.screenshot({ path: 'docs/screenshots/volume-leveling-fr.png' });
  await modal.getByRole('button', { name: 'Valider et appliquer' }).click();
  await expect(modal).not.toBeVisible();
  const after = await saved(page);
  expect(after.generations.filter((g: any) => g.kind === 'tts')).toEqual(
    before.generations.filter((g: any) => g.kind === 'tts'),
  );
  expect(after.generations.at(-1).trackId).toBe('dubbing');
  const patches = page.locator('.timeline-track[data-track-id="dubbing"] .audio-patch');
  await expect(patches).toHaveCount(1);
  await page.evaluate(async () => {
    const w = window as any;
    const s = await w.__mcp('studio_get_state', {}),
      p = w.__getMockProject();
    const g = p.generations.find(
      (g: any) => g.kind === 'tts' && g.dialogueId === p.dialogues[0].id,
    );
    const r = await w.__mcp('studio_project_patch', {
      context: s.context,
      patches: [
        { op: 'add', path: '/generations/-', value: { ...g, id: 'other-leveling-take' } },
        {
          op: 'replace',
          path: '/dialogues/0/selectedGenerationIds/fr',
          value: 'other-leveling-take',
        },
      ],
    });
    if (r?.isError) throw Error(JSON.stringify(r));
  });
  await expect(patches).toHaveCount(0);
  await page.evaluate(async (id) => {
    const w = window as any;
    const s = await w.__mcp('studio_get_state', {});
    const r = await w.__mcp('studio_project_patch', {
      context: s.context,
      patches: [{ op: 'replace', path: '/dialogues/0/selectedGenerationIds/fr', value: id }],
    });
    if (r?.isError) throw Error(JSON.stringify(r));
  }, before.dialogues[0].selectedGenerationIds.fr);
  await expect(patches).toHaveCount(1);
});
test('right click inside a larger muted region retains the smaller selected range and saved mixer settings', async ({
  page,
}) => {
  const { row } = await select(page, 'music');
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const w = window as any;
    const s = await w.__mcp('studio_get_state', {});
    const r = await w.__mcp('studio_audio_region', {
      context: s.context,
      id: 'music',
      startMs: 0,
      endMs: 5000,
      gain: 0,
      mute: true,
    });
    if (r?.isError) throw Error(JSON.stringify(r));
  });
  const before = await saved(page);
  await row.getByRole('button', { name: /Redimensionner le début/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Égaliser le volume…', exact: true }).click();
  const modal = page.getByRole('dialog', {
    name: 'Égaliser le volume de la sélection',
    exact: true,
  });
  await expect(modal).toContainText('00:00:01.200 → 00:00:03.000');
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  expect(await page.evaluate(() => (window as any).__lastLeveling.options)).toMatchObject({
    trackId: 'music',
    startMs: 1200,
    endMs: 3000,
  });
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(modal.locator('audio')).toHaveCount(2);
  await modal.getByRole('button', { name: 'Valider et appliquer' }).click();
  await expect(modal).not.toBeVisible();
  expect((await saved(page)).tracks).toEqual(before.tracks);
});
test('closing a completed preview stops its detached audio without applying it', async ({
  page,
}) => {
  const modal = await open(page),
    before = await saved(page);
  await modal.getByRole('button', { name: 'Préparer la préécoute' }).click();
  await page.evaluate(() => (window as any).__completeLeveling());
  const audio = modal.locator('audio').last();
  await expect(audio).toBeVisible();
  await audio.evaluate((e: HTMLAudioElement) => {
    (window as any).__closedLevelingAudio = e;
    return e.play();
  });
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).__closedLevelingAudio.paused))
    .toBe(true);
  expect((await saved(page)).generations).toEqual(before.generations);
});
