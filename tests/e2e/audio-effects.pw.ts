import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
const project = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('nativeMockProject')!));
const saved = (page: Page) => expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
  await page.locator('.job-notice .notice-close').last().click();
}

test('global faders reach 400 percent independently of regions and persist with undo', async ({
  page,
}) => {
  await ready(page);
  for (const [id, name] of [
    ['original', 'Original'],
    ['speech', 'Voix'],
    ['music', 'Musique'],
    ['sfx', 'Effets'],
    ['dubbing', 'Doublage'],
  ]) {
    const before = await project(page),
      regions = before.tracks.find((t: any) => t.id === id).regions;
    const row = page
      .locator('.track-label')
      .filter({ has: page.getByRole('button', { name: `Volume global · ${name}`, exact: true }) });
    await row.getByRole('button', { name: `Volume global · ${name}`, exact: true }).click();
    const popup = page.getByRole('dialog', { name: `Volume global · ${name}`, exact: true });
    await popup.getByRole('slider').fill('4');
    await saved(page);
    expect((await project(page)).tracks.find((t: any) => t.id === id).gain).toBe(4);
    expect((await project(page)).tracks.find((t: any) => t.id === id).regions).toEqual(regions);
    if (id === 'music')
      await page.screenshot({ path: 'docs/screenshots/track-global-volume-fr.png' });
    await popup.getByRole('spinbutton').focus();
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
  }
  await page.keyboard.press('Control+z');
  await saved(page);
  expect((await project(page)).tracks.find((t: any) => t.id === 'dubbing').gain).toBe(1);
  await page.keyboard.press('Control+y');
  await saved(page);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Volume global · Doublage', exact: true }),
  ).toHaveText('400%');
  expect((await project(page)).formatVersion).toBe(18);
});

test('voice effect preview keeps project dry until applied and later changes replace the chain', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Doublage 1', exact: true }).dblclick();
  const editor = page.getByRole('region', { name: 'Édition du doublage', exact: true });
  await editor
    .getByRole('spinbutton', { name: 'Début de la sélection (ms)', exact: true })
    .fill('400');
  await editor
    .getByRole('spinbutton', { name: 'Fin de la sélection (ms)', exact: true })
    .fill('900');
  const fx = editor.locator('.voice-effects-panel');
  await fx.locator('summary').click();
  await fx.getByRole('combobox', { name: 'Effet à ajouter', exact: true }).selectOption('pitch');
  await fx.getByRole('button', { name: 'Ajouter un effet', exact: true }).click();
  await fx.getByRole('slider').first().fill('4');
  const before = await project(page);
  await fx.getByRole('button', { name: 'Écouter avec ces effets', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__calls.some(
          (c: any) =>
            c.command === 'dubbing_path' &&
            c.args.edit?.pieces.some((p: any) => p.effects?.[0]?.parameters.semitones === 4),
        ),
      ),
    )
    .toBe(true);
  expect(await project(page)).toEqual(before);
  await fx.getByRole('button', { name: 'Appliquer les effets au doublage', exact: true }).click();
  await saved(page);
  let p = await project(page);
  expect(p.voiceEdits['take-1'].pieces.map((p: any) => p.durationMs)).toEqual([400, 500, 1100]);
  expect(p.voiceEdits['take-1'].pieces[1].effects[0].parameters.semitones).toBe(4);
  expect(p.generations).toEqual(before.generations);
  await fx.getByRole('slider').first().fill('-3');
  await fx.getByRole('button', { name: 'Appliquer les effets au doublage', exact: true }).click();
  await saved(page);
  p = await project(page);
  expect(p.voiceEdits['take-1'].pieces[1].effects).toHaveLength(1);
  expect(p.voiceEdits['take-1'].pieces[1].effects[0].parameters.semitones).toBe(-3);
  await page.screenshot({ path: 'docs/screenshots/audio-effects-voice-fr.png' });
  await fx.getByRole('button', { name: 'Vider la chaîne', exact: true }).click();
  await fx.getByRole('button', { name: 'Appliquer les effets au doublage', exact: true }).click();
  await saved(page);
  expect(
    (await project(page)).voiceEdits['take-1'].pieces.every((p: any) => !p.effects?.length),
  ).toBe(true);
  await page.keyboard.press('Control+z');
  await saved(page);
  expect((await project(page)).voiceEdits['take-1'].pieces[1].effects).toHaveLength(1);
});

test('track effects create an independent copy, edit its immutable baseline and support selection rendering', async ({
  page,
}) => {
  await ready(page);
  await page.getByRole('button', { name: 'Audio', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Audio', exact: true }),
    fx = panel.locator('.audio-effects-panel');
  await fx.locator('summary').click();
  await fx.getByRole('combobox', { name: 'Piste à traiter', exact: true }).selectOption('music');
  await fx.getByRole('combobox', { name: 'Préréglage audio', exact: true }).selectOption('warm');
  const before = await project(page);
  await fx.getByRole('button', { name: 'Créer la piste avec effets', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__pendingEffects?.trackId))
    .toBe('music');
  await page.evaluate(() => (window as any).__completeEffects());
  await expect(
    panel.locator('.mixer-row strong').filter({ hasText: 'Musique · FX' }),
  ).toBeVisible();
  let p = await project(page),
    copy = p.tracks.at(-1);
  expect(copy.path).toMatch(/^stems\/patch-/);
  expect(p.tracks.find((t: any) => t.id === 'music').mute).toBe(true);
  expect(p.tracks.find((t: any) => t.id === 'music').path).toBe(
    before.tracks.find((t: any) => t.id === 'music').path,
  );
  await fx.getByRole('combobox', { name: 'Piste à traiter', exact: true }).selectOption(copy.id);
  const baseline = p.generations.at(-1).effectsSourcePath;
  await fx.getByRole('slider').first().fill('8');
  await fx
    .getByRole('button', { name: 'Mettre à jour les effets de la piste', exact: true })
    .click();
  await page.evaluate(() => (window as any).__completeEffects());
  p = await project(page);
  expect(p.tracks).toHaveLength(before.tracks.length + 1);
  expect(p.generations.at(-1).effectsSourcePath).toBe(baseline);
  expect(p.tracks.at(-1).path).not.toBe(copy.path);
  await page.screenshot({ path: 'docs/screenshots/audio-effects-track-fr.png' });
  await fx.getByRole('combobox', { name: 'Piste à traiter', exact: true }).selectOption('speech');
  await fx
    .getByRole('combobox', { name: 'Étendue des effets', exact: true })
    .selectOption('selection');
  await fx
    .getByRole('combobox', { name: 'Préréglage audio', exact: true })
    .selectOption('telephone');
  await fx.getByRole('button', { name: 'Appliquer les effets à la portion', exact: true }).click();
  await page.evaluate(() => (window as any).__completeEffects());
  expect((await project(page)).generations.at(-1)).toMatchObject({
    kind: 'audioPatch',
    operation: 'effects',
    trackId: 'speech',
    mode: 'replace',
    gain: 1,
  });
});
