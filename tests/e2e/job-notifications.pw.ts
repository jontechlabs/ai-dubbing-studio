import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
async function emit(page: Page, status = 'running', id = 'notice') {
  await page.evaluate(
    ({ status, id }) =>
      (window as any).__timedJob({
        id,
        projectId: 'demo',
        kind: 'audioEffects',
        status,
        stage: 'fxRender',
        progress: 0.4,
        error: status === 'failed' ? 'AUDIO_EFFECTS_FAILED' : null,
        logs: [],
        timing: { elapsedMs: 12000, observedAtMs: Date.now() },
      }),
    { status, id },
  );
}
test('task notices are brief, deduplicated and link to persistent processing logs', async ({
  page,
}) => {
  await nativeMock(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  const notices = page.locator('.job-notice');
  await expect(notices).toHaveCount(0);
  await emit(page);
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText('Traitement démarré');
  await page.clock.fastForward(3000);
  await expect(notices).toHaveCount(0);
  await emit(page);
  await expect(notices).toHaveCount(0);
  await emit(page, 'succeeded');
  await expect(notices).toHaveCount(1);
  await expect(notices).toContainText('00:00:12');
  await notices.hover();
  await page.clock.fastForward(10000);
  await expect(notices).toHaveCount(1);
  await page.screenshot({ path: 'docs/screenshots/job-notifications-fr.png' });
  await page.mouse.move(1, 1);
  await page.clock.fastForward(6000);
  await expect(notices).toHaveCount(0);
  await emit(page, 'succeeded');
  await expect(notices).toHaveCount(0);
  await emit(page, 'failed', 'failed');
  await expect(notices).toContainText('Traitement en échec');
  await notices.getByRole('button', { name: 'Voir les traitements', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toBeVisible();
  await expect(notices).toHaveCount(0);
});
test('at most three notices appear and restored history does not notify again', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  for (let i = 0; i < 5; i++) await emit(page, 'running', String(i));
  await expect(page.locator('.job-notice')).toHaveCount(3);
  await page.locator('.notice-close').last().click();
  await expect(page.locator('.job-notice')).toHaveCount(2);
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('studio-jobs-restored', {
        detail: [
          { id: 'old', status: 'succeeded' },
          { id: 'resumed', status: 'running' },
        ],
      }),
    ),
  );
  await emit(page, 'succeeded', 'old');
  await emit(page, 'running', 'resumed');
  await expect(page.locator('.job-notice')).toHaveCount(2);
  await emit(page, 'cancelled', 'resumed');
  await expect(page.locator('.job-notice')).toHaveCount(3);
  await expect(page.locator('.job-notice').last()).toContainText('Traitement arrêté');
});
