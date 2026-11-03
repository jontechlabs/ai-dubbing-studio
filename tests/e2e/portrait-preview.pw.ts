import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';

async function setup(page: Page, faces?: unknown[], dimensions = { width: 640, height: 360 }) {
  const p = addCharacter(demoProject(), 'Speaker A');
  p.formatVersion = 26;
  p.dialogues[0].characterId = p.characters[0].id;
  p.dialogues[1].characterId = p.characters[0].id;
  await nativeMock(page, false, p);
  await page.route('**/portrait-preview-*.png', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}"><rect width="100%" height="100%" fill="#242438"/><rect x="12%" y="16%" width="20%" height="48%" fill="#73b4db"/><rect x="60%" y="20%" width="25%" height="50%" fill="#d9b16c"/></svg>`,
    }),
  );
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate((value) => {
    (window as any).__portraitDimensions = value;
  }, dimensions);
  if (faces)
    await page.evaluate((value) => {
      (window as any).__portraitFaces = value;
    }, faces);
  return p;
}
async function open(page: Page, sample = false) {
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page
    .locator('.character-metadata summary')
    .filter({ hasText: 'Choisir ou recadrer' })
    .click();
  if (sample) {
    await page.locator('.character-samples button').filter({ hasText: 'Écouter' }).first().click();
    await expect(page.locator('.character-samples audio')).toHaveJSProperty('paused', false);
  }
  await page.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
  return page.getByRole('dialog', { name: 'Vignette de Speaker A', exact: true });
}
const data = (page: Page) => page.evaluate(() => (window as any).__getMockProject());

test('automatic capture requires choosing among faces and saves the chosen face at the correct source time', async ({
  page,
}) => {
  const p = await setup(page),
    modal = await open(page);
  await expect(modal.getByRole('button', { name: 'Choisir le visage 2' })).toBeVisible();
  await expect(modal.getByRole('button', { name: 'Capturer ce cadrage' })).toBeDisabled();
  const before = await data(page);
  await modal.getByRole('button', { name: 'Choisir le visage 2' }).click();
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  await expect(modal).toHaveCount(0);
  const after = await data(page),
    portrait = after.characterProfiles[p.characters[0].id].portrait;
  expect(portrait.crop).toEqual({ x: 0.6, y: 0.2, width: 0.25, height: 0.5 });
  expect(portrait.atMs).toBe(
    p.dialogues[0].startMs + Math.floor((p.dialogues[0].endMs - p.dialogues[0].startMs) / 2),
  );
  expect(after.media).toEqual(before.media);
  expect(after.generations).toEqual(before.generations);
});

test('seeking invalidates old boxes and refresh uses the exact new time and detection profile', async ({
  page,
}) => {
  await setup(page);
  const modal = await open(page);
  await modal.getByRole('button', { name: 'Choisir le visage 1' }).click();
  await modal.getByRole('spinbutton', { name: 'Position de l’aperçu (s)' }).fill('3.25');
  await expect(modal.getByRole('button', { name: 'Capturer ce cadrage' })).toBeDisabled();
  await expect(modal.getByRole('button', { name: 'Choisir le visage 1' })).toHaveCount(0);
  await modal.getByRole('combobox', { name: 'Type de visages' }).selectOption('anime');
  await modal.getByRole('button', { name: 'Actualiser l’image et les visages' }).click();
  await modal.getByRole('button', { name: 'Choisir le visage 1' }).click();
  const request = await page.evaluate(
    () =>
      (window as any).__calls.filter((c: any) => c.command === 'preview_character_portrait').at(-1)
        .args.options,
  );
  expect(request).toMatchObject({ atMs: 3250, profile: 'anime' });
  await modal.getByRole('spinbutton', { name: 'Cadrage : largeur' }).fill('100');
  await expect(modal.getByRole('button', { name: 'Capturer ce cadrage' })).toBeDisabled();
  await expect(modal.getByRole('alert')).toContainText('entièrement dans l’image');
  await modal.getByRole('spinbutton', { name: 'Cadrage : largeur' }).fill('20');
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  expect(Object.values((await data(page)).characterProfiles)[0]).toMatchObject({
    portrait: { atMs: 3250 },
  });
});

test('a missing detection can be drawn, moved and resized visually within the frame', async ({
  page,
}) => {
  await setup(page, []);
  const modal = await open(page);
  await expect(modal.getByText('Aucun visage détecté', { exact: false })).toBeVisible();
  const overlay = modal.getByRole('region', { name: 'Zone de cadrage de la vignette' });
  await overlay.scrollIntoViewIfNeeded();
  const b = (await overlay.boundingBox())!;
  await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.6);
  await page.mouse.up();
  expect(
    Number(await modal.getByRole('spinbutton', { name: 'Cadrage : largeur' }).inputValue()),
  ).toBeCloseTo(30, 0);
  const crop = modal.locator('.portrait-crop-box'),
    c = (await crop.boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + b.width * 0.1, c.y + c.height / 2 + b.height * 0.1);
  await page.mouse.up();
  expect(
    Number(await modal.getByRole('spinbutton', { name: 'Cadrage : position X' }).inputValue()),
  ).toBeCloseTo(20, 0);
  const handle = (await modal.locator('.portrait-crop-handle.se').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width + 20, b.y + b.height + 20);
  await page.mouse.up();
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  const saved: any = Object.values((await data(page)).characterProfiles)[0];
  expect(saved.portrait.crop.x + saved.portrait.crop.width).toBeLessThanOrEqual(1.000001);
  expect(saved.portrait.crop.y + saved.portrait.crop.height).toBeLessThanOrEqual(1.000001);
});

test('a late frame result cannot restore boxes after seeking elsewhere', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => {
    (window as any).__deferPortraitPreview = true;
  });
  const modal = await open(page);
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).__resolvePortraitPreview))
    .toBe('function');
  await modal.getByRole('spinbutton', { name: 'Position de l’aperçu (s)' }).fill('6');
  await page.evaluate(() => {
    const h = window as any;
    h.__deferPortraitPreview = false;
    h.__resolvePortraitPreview();
  });
  await expect(
    modal.getByRole('button', { name: 'Actualiser l’image et les visages' }),
  ).toBeEnabled();
  await expect(modal.getByRole('button', { name: 'Choisir le visage 1' })).toHaveCount(0);
  await modal.getByRole('button', { name: 'Actualiser l’image et les visages' }).click();
  await modal.getByRole('button', { name: 'Choisir le visage 1' }).click();
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  expect(Object.values((await data(page)).characterProfiles)[0]).toMatchObject({
    portrait: { atMs: 6000 },
  });
});

test('preview playback pauses the main player and closing releases the miniature decoder', async ({
  page,
}) => {
  await setup(page);
  const main = page.locator('video').first();
  await main.evaluate((v: HTMLVideoElement) => v.play());
  const modal = await open(page, true),
    mini = modal.getByLabel('Mini lecteur pour la vignette');
  await expect(page.locator('.character-samples audio')).toHaveJSProperty('paused', true);
  await expect(main).toHaveJSProperty('paused', true);
  await expect(mini).toHaveJSProperty('muted', true);
  await modal.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect(mini).toHaveJSProperty('paused', false);
  const handle = await mini.elementHandle();
  await modal.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(await handle!.evaluate((v: HTMLVideoElement) => v.paused && !v.getAttribute('src'))).toBe(
    true,
  );
  await expect(main).toHaveJSProperty('paused', true);
});

test('a capture error keeps the scene open for correction and retry', async ({ page }) => {
  await setup(page);
  const modal = await open(page),
    before = await data(page);
  await modal.getByRole('button', { name: 'Choisir le visage 2' }).click();
  await page.evaluate(() => {
    (window as any).__capturePortraitError = 'CHARACTER_PORTRAIT_INVALID';
  });
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  await expect(modal.getByRole('alert')).toBeVisible();
  expect((await data(page)).characterProfiles).toEqual(before.characterProfiles);
  await page.evaluate(() => {
    (window as any).__capturePortraitError = null;
  });
  await modal.getByRole('button', { name: 'Capturer ce cadrage' }).click();
  await expect(modal).toHaveCount(0);
  expect((await data(page)).media).toEqual(before.media);
});

test('vertical previews fit a small screen and retain an accessible capture action', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await setup(page, undefined, { width: 360, height: 640 });
  const modal = await open(page);
  await modal.getByRole('button', { name: 'Choisir le visage 2' }).click();
  const stage = (await modal.locator('.portrait-preview-stage').boundingBox())!;
  expect(stage.height).toBeLessThanOrEqual(720 * 0.42 + 2);
  expect(stage.width / stage.height).toBeCloseTo(360 / 640, 1);
  await expect(modal.getByRole('button', { name: 'Capturer ce cadrage' })).toBeInViewport();
  await expect(modal.getByRole('button', { name: 'Choisir le visage 2' })).toBeInViewport({
    ratio: 0.95,
  });
  await page.screenshot({ path: 'test-results/screenshots/portrait-preview-layout.png' });
});
