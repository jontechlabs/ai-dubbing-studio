import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';

const nodeCount = (page: Page) => page.locator('.timeline-track .subtitle-block').count();
async function longFilm(page: Page) {
  const p = demoProject();
  p.formatVersion = 19;
  p.media!.durationMs = 18_000_000;
  p.sourceCues = Array.from({ length: 6000 }, (_, i) => ({
    id: `s${i}`,
    startMs: i * 3000,
    endMs: i * 3000 + 2000,
    text: `Source ${i + 1}`,
  }));
  p.targetCues = p.sourceCues.map((c, i) => ({ ...c, id: `t${i}`, text: `Texte ${i + 1}` }));
  p.dialogues = p.sourceCues.map((c, i) => ({
    ...p.dialogues[0],
    id: `d${i}`,
    startMs: c.startMs,
    endMs: c.endMs,
    sourceCueIds: [c.id],
    targetCueIds: [`t${i}`],
    selectedGenerationIds: { fr: `g${i}` },
    status: 'generated',
  }));
  p.generations = p.dialogues.map((line, i) => ({
    id: `g${i}`,
    kind: 'tts',
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: `generations/g${i}.wav`,
    createdAt: p.createdAt,
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: `Texte ${i + 1}`,
    language: 'fr',
    characterId: null,
    durationMs: 2000,
    sampleRate: 24000,
    options: {
      variantId: 'cosy3-official',
      device: 'cpu',
      referenceMode: 'current',
      referenceId: null,
      mode: 'crossLingual',
      speed: 1,
      seed: 7,
    },
    referenceTranscript: 'Hello',
    device: 'cpu',
    deviceName: 'CPU (simulation)',
    peakVramMb: 0,
    inputHash: 'mock',
  }));
  p.tracks = [
    ...p.tracks.map((track) => ({ ...track, durationMs: p.media!.durationMs })),
    { id: 'dubbing', kind: 'dubbing', mute: true, solo: false, gain: 1, sourcePath: p.media!.path },
  ];
  await nativeMock(page, false, p);
  await page.addInitScript(() => {
    const host = window as any;
    host.__maxTimelineBlocks = 0;
    host.__waveformPaints = 0;
    const observe = () =>
      new MutationObserver(() => {
        host.__maxTimelineBlocks = Math.max(
          host.__maxTimelineBlocks,
          document.querySelectorAll('.timeline-track .subtitle-block').length,
        );
      }).observe(document.body, { childList: true, subtree: true });
    if (document.body) observe();
    else document.addEventListener('DOMContentLoaded', observe);
    const invoke = host.__TAURI_INTERNALS__.invoke;
    host.__TAURI_INTERNALS__.invoke = (command: string, args: unknown) =>
      command === 'get_waveform'
        ? Promise.resolve({
            durationMs: 18_000_000,
            stepMs: 90,
            audioStreamIndex: 1,
            peaks: Array.from({ length: 200000 }, (_, i) => (i % 31) / 32),
          })
        : invoke(command, args);
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.closest('.waveform')) host.__waveformPaints++;
      return fill.apply(this, args);
    };
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await expect(page.locator('.waveform canvas').first()).toBeVisible();
  await expect(page.locator('.zoom-value')).toHaveText('15000%');
}
async function limited(page: Page) {
  const seconds = await page.locator('.timeline-scroll').evaluate((el) => {
    const width = el.querySelector('.timeline-content')!.getBoundingClientRect().width;
    return (el.clientWidth / width) * 18000;
  });
  expect(seconds).toBeLessThanOrEqual(120.1);
  expect(await nodeCount(page)).toBeLessThan(135);
}

test('five-hour films never mount all 18000 cue/voice buttons and every zoom entry point respects the minimum', async ({
  page,
}) => {
  await longFilm(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await limited(page);
  expect(await page.evaluate(() => (window as any).__maxTimelineBlocks)).toBeLessThan(135);
  await expect(
    page.getByRole('button', { name: 'Zoom arrière (Ctrl+−)', exact: true }),
  ).toBeDisabled();
  await page.getByRole('slider', { name: 'Zoom de la timeline', exact: true }).fill('55');
  await page.getByRole('slider', { name: 'Zoom de la timeline', exact: true }).fill('0');
  await limited(page);
  await page.locator('h2').filter({ hasText: 'Timeline' }).click();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+Minus');
  await limited(page);
  const bounds = (await page.locator('.timeline-scroll').boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 15);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 1000);
  await page.keyboard.up('Control');
  await limited(page);
  for (const value of [1, 'fit']) {
    await page.evaluate(
      (value) => document.dispatchEvent(new CustomEvent('studio-timeline-zoom', { detail: value })),
      value,
    );
    await limited(page);
  }
  await page.keyboard.press('Shift+Z');
  await limited(page);
  await page
    .getByRole('button', { name: 'Vue d’ensemble limitée à 2 min (Maj+Z)', exact: true })
    .click();
  await limited(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  await limited(page);
  const scroll = page.locator('.timeline-scroll');
  await scroll.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect(page.locator('.target .subtitle-block').last()).toHaveText('6000');
  await limited(page);
  await page.getByPlaceholder('Rechercher une réplique…').fill('Texte 3000');
  await page.locator('.dialogue-card').filter({ hasText: 'Texte 3000' }).click();
  await expect(page.locator('.target .subtitle-block.selected')).toHaveText('3000');
  await expect.poll(() => scroll.evaluate((el) => el.scrollLeft)).toBeGreaterThan(1000);
  await limited(page);
  expect(await page.evaluate(() => (window as any).__getMockProject())).toEqual(before);
  console.log(
    'TIMELINE_PERFORMANCE_PROOF',
    JSON.stringify({
      totalBlocks: 18000,
      maximumMounted: await page.evaluate(() => (window as any).__maxTimelineBlocks),
      maximumWindowSeconds: 120,
      projectUnchanged: true,
    }),
  );
  await page.setViewportSize({ width: 1920, height: 1080 });
  const separator = page.getByRole('separator', { name: 'Redimensionner la timeline', exact: true });
  await separator.focus();
  for (let i = 0; i < 16; i++) await separator.press('ArrowUp');
  await page.locator('.dialogue-card').filter({ hasText: 'Texte 3000' }).click();
  await expect(page.locator('.target .subtitle-block.selected')).toHaveText('3000');
  await limited(page);
  await page.screenshot({ path: 'docs/screenshots/timeline-long-film-fr.png' });
});

test('video playback advances with a dense long-film timeline without repainting static waveforms or remounting blocks', async ({
  page,
}) => {
  await longFilm(page);
  await expect.poll(() => page.evaluate(() => (window as any).__waveformPaints)).toBeGreaterThan(0);
  const paints = await page.evaluate(() => (window as any).__waveformPaints);
  const blocks = await nodeCount(page);
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator('video')
        .first()
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__waveformPaints)).toBe(paints);
  expect(await nodeCount(page)).toBe(blocks);
  await limited(page);
  console.log(
    'TIMELINE_PLAYBACK_PROOF',
    JSON.stringify({
      videoAdvanced: true,
      staticWaveformRepaints: 0,
      peakBins: 200000,
      mountedBlocks: blocks,
    }),
  );
});
