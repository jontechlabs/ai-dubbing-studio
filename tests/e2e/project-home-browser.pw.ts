import { test, expect } from '@playwright/test';
test('browser Home persists project names and real video thumbnails without overwriting newer project edits', async ({
  page,
}) => {
  await page.goto('/');
  const h = page.getByRole('region', { name: 'Mes projets', exact: true });
  await expect(h).toBeVisible();
  await h.getByRole('button', { name: 'Explorer l’exemple', exact: true }).click();
  await expect(page.locator('.dialogue-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'Accueil — Projets', exact: true }).click();
  await expect(h.locator('.project-cover img')).toBeVisible();
  expect(await h.locator('.project-cover img').getAttribute('src')).toMatch(/^data:image\/jpeg/);
  await page.screenshot({ path: 'docs/screenshots/project-home-fr.png', fullPage: true });
  await h
    .getByRole('button', { name: 'Changer la vignette de First light · Demo', exact: true })
    .click();
  const cover = page.getByRole('dialog', { name: 'Changer la vignette', exact: true });
  await cover.getByRole('spinbutton').fill('0');
  await cover.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
  await expect(cover.locator('.project-cover-preview')).toBeVisible();
  await cover.getByRole('button', { name: 'Fermer', exact: true }).first().click();
  await page.evaluate(async () => {
    const s = await import('/src/services/browserStore.ts');
    const [r] = await s.browserProjects();
    const p = { ...r.project, name: 'Nom le plus récent', revision: r.project.revision + 1 };
    await Promise.all([
      s.browserMetadata(p.id, { cover: { ...r.cover!, atMs: 1 } }),
      s.browserStore('put', p.id, { project: p, media: r.media }),
    ]);
    const value = await s.browserStore('get', p.id);
    if (value?.project.name !== p.name || value?.cover?.atMs !== 1)
      throw Error('Project or thumbnail overwritten');
  });
  await page.reload();
  await expect(h).toBeVisible();
  await expect(
    h.getByRole('button', { name: 'Ouvrir Nom le plus récent', exact: true }),
  ).toBeVisible();
});
