import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const controls = (page: Page) => page.getByRole('group', { name: 'Réglage de la sélection audio', exact: true });
async function ready(page: Page) {
  await nativeMock(page); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__seedDubbing(); (window as any).__completeSeparation(); });
  await page.getByRole('button', { name: 'Sélectionner une zone audio (ou Maj + glisser)', exact: true }).click();
}
async function saved(page: Page) {
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  return page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
}
async function select(page: Page, id: string) {
  const row = page.locator(`.timeline-track[data-track-id="${id}"]`); await row.scrollIntoViewIfNeeded();
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + box.width * .08, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .22, box.y + box.height / 2); await page.mouse.up();
  await expect(controls(page)).toBeVisible(); return row;
}

test('right-click deletes regions on every audio track, preserving audio and other tracks with undo/redo', async ({ page }) => {
  test.setTimeout(60000); await ready(page);
  for (const id of ['original', 'speech', 'music', 'sfx', 'dubbing']) {
    const row = await select(page, id);
    await controls(page).getByRole('slider', { name: 'Volume de la sélection', exact: true }).fill('0.5');
    await controls(page).getByRole('button', { name: 'Rendre la zone silencieuse', exact: true }).click();
    const before = await saved(page);
    if (id === 'original') {
      await row.locator('.audio-region').focus(); await page.keyboard.press('Shift+F10');
      await expect(page.getByRole('menuitem', { name: 'Supprimer la zone', exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(row.locator('.audio-region')).toBeFocused();
    }
    await row.locator('.audio-region').click({ button: 'right' });
    const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
    if (id === 'speech') await page.screenshot({ path: 'docs/screenshots/context-menu-audio-fr.png' });
    await menu.getByRole('menuitem', { name: 'Supprimer la zone', exact: true }).click();
    await expect(row.locator('.audio-region')).toHaveCount(0); await expect(controls(page)).toHaveCount(0);
    const after = await saved(page);
    expect(after.tracks.find((t: any) => t.id === id).regions).toEqual([]);
    expect(after.tracks.filter((t: any) => t.id !== id)).toEqual(before.tracks.filter((t: any) => t.id !== id));
    expect(after.media).toEqual(before.media); expect(after.generations).toEqual(before.generations);
  }
  await page.keyboard.press('Control+z'); await saved(page);
  await expect(page.locator('[data-track-id="dubbing"] .audio-region')).toHaveCount(1);
  await page.keyboard.press('Control+y'); await saved(page); await page.reload();
  await expect(page.locator('.audio-region')).toHaveCount(0);
});

test('clearing an unapplied selection through its handle makes no project edit', async ({ page }) => {
  await ready(page); const row = await select(page, 'music'), before = await saved(page);
  await row.getByRole('button', { name: /Redimensionner la fin/ }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Supprimer la zone', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Effacer la sélection audio', exact: true }).click();
  await expect(controls(page)).toHaveCount(0); expect((await saved(page)).tracks).toEqual(before.tracks);
});

test('application menu supports keyboard, undo and redo, outside dismissal, and native text menus', async ({ page }) => {
  await ready(page); const row = await select(page, 'speech');
  await controls(page).getByRole('slider', { name: 'Volume de la sélection', exact: true }).fill('0.5'); await saved(page);
  await page.locator('.brand').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Application', exact: true });
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End'); await expect(menu.getByRole('menuitem', { name: 'Paramètres', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await saved(page); await expect(row.locator('.audio-region')).toHaveCount(0);
  await page.locator('.brand').click({ button: 'right' }); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await saved(page); await expect(row.locator('.audio-region')).toHaveCount(1);
  await page.locator('.brand').click({ button: 'right' }); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await page.locator('.brand').click({ button: 'right' }); await page.locator('.brand').click(); await expect(menu).toHaveCount(0);
  await page.getByPlaceholder('Rechercher une réplique…').click({ button: 'right' }); await expect(page.getByRole('menu')).toHaveCount(0);
  await page.locator('.brand').click({ button: 'right' });
  await page.screenshot({ path: 'docs/screenshots/context-menu-application-fr.png' });
});

test('right-click opens without moving the playhead, subtitle cues or generated audio', async ({ page }) => {
  await ready(page); await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 6; });
  await expect(page.locator('video')).toHaveJSProperty('seeking', false); const before = await saved(page);
  for (const locator of [page.locator('.ruler'), page.locator('.timeline-track.source .subtitle-block').first(), page.getByRole('button', { name: 'Doublage 1', exact: true })]) {
    await locator.click({ button: 'right' }); await expect(page.getByRole('menu')).toBeVisible(); await page.keyboard.press('Escape');
    expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(6);
  }
  const after = await saved(page); expect(after.sourceCues).toEqual(before.sourceCues); expect(after.dubbingTiming).toEqual(before.dubbingTiming); expect(after.voiceEdits).toEqual(before.voiceEdits);
});

test('menu stays inside viewport and closes on scroll, resize and project change', async ({ page }) => {
  await ready(page); await page.mouse.click(1433, 925, { button: 'right' }); const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
  const b = (await menu.boundingBox())!; expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(1440); expect(b.y + b.height).toBeLessThanOrEqual(940);
  await page.setViewportSize({ width: 1280, height: 800 }); await expect(menu).toHaveCount(0);
  await page.locator('.brand').click({ button: 'right' }); await page.locator('.timeline-scroll').evaluate(e => e.dispatchEvent(new Event('scroll'))); await expect(menu).toHaveCount(0);
  await page.locator('.brand').click({ button: 'right' }); await page.evaluate(() => (window as any).__moveFirstDubbing(100)); await expect(menu).toHaveCount(0);
});

test('deleting a region in a zoomed timeline targets the right region and keeps neighbouring levels', async ({ page }) => {
  await ready(page); let row = await select(page, 'music');
  await controls(page).getByRole('slider', { name: 'Volume de la sélection', exact: true }).fill('0.5'); const before = await saved(page), first = before.tracks.find((t: any) => t.id === 'music').regions[0];
  await controls(page).getByRole('button', { name: 'Effacer la sélection audio', exact: true }).click();
  const b = (await row.boundingBox())!; await page.mouse.move(b.x + b.width * .6, b.y + b.height / 2); await page.mouse.down(); await page.mouse.move(b.x + b.width * .8, b.y + b.height / 2); await page.mouse.up();
  await controls(page).getByRole('slider', { name: 'Volume de la sélection', exact: true }).fill('2'); await saved(page);
  await page.getByRole('button', { name: 'Sélectionner une zone audio (ou Maj + glisser)', exact: true }).click();
  await page.keyboard.press('Control+='); await page.keyboard.press('Control+=');
  const scroll = page.locator('.timeline-scroll'); await scroll.evaluate(e => { e.scrollLeft = e.scrollWidth; });
  row = page.locator('[data-track-id="music"]'); await expect(row.locator('.audio-region')).toHaveCount(1);
  await row.locator('.audio-region').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Supprimer la zone', exact: true }).click();
  expect((await saved(page)).tracks.find((t: any) => t.id === 'music').regions).toEqual([first]);
  await page.reload(); expect((await saved(page)).tracks.find((t: any) => t.id === 'music').regions).toEqual([first]);
});

test('deleting a silent region restores actual browser audio at the same timeline position', async ({ page }) => {
  await nativeMock(page);
  await page.addInitScript(() => {
    const taps: AnalyserNode[] = [], connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (...args: any[]) { const result = (connect as any).apply(this, args); if (this instanceof GainNode && args[0] === this.context.destination) { const tap = this.context.createAnalyser(); tap.fftSize = 1024; (connect as any).call(this, tap); taps.push(tap); } return result; };
    (window as any).__contextRms = () => Math.max(0, ...taps.map(t => { const d = new Float32Array(t.fftSize); t.getFloatTimeDomainData(d); return Math.sqrt(d.reduce((n, x) => n + x * x, 0) / d.length); }));
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled(); await page.evaluate(() => (window as any).__completeSeparation());
  await page.getByRole('button', { name: 'Sélectionner une zone audio (ou Maj + glisser)', exact: true }).click();
  const row = await select(page, 'speech'); await controls(page).getByRole('button', { name: 'Rendre la zone silencieuse', exact: true }).click(); await saved(page);
  await page.getByRole('button', { name: 'Écouter Voix en solo', exact: true }).click();
  const pos = async () => { await page.locator('video').evaluate((v: HTMLVideoElement) => { v.currentTime = 1.5; }); await expect(page.locator('video')).toHaveJSProperty('seeking', false); };
  const rms = () => page.evaluate(() => (window as any).__contextRms());
  await pos(); await page.getByRole('button', { name: 'Lecture', exact: true }).click(); await expect.poll(rms).toBeLessThan(.000001);
  await row.locator('.audio-region').click({ button: 'right' }); await saved(page);
  await page.getByRole('menuitem', { name: 'Supprimer la zone', exact: true }).click();
  await pos(); await expect.poll(rms).toBeGreaterThan(.01); await page.getByRole('button', { name: 'Pause', exact: true }).click();
});
