import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sinkId: { type: 'none' } } as AudioContextOptions);
      }
    };
    localStorage.setItem('mockMcpEnabled', 'true');
    localStorage.setItem('studio.timelineHeight', '420');
  });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
  await expect.poll(() => page.evaluate(() => (window as any).__mcpReady)).toBe(true);
});
const call = (page: Page, tool: string, args: unknown = {}) =>
  page.evaluate(({ tool, args }) => (window as any).__mcp(tool, args), { tool, args });
const state = (page: Page) => call(page, 'studio_get_state');
const saved = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
const peak = async (page: Page, id: string) => {
  const levels = await call(page, 'studio_audio_levels', { action: 'status' });
  return Math.max(...levels.tracks[id].channels.map((c: any) => c.peakDb));
};
async function select(page: Page, id: string, startMs = 1200, endMs = 2500) {
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
  for (const [name, value] of [
    ['Début de la zone audio (ms)', startMs],
    ['Fin de la zone audio (ms)', endMs],
  ] as const) {
    const input = controls.getByRole('spinbutton', { name, exact: true });
    await input.fill(String(value));
    await input.press('Enter');
    await expect(input).toHaveValue(String(value));
  }
  return { row, controls };
}

test('the timeline plays only the selected track, stops at the range end and preserves the project', async ({
  page,
}) => {
  const before = await saved(page);
  for (const id of ['original', 'speech', 'music', 'sfx', 'dubbing']) {
    const { controls } = await select(page, id);
    await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
    await expect
      .poll(async () => (await state(page)).playback.selection?.selection.trackId)
      .toBe(id);
    await expect.poll(() => peak(page, id)).toBeGreaterThan(-90);
    for (const other of ['original', 'speech', 'music', 'sfx', 'dubbing'].filter((t) => t !== id))
      expect(await peak(page, other)).toBe(-96);
    await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
    const end = (await state(page)).playback;
    expect(end.playing).toBe(false);
    expect(Math.abs(end.timeMs - 2500)).toBeLessThan(100);
  }
  expect((await saved(page)).tracks).toEqual(before.tracks);
  expect((await saved(page)).generations).toEqual(before.generations);
});

test('before-level audition hears a muted selection without changing its saved silence', async ({
  page,
}) => {
  const { controls } = await select(page, 'speech', 1200, 3500);
  await controls.getByRole('button', { name: 'Rendre la zone silencieuse', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const before = await saved(page);
  await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await expect.poll(() => peak(page, 'speech')).toBe(-96);
  await controls
    .getByRole('button', { name: 'Arrêter l’écoute de la sélection', exact: true })
    .click();
  await controls.getByRole('checkbox', { name: 'Avant volumes/muets', exact: true }).check();
  await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-40);
  await controls
    .getByRole('button', { name: 'Arrêter l’écoute de la sélection', exact: true })
    .click();
  expect((await saved(page)).tracks).toEqual(before.tracks);
  expect((await saved(page)).generations).toEqual(before.generations);
});

test('right-click playback shares the selection range and explicit stop restores ordinary mixing', async ({
  page,
}) => {
  const { row, controls } = await select(page, 'speech', 1200, 3500);
  await row.getByRole('button', { name: /Redimensionner le début/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-40);
  expect(await peak(page, 'music')).toBe(-96);
  await controls
    .getByRole('button', { name: 'Arrêter l’écoute de la sélection', exact: true })
    .click();
  await call(page, 'studio_playback', { action: 'seek', timeMs: 1500 });
  await call(page, 'studio_playback', { action: 'play' });
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-40);
  await expect.poll(() => peak(page, 'music')).toBeGreaterThan(-40);
  await call(page, 'studio_playback', { action: 'pause' });
});

test('changing or clearing the selection cancels its audition', async ({ page }) => {
  const { controls } = await select(page, 'speech', 1200, 3500);
  await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  const end = controls.getByRole('spinbutton', { name: 'Fin de la zone audio (ms)', exact: true });
  await end.fill('3400');
  await end.press('Enter');
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  expect((await state(page)).playback.playing).toBe(false);
  await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await page.evaluate(() => document.dispatchEvent(new Event('studio-voice-preview')));
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  expect((await state(page)).playback.playing).toBe(false);
  await controls.getByRole('button', { name: 'Écouter la sélection', exact: true }).click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await controls.getByRole('button', { name: 'Effacer la sélection audio', exact: true }).click();
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  expect((await state(page)).playback.playing).toBe(false);
});

test('MCP auditions an explicit range, rejects invalid bounds and stops even with global looping', async ({
  page,
}) => {
  const before = await saved(page);
  for (const changes of [
    { trackId: 'missing' },
    { startMs: -1 },
    { endMs: 17000 },
    { endMs: 1000 },
  ]) {
    const result = await call(page, 'studio_playback', {
      action: 'selection',
      trackId: 'speech',
      startMs: 1200,
      endMs: 2500,
      ...changes,
    });
    expect(result.error).toBeTruthy();
  }
  await call(page, 'studio_playback', { action: 'loop', enabled: true });
  const result = await call(page, 'studio_playback', {
    action: 'selection',
    trackId: 'speech',
    startMs: 1200,
    endMs: 2500,
    beforeLevels: true,
  });
  expect(result).toEqual({ applied: true });
  await expect.poll(async () => (await state(page)).playback.selection?.beforeLevels).toBe(true);
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-40);
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  expect((await state(page)).playback.playing).toBe(false);
  expect((await state(page)).playback.loop).toBe(true);
  expect((await saved(page)).tracks).toEqual(before.tracks);
  expect((await saved(page)).generations).toEqual(before.generations);
});
