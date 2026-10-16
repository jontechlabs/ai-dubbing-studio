import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

async function ready(page: Page) {
  await nativeMock(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__seedDubbing(); (window as any).__completeSeparation(); });
  await page.getByRole('button', { name: 'Sélectionner une zone audio (ou Maj + glisser)', exact: true }).click();
}
async function select(page: Page, index: number) {
  const row = page.locator('.timeline-track.audio').nth(index); await row.scrollIntoViewIfNeeded();
  const b = (await row.boundingBox())!;
  await page.mouse.move(b.x + b.width * .07, b.y + b.height / 2); await page.mouse.down();
  await page.mouse.move(b.x + b.width * .25, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
  const controls = page.getByRole('group', { name: 'Réglage de la sélection audio' }); await expect(controls).toBeVisible(); await expect(row).toBeInViewport({ratio:.95}); return controls;
}
const saved = async (page: Page) => { await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé'); return page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!)); };

test('timeline range volume and mute edit all five tracks directly and persist after reload', async ({ page }) => {
  await ready(page);
  for (const [i, id] of ['original', 'speech', 'music', 'sfx', 'dubbing'].entries()) {
    const controls = await select(page, i); await expect(page.getByRole('dialog', { name: 'Audio', exact: true })).toHaveCount(0);
    await controls.getByRole('slider', { name: 'Volume de la sélection' }).fill('2');
    let p = await saved(page); expect(p.tracks.find((t: any) => t.id === id).regions.some((r: any) => r.gain === 2 && !r.mute)).toBe(true);
    await controls.getByRole('button', { name: 'Rendre la zone silencieuse', exact: true }).click();
    p = await saved(page); expect(p.tracks.find((t: any) => t.id === id).regions.some((r: any) => r.mute)).toBe(true);
    await controls.getByRole('button', { name: 'Rendre la zone audible', exact: true }).click();
    if (i === 4) await page.screenshot({ path: 'docs/screenshots/timeline-volume.png' });
    await controls.getByRole('button', { name: 'Effacer la sélection audio' }).click();
    await expect(controls).toHaveCount(0);
  }
  const before = await saved(page); await page.reload(); await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
  for (const id of ['original', 'speech', 'music', 'sfx', 'dubbing']) expect(after.tracks.find((t: any) => t.id === id).regions).toEqual(before.tracks.find((t: any) => t.id === id).regions);
});

test('inline gain replaces only its selected interval and undo updates the controls and advanced editor', async ({ page }) => {
  await ready(page); const controls = await select(page, 1);
  await controls.getByRole('slider', { name: 'Volume de la sélection' }).fill('0.5'); await saved(page);
  await controls.getByRole('button', { name: 'Effacer la sélection audio' }).click();
  await page.locator('.audio-region.audible').first().click();
  await expect(controls.getByRole('slider', { name: 'Volume de la sélection' })).toHaveValue('0.5');
  await controls.getByRole('slider', { name: 'Volume de la sélection' }).focus(); await page.keyboard.press('Control+z');
  await expect(controls.getByRole('slider', { name: 'Volume de la sélection' })).toHaveValue('1');
  await page.keyboard.press('Control+y'); await expect(controls.getByRole('slider', { name: 'Volume de la sélection' })).toHaveValue('0.5');
  await controls.getByRole('button', { name: 'Options audio', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Audio', exact: true });
  await expect(panel.getByRole('slider', { name: 'Volume de la zone', exact: true })).toHaveValue('0.5');
  await panel.getByRole('button', { name: 'Fermer', exact: true }).click();
  await controls.getByRole('button', { name: '100 %', exact: true }).click();
  await expect(controls.getByRole('slider', { name: 'Volume de la sélection' })).toHaveValue('1');
  const p = await saved(page); expect(p.tracks.find((t: any) => t.id === 'speech').regions).toHaveLength(1);
});

test('inline volume changes actual playback only within the selected range and keeps source audio intact', async ({ page }) => {
  await nativeMock(page);
  await page.addInitScript(() => {
    const taps: AnalyserNode[] = [], connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args: any[]) { const value = (connect as any).apply(this, args); if (this instanceof GainNode && args[0] === this.context.destination) { const tap = this.context.createAnalyser(); tap.fftSize = 1024; (connect as any).call(this, tap); taps.push(tap); } return value; };
    (window as any).__volumeRms = () => Math.max(0, ...taps.map(t => { const d = new Float32Array(t.fftSize); t.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((n, x) => n + x * x, 0) / d.length); }));
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled(); await page.evaluate(() => (window as any).__completeSeparation());
  await page.getByRole('button', { name: 'Sélectionner une zone audio (ou Maj + glisser)', exact: true }).click();
  const controls = await select(page, 1); await page.getByRole('button', { name: 'Écouter Voix en solo', exact: true }).click();
  const rms = () => page.evaluate(() => (window as any).__volumeRms());
  const pos = async (t: number) => { await page.locator('video').evaluate((v: HTMLVideoElement, t) => { v.currentTime = t; }, t); await expect(page.locator('video')).toHaveJSProperty('seeking', false); };
  await pos(1.5); await page.getByRole('button', { name: 'Lecture', exact: true }).click(); await expect.poll(rms).toBeGreaterThan(.015);
  const baseline = await rms(); // Includes the user's master volume.
  await controls.getByRole('slider', { name: 'Volume de la sélection' }).fill('0.5'); await pos(1.5); await expect.poll(rms).toBeLessThan(baseline * .65); await expect.poll(rms).toBeGreaterThan(baseline * .35);
  await controls.getByRole('slider', { name: 'Volume de la sélection' }).fill('2'); await pos(1.5); await expect.poll(rms).toBeGreaterThan(baseline * 1.7);
  await controls.getByRole('button', { name: 'Rendre la zone silencieuse', exact: true }).click(); await pos(1.5); await expect.poll(rms).toBeLessThan(.000001);
  await pos(5); await expect.poll(rms).toBeGreaterThan(baseline * .75); await expect.poll(rms).toBeLessThan(baseline * 1.25);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});
