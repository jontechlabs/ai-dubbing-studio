import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const project = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
    // Real jobs save before notifying the UI. Persist this synthetic job too,
    // so reloading tests layout preferences against the same saved project.
    localStorage.setItem('nativeMockProject', JSON.stringify((window as any).__getMockProject()));
  });
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').last().click();
}
async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        overflow: element.scrollWidth - element.clientWidth,
      };
    };
    return {
      left: box('.dialogues-pane'),
      player: box('.player-pane'),
      right: box('.inspector-workspace'),
      timeline: box('.timeline-container'),
      controls: box('.player-controls'),
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}
async function fits(page: Page) {
  const rect = await geometry(page);
  expect(rect.left.right).toBeLessThanOrEqual(rect.player.left);
  expect(rect.player.right).toBeLessThanOrEqual(rect.right.left);
  expect(rect.player.width).toBeGreaterThanOrEqual(319);
  expect(rect.left.top).toBeCloseTo(rect.player.top, 0);
  expect(rect.player.top).toBeCloseTo(rect.right.top, 0);
  expect(rect.timeline.left).toBeCloseTo(rect.left.left, 0);
  expect(rect.timeline.right).toBeCloseTo(rect.right.right, 0);
  expect(rect.timeline.top).toBeGreaterThanOrEqual(rect.player.bottom);
  expect(rect.pageOverflow).toBeLessThanOrEqual(1);
  expect(rect.controls.overflow).toBeLessThanOrEqual(1);
  expect(rect.right.overflow).toBeLessThanOrEqual(1);
}

test('three panes stay coherent, resize with mouse and keyboard, and fit a smaller monitor without overwriting preferences', async ({
  page,
}) => {
  await ready(page);
  await page.locator('.line-select').first().click();
  await fits(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fits(page);
  await page.locator('.dialogue-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: 'docs/screenshots/workspace-three-panels-fr.png' });
  await page.setViewportSize({ width: 1440, height: 940 });
  const before = await project(page);
  const left = page.getByRole('separator', { name: 'Redimensionner les panneaux', exact: true });
  const right = page.getByRole('separator', {
    name: 'Redimensionner le panneau de sous-titres',
    exact: true,
  });
  await right.focus();
  const startRight = Number(await right.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  await expect(right).toHaveAttribute('aria-valuenow', String(startRight + 10));
  const bounds = (await left.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 50, bounds.y + 40, { steps: 8 });
  await page.mouse.up();
  const saved = await page.evaluate(() => localStorage.getItem('studio.workspaceWidths'));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('studio.workspaceWidths'))).toBe(saved);
  await page.locator('.line-select').first().click();
  await fits(page);
  await page.setViewportSize({ width: 1000, height: 700 });
  await expect.poll(async () => (await geometry(page)).player.width).toBeGreaterThanOrEqual(319);
  await fits(page);
  await page.screenshot({ path: 'docs/screenshots/workspace-small-screen-fr.png' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await fits(page);
  expect(await page.evaluate(() => localStorage.getItem('studio.workspaceWidths'))).toBe(saved);
  expect(await project(page)).toEqual(before);
});

test('invalid saved panel widths recover without placing the inspector outside the window', async ({
  page,
}) => {
  await nativeMock(page);
  await page.addInitScript(() =>
    localStorage.setItem('studio.workspaceWidths', '{"left":"NaN","right":99999999}'),
  );
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await fits(page);
});

test('effect settings use a focus-contained modal and Escape restores the audio panel and opener', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const audio = page.getByRole('dialog', { name: 'Audio', exact: true });
  const fx = audio.locator('.audio-effects-panel');
  await fx.locator(':scope > summary').click();
  await fx.getByRole('combobox', { name: 'Préréglage audio', exact: true }).selectOption('warm');
  const before = await project(page);
  await expect(fx.getByRole('slider')).toHaveCount(0);
  const opener = fx.getByRole('button', { name: 'Régler Égaliseur · effet 1', exact: true });
  await opener.click();
  const modal = page.getByRole('dialog', { name: 'Réglages · Égaliseur', exact: true });
  await expect(modal).toBeVisible();
  await modal.getByRole('slider').first().fill('6');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Tab');
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(audio).toBeVisible();
  await expect(opener).toBeFocused();
  expect(await project(page)).toEqual(before);
  await opener.click();
  await expect(modal.getByRole('slider').first()).toHaveValue('6');
  await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  await opener.click();
  await page.mouse.click(5, 500);
  await expect(modal).toHaveCount(0);
  await expect(audio).toBeVisible();
  await expect(opener).toBeFocused();
});

test('duplicate effect instances keep independent parameters when reordered and bypassed, with the eight-effect limit preserved', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
  const editor = page.getByRole('region', { name: 'Édition du doublage', exact: true });
  const fx = editor.locator('.voice-effects-panel');
  await fx.locator(':scope > summary').click();
  await fx.getByRole('combobox', { name: 'Effet à ajouter', exact: true }).selectOption('pitch');
  for (const [number, value] of [
    [1, '4'],
    [2, '-2'],
  ] as const) {
    await fx.getByRole('button', { name: 'Ajouter un effet', exact: true }).click();
    await fx
      .getByRole('button', { name: `Régler Pitch / hauteur · effet ${number}`, exact: true })
      .click();
    const modal = page.getByRole('dialog', { name: 'Réglages · Pitch / hauteur', exact: true });
    await modal.getByRole('slider').first().fill(value);
    if (number === 2) {
      await modal.getByRole('button', { name: 'Monter l’effet 2', exact: true }).click();
      await expect(modal.getByRole('slider').first()).toHaveValue('-2');
    }
    await modal.getByRole('button', { name: 'Terminer', exact: true }).click();
  }
  await fx.getByRole('button', { name: 'Activer Pitch / hauteur · effet 1', exact: true }).click();
  const before = await project(page);
  await fx.getByRole('button', { name: 'Appliquer les effets au doublage', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const after = await project(page);
  expect(after.voiceEdits['take-1'].pieces[0].effects).toMatchObject([
    { kind: 'pitch', enabled: false, parameters: { semitones: -2 } },
    { kind: 'pitch', enabled: true, parameters: { semitones: 4 } },
  ]);
  expect(after.generations).toEqual(before.generations);
  for (let i = 0; i < 6; i++)
    await fx.getByRole('button', { name: 'Ajouter un effet', exact: true }).click();
  await expect(fx.locator('.effect-chip')).toHaveCount(8);
  await expect(fx.getByRole('button', { name: 'Ajouter un effet', exact: true })).toBeDisabled();
  expect((await fx.locator('.effects-chain').boundingBox())!.height).toBeLessThan(300);
  await fx.getByRole('button', { name: 'Retirer l’effet 8', exact: true }).click();
  await expect(fx.getByRole('button', { name: 'Ajouter un effet', exact: true })).toBeEnabled();
});
