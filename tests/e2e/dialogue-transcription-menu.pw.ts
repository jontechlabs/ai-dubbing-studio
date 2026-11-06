import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

const current = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
const calls = (page: Page) =>
  page.evaluate(() =>
    (window as any).__calls.filter((c: any) => c.command === 'transcribe_dialogue_source'),
  );
const modal = (page: Page) =>
  page.getByRole('dialog', { name: 'Transcrire le dialogue…', exact: true });
async function ready(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
}
async function open(page: Page, index = 0) {
  await page.locator('.dialogue-card').nth(index).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Transcrire le dialogue…', exact: true }).click();
  await expect(modal(page)).toBeVisible();
  return modal(page);
}
async function complete(page: Page, texts = ['日本語の訂正。'], noSpeech = false) {
  await modal(page).getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await page.evaluate(
    ({ texts, noSpeech }) => (window as any).__completeSourceTranscription(texts, noSpeech),
    { texts, noSpeech },
  );
  await expect(
    modal(page).getByRole('textbox', { name: 'Proposition source 1', exact: true }),
  ).toBeVisible();
}

test('context targets the clicked dialogue without moving selection or playback and allows source language and track', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    (window as any).__completeSeparation();
    (window as any).__llmReady = false;
  });
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await expect(page.locator('video')).toHaveJSProperty('seeking', false);
  const before = await current(page),
    dialog = await open(page, 1);
  await expect(dialog).toContainText('Réplique 2');
  expect(await calls(page)).toHaveLength(0);
  await dialog.getByRole('combobox', { name: 'Langue de l’audio source' }).selectOption('ja');
  await dialog.getByRole('combobox', { name: 'Piste à transcrire' }).selectOption('speech');
  await complete(page);
  expect((await calls(page))[0].args.options).toEqual({
    lineId: before.dialogues[1].id,
    language: 'ja',
    trackId: 'speech',
  });
  expect(await page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBe(1);
  expect((await current(page)).sourceCues).toEqual(before.sourceCues);
  await expect(page.locator('.dialogue-card').first()).toHaveClass(/selected/);
  await page.screenshot({ path: 'docs/screenshots/dialogue-transcription-menu-fr.png' });
});

test('keep source closes the proposal without changing either SRT or existing takes', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page);
  await open(page);
  await complete(page);
  await modal(page)
    .getByRole('textbox', { name: 'Proposition source 1', exact: true })
    .fill('Autre texte proposé');
  await modal(page).getByRole('button', { name: 'Conserver le SRT source', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  const after = await current(page);
  expect(after.sourceCues).toEqual(before.sourceCues);
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.generations).toEqual(before.generations);
});

test('explicit replacement updates only the clicked source text, retains timings and takes, and supports undo', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page);
  await open(page, 1);
  await complete(page);
  await modal(page)
    .getByRole('textbox', { name: 'Proposition source 1', exact: true })
    .fill('確認した日本語。');
  await modal(page).getByRole('button', { name: 'Remplacer le SRT source', exact: true }).click();
  await expect(modal(page)).toHaveCount(0);
  const after = await current(page),
    targetId = before.dialogues[1].sourceCueIds[0];
  expect(after.sourceCues).toEqual(
    before.sourceCues.map((c: any) => (c.id === targetId ? { ...c, text: '確認した日本語。' } : c)),
  );
  expect(after.targetCues).toEqual(before.targetCues);
  expect(after.generations).toEqual(before.generations);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await current(page)).sourceCues).toEqual(before.sourceCues);
});

test('closing a running transcription never applies it and reopening reviews the same finished result', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page);
  await open(page);
  await modal(page).getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).__completeSourceTranscription());
  await open(page);
  await expect(
    modal(page).getByRole('textbox', { name: 'Proposition source 1', exact: true }),
  ).toHaveValue('日本語の訂正。');
  expect(await calls(page)).toHaveLength(1);
  expect((await current(page)).sourceCues).toEqual(before.sourceCues);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await open(page);
  await expect(
    modal(page).getByRole('textbox', { name: 'Proposition source 1', exact: true }),
  ).toHaveValue('日本語の訂正。');
});

test('cancel, failure and silent audio leave the source intact and cannot be accepted as replacements', async ({
  page,
}) => {
  await ready(page);
  const before = await current(page);
  await open(page);
  await modal(page).getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await modal(page).getByRole('button', { name: 'Annuler', exact: true }).click();
  await expect(
    modal(page).getByRole('button', { name: 'Transcrire l’audio source', exact: true }),
  ).toBeEnabled();
  await modal(page).getByRole('button', { name: 'Transcrire l’audio source', exact: true }).click();
  await page.evaluate(() => (window as any).__failTranscription());
  await expect(modal(page).getByRole('alert')).toBeVisible();
  await complete(page, [], true);
  await expect(modal(page).getByText(/Aucune parole exploitable/)).toBeVisible();
  await expect(
    modal(page).getByRole('button', { name: 'Remplacer le SRT source', exact: true }),
  ).toBeDisabled();
  expect((await current(page)).sourceCues).toEqual(before.sourceCues);
});

test('multi-cue proposals are editable, empty text and changed source ranges block application', async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const p = (window as any).__getMockProject();
    p.dialogues[0].sourceCueIds.push(p.sourceCues[1].id);
    (window as any).__loadMockProject(p);
  });
  const before = await current(page);
  await open(page);
  await complete(page, ['第一。', '第二。']);
  const dialog = modal(page),
    accept = dialog.getByRole('button', { name: 'Remplacer le SRT source', exact: true });
  await expect(
    dialog.getByRole('textbox', { name: 'Proposition source 2', exact: true }),
  ).toHaveValue('第二。');
  await dialog.getByRole('textbox', { name: 'Proposition source 2', exact: true }).fill(' ');
  await expect(accept).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Proposition source 2', exact: true }).fill('第二。');
  await expect(accept).toBeEnabled();
  await page.evaluate(() => (window as any).__setFirstSlot(4500));
  await expect(accept).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('ont changé');
  expect((await current(page)).sourceCues).toEqual(before.sourceCues);
});
