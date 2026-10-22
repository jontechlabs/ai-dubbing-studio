import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import type { Job } from '../../src/domain/types';

async function emit(page: Page, values: Partial<Job> = {}) {
  await page.evaluate((values) => (window as any).__timedJob({
    id: 'timed-job', projectId: 'demo', kind: 'tts', status: 'running',
    stage: 'ttsGenerate', progress: null, error: null, logs: [],
    timing: { elapsedMs: 0, observedAtMs: Date.now() }, ...values,
  }), values);
}
async function open(page: Page) {
  await page.locator('footer > button').last().click();
  return page.getByRole('dialog', { name: 'Traitements', exact: true });
}

test('silent jobs tick live, survive stage changes and panel reopening, and freeze on pause and completion', async ({ page }) => {
  await nativeMock(page); await page.clock.install(); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await emit(page); const panel = await open(page);
  const card = panel.locator('.job-card').first();
  await expect(card.getByRole('timer')).toHaveText('Temps écoulé : 00:00:00');
  await page.clock.fastForward(2500);
  await expect(card.getByRole('timer')).toHaveText('Temps écoulé : 00:00:02');
  await emit(page, { stage: 'ttsFit', timing: { elapsedMs: 2500, observedAtMs: await page.evaluate(() => Date.now()) } });
  await page.clock.fastForward(1500);
  await expect(card.getByRole('timer')).toHaveText('Temps écoulé : 00:00:04');
  await emit(page, { status: 'paused', timing: { elapsedMs: 4000, observedAtMs: await page.evaluate(() => Date.now()) } });
  await page.clock.fastForward(120000);
  await expect(card.getByRole('timer')).toHaveText('Durée d’exécution : 00:00:04');
  await emit(page, { timing: { elapsedMs: 4000, observedAtMs: await page.evaluate(() => Date.now()) } });
  await panel.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.clock.fastForward(3000);
  await expect(page.locator('footer').getByRole('timer')).toHaveText('Temps écoulé : 00:00:07');
  await open(page);
  await expect(card.getByRole('timer')).toHaveText('Temps écoulé : 00:00:07');
  await emit(page, { status: 'succeeded', stage: 'done', progress: 1, timing: { elapsedMs: 7350, observedAtMs: await page.evaluate(() => Date.now()) } });
  await page.clock.fastForward(3600000);
  await expect(card.getByRole('timer')).toHaveText('Durée d’exécution : 00:00:07');
  await expect(page.locator('footer').getByRole('timer')).toHaveCount(0);
});

test('queue, retries, old records and all terminal states retain independent durations', async ({ page }) => {
  await nativeMock(page); await page.clock.install(); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await emit(page, { status: 'queued' }); const panel = await open(page);
  await page.clock.fastForward(10000);
  await expect(panel.getByRole('timer')).toHaveText('Durée d’exécution : 00:00:00');
  await expect(panel.getByText('En attente', { exact: true })).toHaveCount(2);
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
    await emit(page, { status, timing: { elapsedMs: 64000, observedAtMs: await page.evaluate(() => Date.now()) } });
    await page.clock.fastForward(5000);
    await expect(panel.getByRole('timer')).toHaveText('Durée d’exécution : 00:01:04');
  }
  await emit(page, { id: 'retry', status: 'running' });
  await page.clock.fastForward(2000);
  await expect(panel.locator('.job-card').first().getByRole('timer')).toHaveText('Temps écoulé : 00:00:02');
  await expect(panel.locator('.job-card').nth(1).getByRole('timer')).toHaveText('Durée d’exécution : 00:01:04');
  await emit(page, { id: 'legacy', status: 'succeeded', timing: undefined });
  await expect(panel.locator('.job-card').first().getByRole('timer')).toHaveText('Durée d’exécution : —');
});

test('batch execution time continues across dialogue changes and is visible in processing cards', async ({ page }) => {
  await nativeMock(page); await page.clock.install(); await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await emit(page, { id: 'done', status: 'succeeded', stage: 'done', progress: 1, timing: { elapsedMs: 93750, observedAtMs: await page.evaluate(() => Date.now()) } });
  const batch: Job['batch'] = { total: 4, completed: 1, succeeded: 1, failed: 0, skipped: 0, currentLineId: 'line-2' };
  await emit(page, { id: 'batch', kind: 'ttsBatch', progress: .4, batch, timing: { elapsedMs: 65000, observedAtMs: await page.evaluate(() => Date.now()) } });
  const panel = await open(page);
  await page.clock.fastForward(3000);
  await emit(page, { id: 'batch', kind: 'ttsBatch', progress: .2, batch: { ...batch, completed: 2, succeeded: 2, currentLineId: 'line-3' }, timing: { elapsedMs: 68000, observedAtMs: await page.evaluate(() => Date.now()) } });
  await page.clock.fastForward(1000);
  await expect(panel.locator('.job-card').first().getByRole('timer')).toHaveText('Temps écoulé : 00:01:09');
  await expect(panel.locator('.job-card').nth(1).getByRole('timer')).toHaveText('Durée d’exécution : 00:01:33');
  await page.screenshot({ path: 'docs/screenshots/task-duration-fr.png' });
});
