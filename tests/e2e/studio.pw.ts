import { test, expect } from '@playwright/test';

test('studio: selection, video, separate TTS text, autosave, reload and undo', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Une nouvelle voix/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/studio-empty.png' });
  await page.getByRole('button', { name: 'Explorer l’exemple' }).click();
  await expect(page.locator('.count-badge')).toHaveText('4');
  await page.getByRole('button', { name: /Réplique 1 ·/ }).click();
  const target = page.getByRole('textbox', { name: 'Sous-titre affiché' });
  await expect(target).toHaveValue('Chaque histoire commence par une voix.');
  await target.fill('Un sous-titre indépendant de la voix.');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.getByRole('button', { name: 'Prononciation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Texte pour la voix' }).fill('Zutte !');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();
  await expect(page.locator('.count-badge')).toHaveText('4');
  await page.getByRole('button', { name: /Réplique 1 ·/ }).click();
  await expect(target).toHaveValue('Un sous-titre indépendant de la voix.');
  await page.getByRole('button', { name: 'Prononciation', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Texte pour la voix' })).toHaveValue('Zutte !');
  await page.getByRole('button', { name: 'Texte', exact: true }).click();
  await target.fill('Une autre prise de texte.');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.getByRole('button', { name: 'Ctrl+Z', exact: true }).click();
  await expect(target).toHaveValue('Un sous-titre indépendant de la voix.');
  await page.getByRole('button', { name: /Réplique 3 ·/ }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)).toBeCloseTo(7.5, 1);
  await page.getByRole('button', { name: 'Lire la réplique' }).click();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.paused)).toBe(false);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: 'test-results/screenshots/studio-demo.png' });
  expect(errors).toEqual([]);
});

test('imports local media and SRT files, then reloads the persisted media blob', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Importer', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /Choisir une vidéo/ }).click();
  await (await chooser).setFiles('public/demo.mp4');
  await page.getByRole('textbox', { name: 'Nom du projet' }).fill('Integration import');
  await page.getByRole('button', { name: 'Créer le projet' }).click();
  await expect(page.locator('video')).toBeVisible();
  for (const [name, file] of [['SRT original', 'source'], ['SRT traduit', 'target']]) {
    const next = page.waitForEvent('filechooser'); await page.getByRole('button', { name, exact: true }).click();
    await (await next).setFiles(`tests/fixtures/${file}.srt`);
    await expect(page.locator('.count-badge')).toHaveText('2');
  }
  await expect(page.locator('.target-text').first()).toContainText('Chaque histoire commence par une voix.');
  await page.reload(); await expect(page.locator('video')).toBeVisible();
  await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(16, 1);
  await page.getByRole('button', { name: /Réplique 1 ·/ }).click();
  await expect(page.getByRole('textbox', { name: 'Sous-titre affiché' })).toHaveValue('Chaque histoire commence par une voix.');
});
