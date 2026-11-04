import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
const snapshot = (page: Page) => page.evaluate(() => (window as any).__getMockProject());

test('footer review controls identify all three states with icons and explicit next actions', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).__clearTranslation(0));
  const cards = page.locator('.dialogue-card');
  await cards
    .nth(2)
    .getByRole('button', { name: 'Valider la traduction de la réplique 3', exact: true })
    .click();
  const states = ['untranslated', 'translated', 'approved'];
  const icons = [];
  for (const [i, state] of states.entries()) {
    const card = cards.nth(i),
      button = card.locator(`.card-footer .translation-review button.${state}`);
    await expect(button).toBeVisible();
    await expect(card.locator(':scope > .translation-review')).toHaveCount(0);
    await expect(button.locator('.translation-state-icon')).toBeVisible();
    icons.push(await button.locator('.translation-state-icon').innerHTML());
    await expect(page.locator(`.translation-legend .${state} svg`)).toBeVisible();
  }
  expect(new Set(icons).size).toBe(3);
  await expect(cards.first().locator('.translation-review button')).toBeDisabled();
  await expect(cards.nth(1).locator('.translation-review button')).toHaveAttribute(
    'title',
    /✓.*valider/,
  );
  await expect(cards.nth(2).locator('.translation-review button')).toHaveAttribute(
    'title',
    /↶.*retirer la validation/,
  );
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 940 });
    for (const card of await cards.all()) {
      const footer = card.locator('.card-footer');
      expect(await footer.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
      const f = await footer.boundingBox(),
        b = await footer.locator('.translation-review button').boundingBox();
      expect(b!.x).toBeGreaterThanOrEqual(f!.x);
      expect(b!.x + b!.width).toBeLessThanOrEqual(f!.x + f!.width + 1);
      const boxes = await footer
        .locator(':scope > button, :scope > .translation-review')
        .evaluateAll((es) =>
          es.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, right: r.right })),
        );
      expect(boxes.every((r, i) => i === 0 || r.x >= boxes[i - 1].right - 1)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1440 });
  await page.locator('.dialogue-scroll').evaluate((e) => (e.scrollTop = 0));
  await expect(cards.first()).toBeInViewport();
  await page
    .locator('.dialogues-pane')
    .screenshot({ path: 'docs/screenshots/dialogue-review-actions-fr.png' });
});

test('Space and Enter approve and withdraw review without playing video, seeking, changing selection or replacing takes', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).__seedDubbing());
  const cards = page.locator('.dialogue-card');
  await cards.nth(1).locator('.line-select').click();
  const before = await snapshot(page),
    video = page.locator('video').first();
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 5;
  });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(5, 1);
  const time = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  const review = cards.first().locator('.translation-review button');
  await review.focus();
  await page.keyboard.press('Space');
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await expect(review).toContainText('Traduction validée');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await expect(page.locator('.dialogue-card.selected .line-number')).toHaveText('02');
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  expect(await video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(time, 1);
  let after = await snapshot(page);
  for (const key of ['generations', 'sourceCues', 'targetCues'])
    expect(after[key]).toEqual(before[key]);
  expect(after.translationApprovals[before.dialogues[0].id]).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(review).toHaveAttribute('aria-pressed', 'false');
  await expect(review).toContainText('À revoir');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.keyboard.press('Control+z');
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  after = await snapshot(page);
  expect(after.generations).toEqual(before.generations);
  expect(await video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
});

test('review controls explain missing translations and offer explicit stale-take acceptance', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.evaluate(() => (window as any).__clearTranslation(0));
  const cards = page.locator('.dialogue-card');
  const missing = cards.first().locator('.translation-review button');
  await expect(missing).toBeDisabled();
  await expect(missing).toHaveAttribute('title', /Ajoutez une traduction/);
  const before = await snapshot(page);
  await cards.nth(1).locator('.line-select').click();
  await page
    .getByRole('textbox', { name: 'Sous-titre affiché', exact: true })
    .fill('Texte modifié après la génération.');
  const stale = cards.nth(1).locator('.translation-review button');
  await expect(stale).toBeEnabled();
  await expect(stale).toHaveAttribute('title', /vérifier les changements/);
  const after = await snapshot(page);
  expect(after.generations).toEqual(before.generations);
});
