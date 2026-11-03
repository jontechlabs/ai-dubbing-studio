import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';

async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.line-select').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
}
async function toolbox(page: Page) {
  await ready(page);
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const panel = page.locator('.audio-toolbox');
  await panel.locator('summary').click();
  await panel.getByRole('spinbutton', { name: 'Début (s)', exact: true }).fill('2.1');
  await panel.getByRole('spinbutton', { name: 'Fin (s)', exact: true }).fill('3.8');
  return panel;
}

test('compact dialogue header uses named icon actions and a single visible review status', async ({
  page,
}) => {
  await ready(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  const tools = page.getByRole('group', { name: 'Actions des répliques', exact: true });
  for (const button of await tools.getByRole('button').all()) {
    await expect(button).toHaveAttribute('aria-label', /.+/);
    await expect(button).toHaveAttribute('title', /.+/);
    expect((await button.textContent())!.trim()).toBe('');
    await expect(button).toBeInViewport();
  }
  const card = page.locator('.dialogue-card').first();
  await expect(card.locator('.translation-review')).toHaveText('● À revoir');
  await expect(card.locator('.card-footer .status')).toHaveText('');
  const scroll = await page.locator('.dialogue-scroll').boundingBox();
  expect(scroll!.height).toBeGreaterThan(95);
  expect(await tools.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: 'docs/screenshots/selection-dialogues-1024-fr.png' });
  await tools.getByRole('button', { name: 'Tout cocher (filtre actuel)', exact: true }).focus();
  await page.keyboard.press('Space');
  expect(
    await page
      .locator('video')
      .first()
      .evaluate((v: HTMLVideoElement) => v.paused),
  ).toBe(true);
});

test('dialogue virtual rows do not overlap after compact multiline cards and width changes', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Toutes les répliques', exact: true }).focus();
  for (const width of [1440, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.locator('[data-dialogue-row]').evaluateAll((rows) => {
          const rects = rows.map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top);
          return rects.every((r, i) => i === 0 || r.top >= rects[i - 1].bottom - 1);
        }),
      )
      .toBe(true);
  }
});

test('model catalog loading is explicit and a failed request can be retried', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (...args: any[]) => {
      if (args[0] === 'audio_toolbox_status') {
        if (w.__catalogFails) throw Error('IO_ERROR');
        return new Promise((resolve) => {
          w.__releaseCatalog = async () => resolve(await invoke(...args));
        });
      }
      return invoke(...args);
    };
  });
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const panel = page.locator('.audio-toolbox');
  await panel.locator('summary').click();
  await expect(panel.getByRole('status')).toContainText('Chargement du catalogue');
  await expect(
    panel.getByRole('combobox', { name: 'Outil de séparation', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseCatalog());
  await expect(panel.locator('.toolbox-loading')).toHaveCount(0);
  await panel.locator('summary').click();
  await page.evaluate(() => ((window as any).__catalogFails = true));
  await panel.locator('summary').click();
  await expect(panel.getByRole('alert')).toBeVisible();
  await page.evaluate(() => ((window as any).__catalogFails = false));
  await panel.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await expect(panel.locator('.toolbox-loading')).toBeVisible();
  await page.evaluate(() => (window as any).__releaseCatalog());
  await expect(panel.locator('.toolbox-load-error')).toHaveCount(0);
  await expect(
    panel.getByRole('combobox', { name: 'Outil de séparation', exact: true }),
  ).toBeEnabled();
});

test('a new range, track, model or panel opening never restores a previous selection result', async ({
  page,
}) => {
  const panel = await toolbox(page);
  const run = panel.getByRole('button', { name: 'Isoler la sélection', exact: true });
  await run.click();
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect(panel.locator('.toolbox-results')).toBeVisible();
  await panel.getByRole('spinbutton', { name: 'Début (s)', exact: true }).fill('2.2');
  await expect(panel.locator('.toolbox-results')).toHaveCount(0);
  await expect(panel.locator('.current-job-progress')).toHaveCount(0);
  await run.click();
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect(panel.locator('.toolbox-results')).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'Outil de séparation', exact: true })
    .selectOption('htdemucs');
  await expect(panel.locator('.toolbox-results')).toHaveCount(0);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  await panel.locator('summary').click();
  await expect(panel.locator('.toolbox-results')).toHaveCount(0);
});

test('a late result response cannot repopulate a different selection', async ({ page }) => {
  const panel = await toolbox(page);
  await page.evaluate(() => {
    const w = window as any,
      invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = async (...args: any[]) => {
      const value = await invoke(...args);
      if (args[0] === 'audio_toolbox_result')
        return new Promise((resolve) => {
          w.__releaseResult = () => resolve(value);
        });
      return value;
    };
  });
  await panel.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__releaseResult))
    .toBe('function');
  await panel.getByRole('spinbutton', { name: 'Fin (s)', exact: true }).fill('3.6');
  await page.evaluate(() => (window as any).__releaseResult());
  await expect(panel.locator('.toolbox-results')).toHaveCount(0);
});

for (const count of [2, 3])
  test(`free audio selection separates ${count} voices and routes only chosen outputs`, async ({
    page,
  }) => {
    const panel = await toolbox(page),
      before = await page.evaluate(() => (window as any).__getMockProject());
    await panel
      .getByRole('combobox', { name: 'Outil de séparation', exact: true })
      .selectOption(count === 2 ? 'mossformer2-16k' : 'sepformer-3mix');
    await panel.getByRole('button', { name: 'Isoler la sélection', exact: true }).click();
    const options = await page.evaluate(() => (window as any).__speakerOptions);
    expect(options).toMatchObject({ startMs: 2100, endMs: 3800, sourceTrackId: 'original' });
    expect(options.lineId).toBeUndefined();
    await page.evaluate(() => (window as any).__completeSpeakerSeparation());
    await expect(panel.locator('.toolbox-output')).toHaveCount(count);
    await expect(
      panel.getByRole('button', { name: 'Appliquer les sorties choisies', exact: true }),
    ).toBeDisabled();
    await panel.getByRole('checkbox', { name: 'Conserver Voix 1', exact: true }).check();
    await panel.getByRole('checkbox', { name: 'Conserver Voix 2', exact: true }).check();
    await panel
      .getByRole('combobox', { name: 'Affectation sur la même période', exact: true })
      .selectOption('replace');
    await expect(
      panel.getByRole('button', { name: 'Appliquer les sorties choisies', exact: true }),
    ).toBeEnabled();
    if (count === 3) {
      await panel
        .getByRole('combobox', { name: 'Affectation sur la même période', exact: true })
        .selectOption('add');
      await panel.getByRole('checkbox', { name: 'Conserver Voix 2', exact: true }).uncheck();
    }
    await panel
      .getByRole('button', { name: 'Appliquer les sorties choisies', exact: true })
      .click();
    const args = await page.evaluate(() => (window as any).__speakerDestinations);
    expect(args.destinations.map((d: any) => d.outputId)).toEqual(
      count === 2 ? ['voice-1', 'voice-2'] : ['voice-1'],
    );
    expect(
      args.destinations.every(
        (d: any) => d.mode === (count === 2 ? 'replace' : 'add') && d.role === 'speech',
      ),
    ).toBe(true);
    const after = await page.evaluate(() => (window as any).__getMockProject());
    expect(after.dialogues).toEqual(before.dialogues);
    expect(after.sourceCues).toEqual(before.sourceCues);
    expect(after.generations).toEqual(before.generations);
    if (count === 3) {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await panel
        .locator('.toolbox-results')
        .screenshot({ path: 'docs/screenshots/selection-multiple-voices-fr.png' });
    }
  });

test('portrait preview and capture share a compact row with a wrapping crop option', async ({
  page,
}) => {
  let p = addCharacter(demoProject(), 'Speaker A');
  p.dialogues[0].characterId = p.characters[0].id;
  await nativeMock(page, false, p);
  await page.goto('/');
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page
    .locator('.character-metadata summary')
    .filter({ hasText: 'Choisir ou recadrer' })
    .click();
  const controls = page.locator('.portrait-actions');
  const preview = await controls
    .getByRole('button', { name: 'Prévisualiser la scène et choisir un visage', exact: true })
    .boundingBox();
  const capture = await controls
    .getByRole('button', { name: 'Capturer la vignette', exact: true })
    .boundingBox();
  expect(preview!.y).toBeCloseTo(capture!.y, 0);
  expect(preview!.x + preview!.width).toBeLessThanOrEqual(capture!.x);
  expect(await controls.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  await controls.screenshot({ path: 'docs/screenshots/selection-portrait-actions-fr.png' });
});
