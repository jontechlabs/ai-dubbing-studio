import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('whole batch countdown keeps future takes, recalibrates, freezes on pause and clears on completion', async ({
  page,
}) => {
  await nativeMock(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const emit = async (extra: Record<string, unknown> = {}) =>
    page.evaluate(
      (extra) =>
        (window as any).__timedJob({
          id: 'whole-batch',
          projectId: 'demo',
          kind: 'ttsBatch',
          status: 'running',
          stage: 'ttsGenerate',
          progress: null,
          error: null,
          logs: [],
          timing: { elapsedMs: 30000, observedAtMs: Date.now() },
          workEstimate: {
            pendingMs: 90000,
            pendingKnown: 3,
            pendingUnknown: 0,
            active: { jobId: 'whole-batch', estimatedMs: 60000, baselineElapsedMs: 30000 },
          },
          ...extra,
        }),
      extra,
    );
  await emit();
  await page.locator('footer > button').last().click();
  const panel = page.getByRole('dialog', { name: 'Traitements', exact: true }),
    eta = panel.locator('.work-estimate-batch');
  await expect(eta).toContainText('Lot restant : ≈ 00:02:30');
  await page.clock.fastForward(10000);
  await expect(eta).toContainText('00:02:20');
  await page.clock.fastForward(55000);
  await expect(eta).toContainText('≈ 00:01:30 + 1 étape non estimée');
  await expect(eta).toContainText('plus longue que prévu');
  // New successful measurements revise future costs instead of counting time twice.
  await emit({
    timing: { elapsedMs: 95000, observedAtMs: await page.evaluate(() => Date.now()) },
    workEstimate: {
      pendingMs: 40000,
      pendingKnown: 2,
      pendingUnknown: 0,
      active: { jobId: 'whole-batch', estimatedMs: 20000, baselineElapsedMs: 95000 },
    },
  });
  await expect(eta).toContainText('≈ 00:01:00');
  await eta.screenshot({ path: 'docs/screenshots/batch-eta-fr.png' });
  await emit({
    status: 'paused',
    timing: { elapsedMs: 95000, observedAtMs: await page.evaluate(() => Date.now()) },
    workEstimate: {
      pendingMs: 40000,
      pendingKnown: 2,
      pendingUnknown: 0,
      active: { jobId: 'whole-batch', estimatedMs: 20000, baselineElapsedMs: 95000 },
    },
  });
  await page.clock.fastForward(60000);
  await expect(eta).toContainText('00:01:00');
  await expect(eta).toContainText('à la reprise');
  await emit({ status: 'succeeded', stage: 'done' });
  await expect(eta).toHaveCount(0);
});

test('queue displays whole and per-workflow estimates, partial learning and paused work without a false deadline', async ({
  page,
}) => {
  await nativeMock(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.evaluate(() => {
    const w = window as any;
    w.__timedJob({
      id: 'queued-child',
      projectId: 'demo',
      kind: 'ttsBatch',
      status: 'running',
      stage: 'ttsGenerate',
      progress: null,
      error: null,
      logs: [],
      timing: { elapsedMs: 10000, observedAtMs: Date.now() },
    });
    const first = {
      pendingMs: 30000,
      pendingKnown: 1,
      pendingUnknown: 0,
      active: { jobId: 'queued-child', estimatedMs: 60000, baselineElapsedMs: 10000 },
    };
    const later = { pendingMs: 120000, pendingKnown: 2, pendingUnknown: 1, active: null };
    const base = {
      createdAt: new Date().toISOString(),
      projectId: 'demo',
      projectName: 'Projet test',
      error: null,
      separation: false,
      dubbing: true,
      total: 2,
      completed: 0,
      failed: 0,
      currentLineId: null,
      problems: [],
      batchIds: [],
    };
    w.__setWorkflowQueue({
      paused: false,
      workEstimate: { ...later, pendingMs: 150000, pendingKnown: 3, active: first.active },
      entries: [
        {
          ...base,
          id: 'eta-first',
          name: 'Premier lot',
          status: 'running',
          stage: 'dubbing',
          currentJobId: 'queued-child',
          workEstimate: first,
        },
        {
          ...base,
          id: 'eta-next',
          name: 'Lot suivant',
          status: 'pending',
          stage: 'waiting',
          currentJobId: null,
          workEstimate: later,
        },
      ],
    });
  });
  await page
    .getByRole('button', { name: /File des tâches/ })
    .first()
    .click();
  const panel = page.getByRole('dialog', { name: 'File des tâches', exact: true }),
    eta = panel.locator('.work-estimate-queue');
  await expect(eta).toContainText('File restante : ≈ 00:03:30 + 1 étape non estimée');
  await page.clock.fastForward(10000);
  await expect(eta).toContainText('00:03:20');
  await panel.getByRole('button', { name: 'Pause après le lot courant', exact: true }).click();
  await page.clock.fastForward(10000);
  await expect(eta).toContainText('00:03:10');
  await expect(panel.locator('[data-queue-id="eta-next"] .work-estimate')).toContainText(
    'à la reprise',
  );
  await page.evaluate(() => {
    const w = window as any,
      q = w.__getWorkflowQueue();
    q.entries[0].status = 'succeeded';
    q.entries[0].workEstimate = null;
    q.entries[0].currentJobId = null;
    q.workEstimate = q.entries[1].workEstimate;
    w.__setWorkflowQueue(q);
  });
  await expect(eta).toContainText('File restante : ≈ 00:02:00');
  await page.clock.fastForward(120000);
  await expect(eta).toContainText('00:02:00');
  await expect(eta).toContainText('à la reprise');
  await panel.screenshot({ path: 'docs/screenshots/queue-eta-fr.png' });
  await page.evaluate(() => {
    const w = window as any,
      q = w.__getWorkflowQueue();
    q.workEstimate = null;
    q.entries = [];
    w.__setWorkflowQueue(q);
  });
  await expect(eta).toHaveCount(0);
});
