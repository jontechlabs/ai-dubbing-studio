import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

test('MCP library mutations update visible Home cards without reopening or manual refresh', async ({
  page,
}) => {
  const h = await home(page);
  await expect.poll(() => page.evaluate(() => (window as any).__mcpReady)).toBe(true);
  await page.evaluate(() =>
    (window as any).__TAURI_INTERNALS__.invoke('mcp_set_enabled', { enabled: true }),
  );
  const call = (tool: string, args: unknown = {}) =>
    page.evaluate(({ tool, args }) => (window as any).__mcp(tool, args), { tool, args });
  const list = await call('studio_list_projects');
  const row = list.entries[0];
  const renamed = await call('studio_rename_registered_project', {
    key: row.key,
    expectedRevision: row.revision,
    name: 'Projet piloté par IA',
  });
  expect(renamed.error).toBeUndefined();
  await expect(
    h.getByRole('button', { name: 'Ouvrir Projet piloté par IA', exact: true }),
  ).toBeVisible();
  await call('studio_trash_registered_project', {
    key: row.key,
    expectedRevision: renamed.revision,
    confirmed: true,
  });
  await expect(h.locator('.project-card')).toHaveCount(0);
  await page.getByRole('button', { name: /^Corbeille/ }).click();
  await expect(h.locator('.project-card')).toHaveCount(1);
  await call('studio_restore_registered_project', { key: row.key, parentPath: null });
  await expect(h.locator('.project-card')).toHaveCount(0);
  await page.getByRole('button', { name: 'Projets', exact: true }).click();
  await expect(
    h.getByRole('button', { name: 'Ouvrir Projet piloté par IA', exact: true }),
  ).toBeVisible();
  await call('studio_open_registered_project', { key: row.key });
  await expect(
    page.getByRole('button', { name: 'Renommer Projet piloté par IA', exact: true }),
  ).toBeVisible();
  await call('studio_close_project');
  await expect(h).toBeVisible();
  expect((await call('studio_get_state')).screen).toBe('home');
});
async function home(page: Page) {
  await nativeMock(page);
  await page.addInitScript(() => {
    (window as any).__startAtHome = true;
  });
  await page.route('**/project-cover-*.png', (r) =>
    r.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270"><rect width="480" height="270" fill="#574b75"/><text x="40" y="145" fill="#ddd" font-size="30">Projet vidéo · Démonstration</text></svg>',
    }),
  );
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Mes projets', exact: true })).toBeVisible();
  await expect(page.locator('.project-card')).toHaveCount(1);
  return page.getByRole('region', { name: 'Mes projets', exact: true });
}
async function back(page: Page) {
  await page.getByRole('button', { name: 'Accueil — Projets', exact: true }).click();
  await expect(page.locator('.project-home')).toBeVisible();
}
test('startup opens the project manager and returning from the editor saves the project', async ({
  page,
}) => {
  const h = await home(page);
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expect(h.locator('.project-cover img')).toBeVisible();
  await h.getByRole('button', { name: 'Ouvrir First light · Demo', exact: true }).click();
  await expect(page.locator('.dialogue-card')).toHaveCount(4);
  await page.getByRole('button', { name: 'Renommer First light · Demo', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: 'Renommer le projet', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.line-select').first().click();
  await page
    .getByRole('textbox', { name: 'Sous-titre affiché', exact: true })
    .fill('Modification conservée avant de revenir.');
  await back(page);
  await h.getByRole('button', { name: 'Ouvrir First light · Demo', exact: true }).click();
  await page.locator('.line-select').first().click();
  await expect(page.getByRole('textbox', { name: 'Sous-titre affiché', exact: true })).toHaveValue(
    'Modification conservée avant de revenir.',
  );
  await page.reload();
  await expect(h).toBeVisible();
  await expect(page.locator('.workspace')).toHaveCount(0);
});
test('creates a blank project, renames it in the editor and from Home without losing project data', async ({
  page,
}) => {
  const h = await home(page);
  await h.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'Nouveau projet', exact: true });
  await create.getByRole('textbox', { name: 'Nom du projet', exact: true }).fill('Projet 日本語');
  await create.getByRole('button', { name: 'Créer le projet', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Renommer Projet 日本語', exact: true }),
  ).toBeVisible();
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await page.getByRole('button', { name: 'Renommer Projet 日本語', exact: true }).click();
  let rename = page.getByRole('dialog', { name: 'Renommer le projet', exact: true });
  await rename.getByRole('textbox').fill('Version française');
  await rename.getByRole('button', { name: 'Renommer le projet', exact: true }).click();
  await expect(rename).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Renommer Version française', exact: true }),
  ).toBeVisible();
  await back(page);
  await h.getByRole('button', { name: 'Renommer Version française', exact: true }).click();
  rename = page.getByRole('dialog', { name: 'Renommer le projet', exact: true });
  await rename.getByRole('textbox').fill('Version finale');
  await rename.getByRole('button', { name: 'Renommer le projet', exact: true }).click();
  await expect(h.getByRole('button', { name: 'Ouvrir Version finale', exact: true })).toBeVisible();
  await h.getByRole('button', { name: 'Ouvrir Version finale', exact: true }).click();
  const after = await page.evaluate(() => (window as any).__getMockProject());
  expect(after.id).toBe(before.id);
  expect(after.generations).toEqual(before.generations);
  expect(after.tracks).toEqual(before.tracks);
});
test('trash requires confirmation and restore recovers all existing takes', async ({ page }) => {
  const h = await home(page);
  const before = await page.evaluate(() => (window as any).__getLibrary()[0].project);
  await h.getByRole('button', { name: 'Supprimer First light · Demo', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Supprimer le projet', exact: true });
  await expect(confirm).toContainText('Vous pourrez les restaurer');
  await confirm.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.some((c: any) => c.command === 'trash_registered_project'),
    ),
  ).toBe(false);
  await h.getByRole('button', { name: 'Supprimer First light · Demo', exact: true }).click();
  await confirm.getByRole('button', { name: 'Déplacer dans la corbeille', exact: true }).click();
  await expect(h.locator('.project-card')).toHaveCount(0);
  await h.getByRole('button', { name: 'Corbeille', exact: false }).click();
  await expect(h.locator('.project-card')).toHaveCount(1);
  await h.getByRole('button', { name: 'Restaurer', exact: true }).click();
  await expect(h.locator('.project-card')).toHaveCount(0);
  await h.getByRole('button', { name: 'Projets', exact: true }).click();
  await expect(
    h.getByRole('button', { name: 'Ouvrir First light · Demo', exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => (window as any).__getLibrary()[0].project)).toEqual(before);
});
test('automatic and custom thumbnail times avoid edges and reject positions outside the video', async ({
  page,
}) => {
  const h = await home(page);
  await expect(h.locator('.project-cover img')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__getLibrary()[0].coverAtMs)).toBe(6400);
  await h
    .getByRole('button', { name: 'Changer la vignette de First light · Demo', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Changer la vignette', exact: true });
  const at = dialog.getByRole('spinbutton', {
    name: 'Position dans la vidéo (secondes)',
    exact: true,
  });
  await at.fill('8');
  await dialog.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
  await expect(dialog.locator('.project-cover-preview')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__getLibrary()[0].coverAtMs)).toBe(8000);
  await at.fill('16');
  await dialog.getByRole('button', { name: 'Capturer la vignette', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Choisissez un instant');
  expect(await page.evaluate(() => (window as any).__getLibrary()[0].coverAtMs)).toBe(8000);
});
test('failed creation keeps the form and unavailable projects can be removed without deleting files', async ({
  page,
}) => {
  const h = await home(page);
  await h.getByRole('button', { name: 'Nouveau projet', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau projet', exact: true });
  await dialog.getByRole('textbox', { name: 'Nom du projet', exact: true }).fill('Déjà existant');
  await page.evaluate(() => ((window as any).__libraryCreateError = 'PROJECT_EXISTS'));
  await dialog.getByRole('button', { name: 'Créer le projet', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Nom du projet', exact: true })).toHaveValue(
    'Déjà existant',
  );
  await dialog.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.evaluate(() => {
    (window as any).__getLibrary();
    const v = JSON.parse(localStorage.getItem('nativeMockLibrary')!);
    v[0].available = false;
    localStorage.setItem('nativeMockLibrary', JSON.stringify(v));
  });
  await page.reload();
  await h
    .getByRole('button', { name: 'Retirer First light · Demo de la liste', exact: true })
    .click();
  const forget = page.getByRole('dialog', { name: 'Retirer de la liste', exact: true });
  await expect(forget).toContainText('Aucun fichier ne sera supprimé');
  await forget.getByRole('button', { name: 'Retirer de la liste', exact: true }).click();
  await expect(h.locator('.project-card')).toHaveCount(0);
});
test('project cards, search and actions fit narrow desktop windows and busy workers prevent switching', async ({
  page,
}) => {
  const h = await home(page);
  for (const width of [1024, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBe(0);
    await expect(h.getByRole('button', { name: 'Nouveau projet', exact: true })).toBeInViewport();
  }
  await h.getByRole('textbox', { name: 'Rechercher un projet…', exact: true }).fill('inexistant');
  await expect(h.locator('.project-card')).toHaveCount(0);
  await h.getByRole('textbox', { name: 'Rechercher un projet…', exact: true }).fill('First');
  await expect(h.locator('.project-card')).toHaveCount(1);
  await h.getByRole('button', { name: 'Ouvrir First light · Demo', exact: true }).click();
  await page.evaluate(() =>
    (window as any).__timedJob({
      id: 'work',
      projectId: (window as any).__getMockProject().id,
      kind: 'tts',
      status: 'running',
      stage: 'ttsGenerate',
      progress: 0.5,
      logs: [],
      error: null,
    }),
  );
  await expect(page.getByRole('button', { name: 'Accueil — Projets', exact: true })).toBeDisabled();
});
