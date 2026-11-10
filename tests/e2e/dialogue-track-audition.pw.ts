import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const modal = (p: Page) => p.getByRole('dialog', { name: 'Pistes du dialogue', exact: true });
const names: Record<string, string> = {
  original: 'Original',
  speech: 'Voix',
  music: 'Musique',
  sfx: 'Effets',
  dubbing: 'Doublage',
};
const saved = (p: Page) => p.evaluate(() => (window as any).__getMockProject());
const call = (p: Page, tool: string, args: unknown = {}) =>
  p.evaluate(({ tool, args }) => (window as any).__mcp(tool, args), { tool, args });
const state = (p: Page) => call(p, 'studio_get_state');
const play = (p: Page, id: string) =>
  modal(p).getByRole('button', { name: `Écouter ${names[id] ?? id}`, exact: true });
const stop = (p: Page, id: string) =>
  modal(p).getByRole('button', { name: `Arrêter ${names[id] ?? id}`, exact: true });
async function peak(p: Page, id: string) {
  const levels = await call(p, 'studio_audio_levels', { action: 'status' });
  return Math.max(...levels.tracks[id].channels.map((c: any) => c.peakDb));
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sinkId: { type: 'none' } } as AudioContextOptions);
      }
    };
    localStorage.setItem('mockMcpEnabled', 'true');
  });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__mcpReady)).toBe(true);
});
async function open(page: Page, index = 0) {
  await page.locator('.dialogue-card').nth(index).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Écouter les pistes…', exact: true }).click();
  await expect(modal(page)).toBeVisible();
}

test('context opens the clicked dialogue without seeking or selecting another reply, with compact named controls', async ({
  page,
}) => {
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await call(page, 'studio_playback', { action: 'seek', timeMs: 500 });
  const before = await saved(page);
  await open(page, 1);
  await expect(modal(page)).toContainText('Réplique 2');
  expect((await state(page)).playback.selection).toBeNull();
  expect((await state(page)).playback.timeMs).toBe(500);
  await expect(page.locator('.dialogue-card').first()).toHaveClass(/selected/);
  for (const name of Object.values(names)) {
    await expect(
      modal(page).getByRole('button', { name: `Écouter ${name}`, exact: true }),
    ).toBeEnabled();
    await expect(
      modal(page).getByRole('button', { name: `Isoler les voix de ${name}`, exact: true }),
    ).toHaveAttribute('title', /.+/);
  }
  await expect(
    modal(page).getByRole('button', { name: 'Isoler les voix de Doublage', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: 'docs/screenshots/dialogue-track-audition-fr.png' });
  expect((await saved(page)).tracks).toEqual(before.tracks);
});

test('all five tracks play in solo for exactly the dialogue and stop naturally without changing the mix', async ({
  page,
}) => {
  test.setTimeout(60000);
  const before = await saved(page),
    line = before.dialogues[1];
  await open(page, 1);
  for (const id of Object.keys(names)) {
    await play(page, id).click();
    await expect
      .poll(async () => (await state(page)).playback.selection?.selection.trackId)
      .toBe(id);
    expect((await state(page)).playback.selection.selection).toMatchObject({
      startMs: line.startMs,
      endMs: line.endMs,
    });
    await expect.poll(() => peak(page, id)).toBeGreaterThan(-90);
    for (const other of Object.keys(names).filter((t) => t !== id))
      expect(await peak(page, other)).toBe(-96);
    await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
    expect((await state(page)).playback.playing).toBe(false);
    expect(Math.abs((await state(page)).playback.timeMs - line.endMs)).toBeLessThan(100);
  }
  expect((await saved(page)).tracks).toEqual(before.tracks);
  expect((await saved(page)).generations).toEqual(before.generations);
});

test('switching tracks and explicit stop leave only one preview, and closing restores ordinary mixing', async ({
  page,
}) => {
  await open(page);
  await play(page, 'speech').click();
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-90);
  await play(page, 'music').click();
  await expect.poll(() => peak(page, 'music')).toBeGreaterThan(-90);
  expect(await peak(page, 'speech')).toBe(-96);
  await stop(page, 'music').click();
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  await play(page, 'speech').click();
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  await call(page, 'studio_playback', { action: 'seek', timeMs: 1500 });
  await call(page, 'studio_playback', { action: 'play' });
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-90);
  await expect.poll(() => peak(page, 'music')).toBeGreaterThan(-90);
});

test('before-level listening bypasses saved silent regions without removing them or leaving an old preview playing', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject(),
      l = p.dialogues[0];
    p.tracks.find((t: any) => t.id === 'speech').regions = [
      { id: 'silent', startMs: l.startMs, endMs: l.endMs, mute: true, gain: 1 },
    ];
    w.__loadMockProject(p);
  });
  const before = await saved(page);
  await open(page);
  await play(page, 'speech').click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await expect.poll(() => peak(page, 'speech')).toBe(-96);
  await modal(page).getByRole('checkbox', { name: 'Avant volumes/muets', exact: true }).check();
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  await play(page, 'speech').click();
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(-90);
  expect((await state(page)).playback.selection.beforeLevels).toBe(true);
  expect((await saved(page)).tracks).toEqual(before.tracks);
});

test('isolation stops playback and opens the selected source track on the clicked dialogue range', async ({
  page,
}) => {
  const before = await saved(page),
    line = before.dialogues[1];
  await open(page, 1);
  await play(page, 'sfx').click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await modal(page).getByRole('button', { name: 'Isoler les voix de Effets', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  const panel = page.locator('.audio-toolbox');
  await expect(panel.getByRole('combobox', { name: 'Piste à analyser', exact: true })).toHaveValue(
    'sfx',
  );
  await expect(panel.getByRole('spinbutton', { name: 'Début (s)', exact: true })).toHaveValue(
    String(line.startMs / 1000),
  );
  await expect(panel.getByRole('spinbutton', { name: 'Fin (s)', exact: true })).toHaveValue(
    String(line.endMs / 1000),
  );
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  await panel.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__pendingToolbox)).toMatchObject({
    sourceTrackId: 'sfx',
    startMs: line.startMs,
    endMs: line.endMs,
  });
  expect((await saved(page)).generations).toEqual(before.generations);
});

test('added audio is included, short or foreign tracks are guarded, and long dialogue only disables isolation', async ({
  page,
}) => {
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject(),
      base = p.tracks.find((t: any) => t.id === 'speech');
    p.tracks.push({ ...base, id: 'custom', name: 'Autre prise', role: undefined });
    p.tracks.push({
      ...base,
      id: 'short',
      name: 'Piste courte',
      role: undefined,
      durationMs: 1000,
    });
    p.tracks.push({
      ...base,
      id: 'foreign',
      name: 'Autre vidéo',
      role: undefined,
      sourcePath: 'other.mkv',
    });
    w.__loadMockProject(p);
  });
  await open(page);
  await expect(play(page, 'Autre prise')).toBeEnabled();
  await expect(play(page, 'Piste courte')).toBeDisabled();
  await expect(
    modal(page).getByRole('button', { name: 'Isoler les voix de Piste courte', exact: true }),
  ).toBeDisabled();
  await expect(play(page, 'Autre vidéo')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject();
    p.media.durationMs = 90000;
    p.dialogues[0].endMs = 80000;
    w.__loadMockProject(p);
  });
  await open(page);
  await expect(play(page, 'original')).toBeEnabled();
  await expect(
    modal(page).getByRole('button', { name: 'Isoler les voix de Original', exact: true }),
  ).toBeDisabled();
});

test('changing the dialogue bounds stops the previous audition and another dialogue starts with its own range', async ({
  page,
}) => {
  await open(page);
  await play(page, 'speech').click();
  await expect.poll(async () => (await state(page)).playback.playing).toBe(true);
  await page.evaluate(() => (window as any).__setFirstSlot(3500));
  await expect.poll(async () => (await state(page)).playback.selection).toBeNull();
  await page.keyboard.press('Escape');
  await open(page, 1);
  await play(page, 'music').click();
  const line = (await saved(page)).dialogues[1];
  await expect
    .poll(async () => (await state(page)).playback.selection?.selection.startMs)
    .toBe(line.startMs);
  expect((await state(page)).playback.selection.selection.endMs).toBe(line.endMs);
});
