import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('right-click resets only the clicked voice duration, retaining offset, edits, takes and undo', async ({ page }) => {
  await nativeMock(page); await page.goto('/'); await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => { (window as any).__seedDubbing(); (window as any).__moveFirstDubbing(350); });
  const block = page.getByRole('button', { name: 'Doublage 1', exact: true });
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width + 25, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!)), id = before.dialogues[0].id;
  expect(before.dubbingTiming.durationsMs[id].fr).toBeGreaterThan(2000);
  await page.locator('video').evaluate((video: HTMLVideoElement) => { video.currentTime = 6; }); await expect(page.locator('video')).toHaveJSProperty('seeking', false);
  await block.click({ button: 'right' }); const reset = page.getByRole('menuitem', { name: 'Réinitialiser la durée', exact: true }); await expect(reset).toBeEnabled();
  await page.screenshot({ path: 'test-results/screenshots/reset-dubbing-duration.png' }); await reset.click(); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
  expect(after.dubbingTiming.durationsMs[id].fr).toBeUndefined(); expect(after.dubbingTiming.offsetsMs).toEqual(before.dubbingTiming.offsetsMs);
  for (const key of ['generations', 'voiceEdits', 'sourceCues', 'targetCues', 'dialogues', 'media']) expect(after[key]).toEqual(before[key]);
  expect(await page.locator('video').evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(6);
  await block.click({ button: 'right' }); await expect(reset).toBeDisabled(); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!))).dubbingTiming).toEqual(before.dubbingTiming);
});
