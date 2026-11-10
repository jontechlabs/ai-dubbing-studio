import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const current = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
const toolbox = (page: Page) => page.locator('.audio-toolbox');
const source = (page: Page) =>
  toolbox(page).getByRole('combobox', { name: 'Piste à analyser', exact: true });
const launch = (page: Page) =>
  toolbox(page).getByRole('button', { name: 'Isoler la sélection', exact: true });
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
  while (await page.locator('.job-notice .notice-close').count())
    await page.locator('.job-notice .notice-close').first().click();
}
async function open(page: Page, index = 0) {
  await page.locator('.dialogue-card').nth(index).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Isoler les voix…', exact: true }).click();
  await expect(source(page)).toBeEnabled();
  return toolbox(page);
}
async function close(page: Page) {
  await page
    .getByRole('dialog', { name: 'Audio', exact: true })
    .getByRole('button', { name: 'Fermer', exact: true })
    .click();
}

test('right-click uses the clicked dialogue range, not the selected reply, and leaves playback and subtitles intact', async ({
  page,
}) => {
  await ready(page);
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await expect(page.locator('video')).toHaveJSProperty('seeking', false);
  const before = await current(page),
    section = await open(page, 1),
    line = before.dialogues[1];
  await expect(section.getByRole('spinbutton', { name: 'Début (s)', exact: true })).toHaveValue(
    String(line.startMs / 1000),
  );
  await expect(section.getByRole('spinbutton', { name: 'Fin (s)', exact: true })).toHaveValue(
    String(line.endMs / 1000),
  );
  await expect(source(page)).toHaveValue('original');
  await expect(
    section.getByRole('combobox', { name: 'Outil de séparation', exact: true }),
  ).toHaveValue('mel-band-roformer-kim');
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(1);
  await expect(page.locator('.dialogue-card').first()).toHaveClass(/selected/);
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) =>
        ['separate_audio_selection', 'separate_dialogue_speakers'].includes(c.command),
      ),
    ),
  ).toEqual([]);
  await source(page).selectOption('sfx');
  await page.screenshot({ path: 'docs/screenshots/dialogue-voice-isolation-fr.png' });
  const after = await current(page);
  expect(after.media).toEqual(before.media);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.generations).toEqual(before.generations);
});

test('source picker dispatches original, all stems and added audio tracks, while excluding dubbing and foreign media', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject();
    p.tracks.push({
      ...p.tracks.find((t: any) => t.id === 'speech'),
      id: 'extra-audio',
      name: 'Autre prise',
      role: undefined,
    });
    p.tracks.push({
      ...p.tracks.find((t: any) => t.id === 'speech'),
      id: 'foreign-audio',
      role: undefined,
      sourcePath: 'other.mkv',
    });
    p.tracks.find((t: any) => t.id === 'sfx').mute = true;
    w.__loadMockProject(p);
  });
  const before = await current(page),
    line = before.dialogues[0];
  await open(page);
  const ids = await source(page)
    .locator('option')
    .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
  expect(ids).toEqual(
    expect.arrayContaining(['original', 'speech', 'music', 'sfx', 'extra-audio']),
  );
  expect(ids).not.toContain('dubbing');
  expect(ids).not.toContain('foreign-audio');
  for (const id of ['original', 'speech', 'music', 'sfx', 'extra-audio']) {
    await source(page).selectOption(id);
    await expect(launch(page)).toBeEnabled();
    await launch(page).click();
    expect(await page.evaluate(() => (window as any).__pendingToolbox)).toMatchObject({
      sourceTrackId: id,
      startMs: line.startMs,
      endMs: line.endMs,
    });
    await page.evaluate(() => (window as any).__completeToolbox());
    await expect(toolbox(page).locator('.toolbox-results')).toBeVisible();
  }
  expect((await current(page)).generations).toEqual(before.generations);
});

test('reviewed outputs apply only at the dialogue timestamps on the chosen track and preserve takes, with undo', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page),
    line = before.dialogues[1],
    section = await open(page, 1);
  await source(page).selectOption('music');
  await launch(page).click();
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect(section.locator('.toolbox-output audio')).toHaveCount(2);
  await expect(
    section.getByRole('button', { name: 'Appliquer les sorties choisies', exact: true }),
  ).toBeDisabled();
  expect((await current(page)).generations).toEqual(before.generations);
  await section
    .getByRole('combobox', { name: 'Destination : Voix', exact: true })
    .selectOption('role:speech');
  await section
    .getByRole('button', { name: 'Appliquer les sorties choisies', exact: true })
    .click();
  await expect(
    section.getByText('Sorties appliquées à la timeline.', { exact: true }),
  ).toBeVisible();
  const after = await current(page);
  expect(after.generations.slice(0, before.generations.length)).toEqual(before.generations);
  expect(after.generations.at(-1)).toMatchObject({
    kind: 'audioPatch',
    sourceTrackId: 'music',
    trackId: 'speech',
    startMs: line.startMs,
    endMs: line.endMs,
  });
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.media).toEqual(before.media);
  await close(page);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(page)).generations).toEqual(before.generations);
});

test('several speakers can be separated from the chosen source and only reviewed voices are routed', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page),
    line = before.dialogues[1],
    section = await open(page, 1);
  await source(page).selectOption('sfx');
  await section
    .getByRole('combobox', { name: 'Outil de séparation', exact: true })
    .selectOption('sepformer-3mix');
  await launch(page).click();
  const options = await page.evaluate(() => (window as any).__speakerOptions);
  expect(options).toMatchObject({ sourceTrackId: 'sfx', startMs: line.startMs, endMs: line.endMs });
  expect(options.lineId).toBeUndefined();
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(section.locator('.toolbox-output audio')).toHaveCount(3);
  await section.getByRole('checkbox', { name: 'Conserver Voix 2', exact: true }).check();
  await section
    .getByRole('combobox', { name: 'Destination : Voix 2', exact: true })
    .selectOption('role:sfx');
  await section
    .getByRole('combobox', { name: 'Affectation sur la même période', exact: true })
    .selectOption('add');
  await section
    .getByRole('button', { name: 'Appliquer les sorties choisies', exact: true })
    .click();
  expect((await page.evaluate(() => (window as any).__speakerDestinations)).destinations).toEqual([
    { outputId: 'voice-2', trackId: null, role: 'sfx', mode: 'add' },
  ]);
  expect((await current(page)).dialogues).toEqual(before.dialogues);
  expect((await current(page)).generations.slice(0, before.generations.length)).toEqual(
    before.generations,
  );
});

test('another dialogue replaces the prior range and does not show or apply its previous result', async ({
  page,
}) => {
  await ready(page);
  await open(page);
  await source(page).selectOption('music');
  await launch(page).click();
  await page.evaluate(() => (window as any).__completeToolbox());
  await expect(toolbox(page).locator('.toolbox-results')).toBeVisible();
  await close(page);
  const before = await current(page),
    line = before.dialogues[1],
    section = await open(page, 1);
  await expect(source(page)).toHaveValue('original');
  await expect(section.getByRole('spinbutton', { name: 'Début (s)', exact: true })).toHaveValue(
    String(line.startMs / 1000),
  );
  await expect(section.locator('.toolbox-results')).toHaveCount(0);
  expect((await current(page)).generations).toEqual(before.generations);
});

test('unsupported dialogue ranges are explained and cannot launch or be silently truncated', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const w = window as any,
      p = w.__getMockProject();
    p.media.durationMs = 80000;
    p.dialogues[0].endMs = 75000;
    w.__loadMockProject(p);
  });
  await page.locator('.dialogue-card').first().click({ button: 'right' });
  await expect(
    page.getByRole('menuitem', {
      name: 'Isoler les voix · intervalle de 0,1 à 60 s requis',
      exact: true,
    }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.command === 'separate_audio_selection'),
    ),
  ).toEqual([]);
});
