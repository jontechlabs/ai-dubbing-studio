import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('take computation duration persists across reload and copied parent timings stay unknown', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__seedDubbing();
    const p = w.__getMockProject();
    const g = p.generations.find((g: any) => g.kind === 'tts');
    g.generationTiming = {
      takeId: g.id,
      operation: 'tts',
      elapsedMs: 42000,
      inputUnits: 40,
      warmModel: false,
      contextKey: 'a'.repeat(64),
    };
    p.generations.push({ ...structuredClone(g), id: 'copied-parent' });
    const legacy = { ...structuredClone(g), id: 'legacy' };
    delete legacy.generationTiming;
    p.generations.push(legacy);
    w.__loadMockProject(p);
  });
  async function panel() {
    await page
      .locator('.dialogue-card')
      .first()
      .getByRole('button', { name: 'Régénérer', exact: true })
      .click();
    return page.getByRole('region', { name: 'Doublage', exact: true });
  }
  let p = await panel();
  await expect(p.locator('.take-duration').filter({ hasText: 'Calcul : 00:00:42' })).toHaveCount(1);
  await expect(p.locator('.take-duration').filter({ hasText: 'Durée non mesurée' })).toHaveCount(2);
  await page.reload();
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  p = await panel();
  await expect(p.locator('.take-duration').filter({ hasText: 'Calcul : 00:00:42' })).toHaveCount(1);
  await p
    .locator('.take-creation-meta')
    .filter({ hasText: 'Calcul : 00:00:42' })
    .screenshot({ path: 'docs/screenshots/take-computation-time-fr.png' });
});

test('live estimates use the current take offset, explain missing history, and hide after completion', async ({
  page,
}) => {
  await nativeMock(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const emit = async (values: Record<string, unknown> = {}) =>
    page.evaluate(
      (values) =>
        (window as any).__timedJob({
          id: 'estimate-job',
          projectId: 'demo',
          kind: 'ttsBatch',
          status: 'running',
          stage: 'ttsGenerate',
          progress: null,
          error: null,
          logs: [],
          timing: { elapsedMs: 30000, observedAtMs: Date.now() },
          estimate: {
            operation: 'tts',
            estimatedMs: 60000,
            baselineElapsedMs: 30000,
            sampleCount: 3,
          },
          ...values,
        }),
      values,
    );
  await emit();
  await page.locator('footer > button').last().click();
  const panel = page.getByRole('dialog', { name: 'Traitements', exact: true });
  await expect(panel.locator('.job-estimate')).toHaveText('Temps restant estimé : ≈ 00:01:00');
  await page.clock.fastForward(10000);
  await expect(panel.locator('.job-estimate')).toHaveText('Temps restant estimé : ≈ 00:00:50');
  await panel
    .locator('.job-card')
    .first()
    .screenshot({ path: 'docs/screenshots/generation-eta-fr.png' });
  await page.clock.fastForward(55000);
  await expect(panel.locator('.job-estimate')).toHaveText(
    'Estimation dépassée · traitement en cours',
  );
  await emit({
    estimate: { operation: 'tts', estimatedMs: null, baselineElapsedMs: 95000, sampleCount: 0 },
  });
  await expect(panel.locator('.job-estimate')).toContainText('historique comparable insuffisant');
  await emit({
    status: 'succeeded',
    stage: 'done',
    timing: { elapsedMs: 95000, observedAtMs: await page.evaluate(() => Date.now()) },
  });
  await expect(panel.locator('.job-estimate')).toHaveCount(0);
  await expect(panel.getByRole('timer')).toHaveText('Durée d’exécution : 00:01:35');
});
