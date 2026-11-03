import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const panel = (page: Page) => page.getByRole('region', { name: 'Doublage', exact: true });
const state = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.line-select').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
  await page.locator('.line-select').first().click();
  await page.getByRole('tab', { name: 'Doublage', exact: true }).click();
  return panel(page);
}
async function generate(page: Page) {
  const dub = panel(page);
  await dub
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await dub.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  await expect(dub.locator('.current-job-progress')).toBeVisible();
}

test('nonmodal dubbing leaves the video, dialogue list and timeline interactive during generation', async ({
  page,
}) => {
  const dub = await ready(page);
  await expect(page.locator('.panel-backdrop')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Doublage', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.screenshot({ path: 'docs/screenshots/dubbing-inspector-fr.png' });
  await generate(page);
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const ruler = await page.locator('.ruler').boundingBox();
  await page.mouse.click(ruler!.x + 60, ruler!.y + 10);
  await expect(dub.locator('.current-job-progress')).toBeVisible();
  await page.locator('.line-select').nth(1).click();
  await expect(
    dub.getByRole('textbox', { name: 'Texte qui sera prononcé', exact: true }),
  ).toHaveValue((await state(page)).targetCues[1].text);
  await expect(page.locator('.panel-backdrop')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/screenshots/dubbing-inspector-fr.png' });
});

test('hidden dubbing keeps settings and progress without stealing focus on completion', async ({
  page,
}) => {
  const dub = await ready(page),
    before = await state(page);
  await dub
    .getByRole('textbox', { name: 'Texte qui sera prononcé', exact: true })
    .fill('Une nouvelle interprétation.');
  await generate(page);
  await page.getByRole('tab', { name: 'Prononciation', exact: true }).click();
  const text = page.getByRole('textbox', { name: 'Texte pour la voix', exact: true });
  await text.focus();
  await page.evaluate(() => (window as any).__completeTts());
  await expect(text).toBeFocused();
  await expect(text).toHaveValue('Une nouvelle interprétation.');
  await page.getByRole('tab', { name: 'Doublage', exact: true }).click();
  await expect(dub.locator('.generation-card.selected')).toBeFocused();
  await expect(dub.locator('.current-job-progress')).toContainText('Terminé');
  expect((await state(page)).generations.slice(0, before.generations.length)).toEqual(
    before.generations,
  );
});

test('completion stays bound to its original reply while another reply is selected', async ({
  page,
}) => {
  const dub = await ready(page),
    before = await state(page);
  await generate(page);
  await page.locator('.line-select').nth(1).click();
  const navigation = dub.getByRole('button', { name: 'Texte', exact: true });
  await navigation.focus();
  await page.evaluate(() => (window as any).__completeTts());
  await expect(navigation).toBeFocused();
  await expect(dub.locator('.current-job-progress')).toHaveCount(0);
  const after = await state(page);
  expect(after.dialogues[1].selectedGenerationIds).toEqual(
    before.dialogues[1].selectedGenerationIds,
  );
  expect(after.generations.at(-1).dialogueId).toBe(before.dialogues[0].id);
  await page.locator('.line-select').first().click();
  await expect(dub.locator('.current-job-progress')).toContainText('Terminé');
  await expect(dub.locator('.generation-card.selected')).toBeFocused();
});

test('a deferred job ID is retained after changing reply and returning', async ({ page }) => {
  const dub = await ready(page);
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (...args: any[]) => {
      const result = await invoke(...args);
      if (args[0] === 'generate_line')
        return new Promise((resolve) => {
          w.__releaseLaunch = () => resolve(result);
        });
      return result;
    };
  });
  await generate(page);
  await page.locator('.line-select').nth(1).click();
  await page.evaluate(() => {
    (window as any).__completeTts();
    (window as any).__releaseLaunch();
  });
  await expect(dub.locator('.current-job-progress')).toHaveCount(0);
  await page.locator('.line-select').first().click();
  await expect(dub.locator('.current-job-progress')).toContainText('Terminé');
  await expect(dub.locator('.generation-card.selected')).toBeFocused();
});

test('single and batch modes keep independent settings and opening another tool restores the dubbing tab', async ({
  page,
}) => {
  const dub = await ready(page);
  await dub.getByRole('combobox', { name: 'Nombre d’essais', exact: true }).selectOption('3');
  await dub.getByRole('button', { name: 'Lot', exact: true }).click();
  const batch = page.getByRole('region', { name: 'Doublage par lot', exact: true });
  await batch
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await batch.getByRole('spinbutton', { name: 'Graine', exact: true }).fill('43');
  await batch.getByRole('button', { name: 'Réplique', exact: true }).click();
  await expect(dub.getByRole('combobox', { name: 'Nombre d’essais', exact: true })).toHaveValue(
    '3',
  );
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const models = page.getByRole('dialog', { name: 'Modèles', exact: true });
  await models.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(dub).toBeVisible();
  await dub.getByRole('button', { name: 'Lot', exact: true }).click();
  await expect(batch.getByRole('spinbutton', { name: 'Graine', exact: true })).toHaveValue('43');
});

test('dubbing width is independent from text width and all panes fit at 1024 pixels', async ({
  page,
}) => {
  const dub = await ready(page);
  const right = page.getByRole('separator', {
    name: 'Redimensionner le panneau de sous-titres',
    exact: true,
  });
  await expect(right).toHaveAttribute('aria-valuenow', '430');
  await right.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', '440');
  await page.getByRole('tab', { name: 'Texte', exact: true }).click();
  await expect(right).toHaveAttribute('aria-valuenow', '340');
  await page.getByRole('tab', { name: 'Doublage', exact: true }).click();
  await expect(right).toHaveAttribute('aria-valuenow', '440');
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect
    .poll(() => page.locator('.player-pane').evaluate((e) => e.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(319);
  const geometry = await page.evaluate(() => ({
    video: document.querySelector('.player-pane')!.getBoundingClientRect().width,
    left: document.querySelector('.dialogues-pane')!.getBoundingClientRect().width,
    overflow: document.documentElement.scrollWidth - innerWidth,
    dubOverflow:
      document.querySelector('.dub-panel')!.scrollWidth -
      document.querySelector('.dub-panel')!.clientWidth,
  }));
  expect(geometry.video).toBeGreaterThanOrEqual(319);
  expect(geometry.left).toBeGreaterThanOrEqual(240);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  expect(geometry.dubOverflow).toBeLessThanOrEqual(1);
  await expect(
    dub.getByRole('button', { name: 'Générer un nouvel essai', exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: 'docs/screenshots/dubbing-inspector-1024-fr.png' });
  await page.reload();
  await page.locator('.line-select').first().click();
  await page.getByRole('tab', { name: 'Doublage', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('studio.dubbingInspectorWidth'))).toBe(
    '440',
  );
});

test('inspector tabs support arrow navigation and Space on Generate does not also play the video', async ({
  page,
}) => {
  const dub = await ready(page);
  const tab = page.getByRole('tab', { name: 'Doublage', exact: true });
  await tab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Prononciation', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(tab).toBeFocused();
  await dub
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  await dub.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(dub.locator('.current-job-progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeVisible();
  expect(
    await page
      .locator('video')
      .first()
      .evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
});
