import { test, expect, type Page } from '@playwright/test';
import { nativeMock, wav } from './nativeMock';
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    // Real Web Audio processing with a clocked silent sink, independent of a
    // Windows CI audio device. No samples or meter results are mocked.
    // https://developer.chrome.com/blog/audiocontext-setsinkid
    const BaseContext = window.AudioContext;
    (window as any).__meterContexts = [];
    window.AudioContext = class extends BaseContext {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sinkId: { type: 'none' } } as AudioContextOptions);
        (window as any).__meterContexts.push(this);
      }
    };
  });
});
const call = (page: Page, tool: string, args: unknown = {}) => page.evaluate(({ tool, args }) => (window as any).__mcp(tool, args), { tool, args });
const levels = (page: Page) => call(page, 'studio_audio_levels', { action: 'status' });
const context = async (page: Page) => (await call(page, 'studio_get_state')).context;
async function setTrack(page: Page, id: string, changes: unknown) { const result = await call(page, 'studio_set_track', { context: await context(page), id, changes }); expect(result.error).toBeUndefined(); }
async function ready(page: Page) {
  await page.addInitScript(() => localStorage.setItem('studio.timelineHeight', '420'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__seedDubbing(); (window as any).__completeSeparation(); });
  await page.getByRole('button', { name: 'Paramètres', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Activer le pilotage MCP local', exact: true }).check();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect.poll(async () => (await levels(page)).status).toBe('ready');
  await expect.poll(() => page.evaluate(() => (window as any).__meterContexts.at(-1).currentTime)).toBeGreaterThan(0);
  while (await page.locator('.job-notice .notice-close').count()) await page.locator('.job-notice .notice-close').first().click();
}
async function play(page: Page, timeMs = 1500) {
  await call(page, 'studio_playback', { action: 'pause' });
  await call(page, 'studio_playback', { action: 'seek', timeMs });
  await call(page, 'studio_playback', { action: 'play' });
}
const peak = async (page: Page, id: string) => Math.max(...(await levels(page)).tracks[id].channels.map((c: any) => c.peakDb));
function meterWave(value: number, opposite = false) {
  const bytes = wav(16);
  const frames = (bytes.length - 44) / 4;
  // A smooth ramp avoids a hard file edge. The constant plateau is independent
  // of relative MediaElement clock phases; opposite stereo signs expose mono meters.
  for (let frame = 0; frame < frames; frame++) {
    const fade = Math.min(1, frame / 240, (frames - 1 - frame) / 240);
    const sample = Math.round(32767 * value * fade);
    bytes.writeInt16LE(sample, 44 + frame * 4);
    bytes.writeInt16LE(sample * (opposite ? -1 : 1), 46 + frame * 4);
  }
  return bytes;
}

test('real stereo meters follow global/region gain and solo/mute before the independent listening volume', async ({ page }) => {
  await nativeMock(page); await ready(page);
  await setTrack(page, 'speech', { solo: true, gain: 1 }); await play(page);
  // nativeMock.wav has an exact 1000/32768 sample peak. Wait for the stable
  // level instead of calibrating all later checks from a decoder seek transient.
  const baseline = 20 * Math.log10(1000 / 32768);
  await expect.poll(() => peak(page, 'speech')).toBeCloseTo(baseline, 1);
  await expect.poll(() => peak(page, '$mix')).toBeCloseTo(baseline, 0);
  await call(page, 'studio_playback', { action: 'volume', value: 0 });
  await expect.poll(() => peak(page, '$mix')).toBeGreaterThan(baseline - 1);
  await setTrack(page, 'speech', { gain: 4 });
  await play(page);
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(baseline + 11.5);
  await expect(page.getByRole('button', { name: 'Volume global · Voix', exact: true })).toHaveText('400%');
  await call(page, 'studio_audio_region', { context: await context(page), id: 'speech', startMs: 1000, endMs: 14000, gain: 0, mute: true });
  await play(page, 2000); await expect.poll(() => peak(page, 'speech')).toBe(-96);
  await expect.poll(() => peak(page, '$mix')).toBe(-96);
  await setTrack(page, 'speech', { regionsEnabled: false });
  await play(page, 2000);
  await expect.poll(() => peak(page, 'speech')).toBeGreaterThan(baseline + 11.5);
  await setTrack(page, 'speech', { mute: true });
  await play(page, 2000);
  await expect.poll(() => peak(page, 'speech')).toBe(-96);
  await call(page, 'studio_playback', { action: 'pause' });
  await expect.poll(() => peak(page, '$mix')).toBe(-96);
});

test('final stereo sum clips with individually safe opposite-phase channels and latches/reset never edits the project', async ({ page }) => {
  await nativeMock(page);
  for (const file of ['speech', 'music']) await page.route(`**/${file}.wav`, route => route.fulfill({ contentType: 'audio/wav', body: meterWave(.65, true) }));
  await ready(page); await setTrack(page, 'sfx', { mute: true });
  await call(page, 'studio_playback', { action: 'volume', value: 0 }); await play(page);
  await expect.poll(async () => (await levels(page)).tracks.$mix.clipped).toBe(true);
  // All channel and mix assertions must hold in the same sampled snapshot.
  await expect(async () => {
    const measured = await levels(page);
    for (const id of ['speech', 'music']) { expect(measured.tracks[id].clipped).toBe(false); expect(measured.tracks[id].channels[0].peakDb).toBeCloseTo(20 * Math.log10(.65), 1); expect(measured.tracks[id].channels[1].peakDb).toBeCloseTo(20 * Math.log10(.65), 1); }
    expect(measured.tracks.$mix.clipped).toBe(true);
    expect(measured.tracks.$mix.channels[0].peakDb).toBeGreaterThan(2);
    expect(measured.tracks.$mix.channels[1].peakDb).toBeGreaterThan(2);
  }).toPass({ timeout: 15000 });
  await page.screenshot({ path: 'docs/screenshots/audio-levels-timeline-fr.png' });
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Audio', exact: true });
  await panel.getByRole('heading', { name: 'Niveaux audio en direct', exact: true }).scrollIntoViewIfNeeded();
  await panel.locator('.audio-levels-overview').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: 'docs/screenshots/audio-levels-mixer-fr.png' });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await call(page, 'studio_playback', { action: 'pause' });
  expect((await levels(page)).tracks.$mix.clipped).toBe(true);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.locator('.timeline-master-meter').getByRole('button', { name: 'Réinitialiser les crêtes · Mix final', exact: true }).click();
  expect((await levels(page)).tracks.$mix.clipped).toBe(false);
  expect((await levels(page)).tracks.$mix.channels[0].maxDb).toBe(-96);
  const after = await page.evaluate(() => (window as any).__getMockProject()); expect(after).toEqual(before);
  expect((await call(page, 'studio_audio_levels', { action: 'reset', id: 'missing' })).error).toContain('MCP_INVALID_ARGUMENTS');
});

test('buffered dubbing and replacement audio layers are measured on their destination track', async ({ page }) => {
  await nativeMock(page); await ready(page);
  await setTrack(page, 'dubbing', { mute: false, solo: true }); await play(page, 1000);
  await expect.poll(() => peak(page, 'dubbing')).toBeGreaterThan(-40);
  expect(await peak(page, 'speech')).toBe(-96);
  await call(page, 'studio_playback', { action: 'pause' });
  const p = await page.evaluate(() => (window as any).__getMockProject());
  const patch = { kind: 'audioPatch', id: 'meter', operationId: 'meter-operation', operation: 'copy', sourcePath: p.media.path, sourceTrackId: 'speech', trackId: 'music', startMs: 0, endMs: 12000, mode: 'replace', path: 'stems/patch-meter.wav', gain: 1 };
  await page.route('**/patch-meter.wav', route => route.fulfill({ contentType: 'audio/wav', body: meterWave(.2) }));
  const added = await call(page, 'studio_project_patch', { context: await context(page), patches: [{ op: 'replace', path: '/formatVersion', value: 18 }, { op: 'add', path: '/generations/-', value: patch }] }); expect(added.error).toBeUndefined();
  await setTrack(page, 'dubbing', { solo: false, mute: true }); await setTrack(page, 'music', { solo: true, gain: 2 }); await play(page, 2000);
  await expect.poll(() => peak(page, 'music')).toBeGreaterThan(-9);
  expect(await peak(page, 'music')).toBeCloseTo(20 * Math.log10(.4), 0);
  expect(await peak(page, '$mix')).toBeCloseTo(await peak(page, 'music'), 0);
  await call(page, 'studio_playback', { action: 'pause' });
});

test('meter initialization failure leaves audible playback and all gain controls usable', async ({ page }) => {
  await nativeMock(page);
  await page.addInitScript(() => {
    window.AudioContext = class extends AudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        this.audioWorklet.addModule = () => Promise.reject(new Error('Simulated unavailable worklet'));
      }
    };
    const taps: AnalyserNode[] = [], connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args: any[]) { const value = (connect as any).apply(this, args); if (this instanceof GainNode && args[0] === this.context.destination) { const tap = this.context.createAnalyser(); tap.fftSize = 1024; (connect as any).call(this, tap); taps.push(tap); } return value; };
    (window as any).__meterFallbackRms = () => Math.max(0, ...taps.map(t => { const data = new Float32Array(t.fftSize); t.getFloatTimeDomainData(data); return Math.sqrt(data.reduce((n, v) => n + v * v, 0) / data.length); }));
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as any).__completeSeparation());
  await expect(page.locator('.timeline-master-meter .audio-meter')).toHaveAttribute('data-meter-status', 'unavailable');
  await page.getByRole('button', { name: 'Écouter Voix en solo', exact: true }).click();
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__meterFallbackRms())).toBeGreaterThan(.01);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.locator('.error-toast')).toHaveCount(0);
});
