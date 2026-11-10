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
  const readStored = () =>
    page.evaluate(
      () =>
        new Promise<{ name: string; atMs: number }>((resolve, reject) => {
          const request = indexedDB.open('dubbing-studio', 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction('projects', 'readonly'),
              rows = tx.objectStore('projects').getAll();
            rows.onsuccess = () =>
              resolve({ name: rows.result[0].project.name, atMs: rows.result[0].cover.atMs });
            tx.oncomplete = () => db.close();
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          };
        }),
    );
  const other = await page.context().newPage();
  try {
    await other.goto('/');
    const otherHome = other.getByRole('region', { name: 'Mes projets', exact: true });
    await expect(otherHome).toBeVisible();
    await otherHome
      .getByRole('button', { name: 'Renommer First light · Demo', exact: true })
      .click();
    let rename = other.getByRole('dialog', { name: 'Renommer le projet', exact: true });
    await rename.getByRole('textbox').fill('Nom le plus récent');
    // Keep the cover dialog on its old catalogue snapshot while another window renames.
    await h
      .getByRole('button', { name: 'Changer la vignette de First light · Demo', exact: true })
      .click();
    await cover.getByRole('spinbutton').fill('1');
    await rename.getByRole('button', { name: 'Renommer le projet', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await cover.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
    await expect.poll(readStored).toEqual({ name: 'Nom le plus récent', atMs: 1000 });
    // Exercise the reverse ordering: a stale rename window must retain a newer cover.
    await otherHome
      .getByRole('button', { name: 'Renommer Nom le plus récent', exact: true })
      .click();
    rename = other.getByRole('dialog', { name: 'Renommer le projet', exact: true });
    await rename.getByRole('textbox').fill('Nom final');
    await cover.getByRole('spinbutton').fill('2');
    await cover.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
    await expect.poll(readStored).toEqual({ name: 'Nom le plus récent', atMs: 2000 });
    await rename.getByRole('button', { name: 'Renommer le projet', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect.poll(readStored).toEqual({ name: 'Nom final', atMs: 2000 });
  } finally {
    await other.close();
  }
  await page.reload();
  await expect(h).toBeVisible();
  await expect(h.getByRole('button', { name: 'Ouvrir Nom final', exact: true })).toBeVisible();
});
