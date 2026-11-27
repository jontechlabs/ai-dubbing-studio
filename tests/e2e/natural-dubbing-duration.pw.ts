import { test, expect } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('short subtitle preserves natural voice duration in timeline and playback requests', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    w.__seedDubbing();
    const p = w.__getMockProject();
    p.dialogues[0].endMs = p.dialogues[0].startMs + 100;
    w.__loadMockProject(p);
  });
  const block = page.getByRole('button', { name: 'Doublage 1', exact: true });
  await expect(block).toHaveAttribute('data-duration-ms', '2000');
  await page
    .locator('.player-mode')
    .getByRole('button', { name: 'Préparer le mix de doublage' })
    .click();
  await page.getByRole('button', { name: 'Lecture', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__calls.some(
          (c: any) =>
            c.command === 'dubbing_path' &&
            c.args.id === 'take-1' &&
            c.args.slotMs === 2000 &&
            c.args.exactDuration === false,
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('extending into a neighbour moves only this dubbing to another lane and persists after reopening', async ({
  page,
}) => {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  const duration = panel.getByRole('spinbutton', { name: 'Durée demandée du doublage (ms)' });
  await duration.fill('4500');
  await duration.press('Enter');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const block = page.getByRole('button', { name: 'Doublage 1', exact: true });
  await expect(block).toHaveAttribute('data-duration-ms', '4500');
  await expect(block).toHaveAttribute('data-start-ms', String(before.dialogues[0].startMs));
  const lane = await block.getAttribute('data-lane-id');
  expect(lane).not.toBe('main');
  const after = await page.evaluate(() => (window as any).__getMockProject());
  for (const key of ['generations', 'dialogues', 'sourceCues', 'targetCues', 'media'])
    expect(after[key]).toEqual(before[key]);
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.screenshot({ path: 'docs/screenshots/natural-dubbing-duration-fr.png' });
  await page.reload();
  await expect(block).toHaveAttribute('data-duration-ms', '4500');
  await expect(block).toHaveAttribute('data-lane-id', lane!);
});
