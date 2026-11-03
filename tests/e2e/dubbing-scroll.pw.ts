import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
const dub = (page: Page) => page.getByRole('region', { name: 'Doublage', exact: true });
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.line-select').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.line-select').first().click();
  await page.getByRole('tab', { name: 'Doublage', exact: true }).click();
}
async function fitted(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        x: document.documentElement.scrollWidth - innerWidth,
        y: document.documentElement.scrollHeight - innerHeight,
        scrollX,
        scrollY,
      })),
    )
    .toEqual({ x: 0, y: 0, scrollX: 0, scrollY: 0 });
  await expect(page.locator('.statusbar')).toBeInViewport();
}
test('dubbing keeps the document fitted while its content scrolls at different window sizes', async ({
  page,
}) => {
  await ready(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  const scroller = dub(page).locator('.dub-panel');
  for (const size of [
    { width: 1440, height: 940 },
    { width: 1536, height: 810 },
    { width: 1024, height: 720 },
    { width: 1920, height: 1200 },
  ]) {
    await page.setViewportSize(size);
    await fitted(page);
    expect(await scroller.evaluate((e) => e.scrollHeight - e.clientHeight)).toBeGreaterThan(500);
    expect(
      await scroller
        .locator('.sr-only')
        .evaluateAll((es) =>
          es.every((e) => (e as HTMLElement).offsetParent?.classList.contains('dub-panel')),
        ),
    ).toBe(true);
    await dub(page).getByRole('button', { name: 'Outils', exact: true }).click();
    await expect.poll(() => scroller.evaluate((e) => e.scrollTop)).toBeGreaterThan(100);
    await fitted(page);
    await scroller.evaluate((e) => (e.scrollTop = 0));
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  await page.screenshot({ path: 'docs/screenshots/dubbing-scroll-fixed-fr.png', fullPage: true });
  expect(await page.evaluate(() => (window as any).__getMockProject())).toEqual(before);
});
test('completed takes, expanded logs and retained batch controls never scroll the main window', async ({
  page,
}) => {
  await ready(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await dub(page)
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await dub(page).getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  await page.evaluate(() => (window as any).__completeTts());
  await expect(dub(page).locator('.generation-card.selected')).toBeFocused();
  await fitted(page);
  await page.evaluate(() => {
    (window as any).__timedJob({
      id: 'tts-job',
      projectId: (window as any).__getMockProject().id,
      kind: 'tts',
      status: 'succeeded',
      stage: 'done',
      progress: 1,
      logs: ['Diagnostic '.repeat(1000)],
      error: null,
    });
  });
  await dub(page).locator('.dub-task-progress summary').click();
  await expect(dub(page).locator('.dub-task-progress pre')).toContainText('Diagnostic');
  await fitted(page);
  // The retained batch form also has an output-volume label deep in its content.
  await dub(page).getByRole('button', { name: 'Lot', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await expect(batch).toBeVisible();
  await fitted(page);
  await batch.getByRole('button', { name: 'Réplique', exact: true }).click();
  await expect(dub(page).locator('.generation-card.selected')).toBeVisible();
  await fitted(page);
  await page.getByRole('tab', { name: 'Texte', exact: true }).click();
  await fitted(page);
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
});
