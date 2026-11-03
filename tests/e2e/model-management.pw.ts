import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';

async function models(page: Page) {
  await nativeMock(page);
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__managedModels = [
      {
        id: 'separation:mossformer2-16k',
        name: 'MossFormer2',
        bytes: 3145728,
        files: 2,
        present: true,
        error: null,
      },
      {
        id: 'voice:partial',
        name: 'Téléchargement incomplet',
        bytes: 1048576,
        files: 1,
        present: true,
        error: null,
      },
      {
        id: 'voice:linked',
        name: 'Dossier lié',
        bytes: 0,
        files: 0,
        present: true,
        error: 'MODEL_STORAGE_LINK',
      },
    ];
  });
  await page.getByRole('button', { name: 'Modèles', exact: true }).click();
  const manager = page.locator('.model-manager');
  await manager.locator('summary').click();
  await expect(manager.getByText('Fichiers présents : 4 Mio', { exact: true })).toBeVisible();
  return manager;
}

test('model removal requires confirmation, releases selected weights and preserves project takes and partial entries', async ({
  page,
}) => {
  const manager = await models(page);
  const before = await page.evaluate(() => (window as any).__getMockProject());
  await manager.getByRole('button', { name: 'Supprimer MossFormer2', exact: true }).click();
  const confirm = page.getByRole('dialog', {
    name: 'Supprimer les fichiers du modèle',
    exact: true,
  });
  await expect(confirm).toContainText('références et essais sont conservés');
  await confirm.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect(
    await page.evaluate(() =>
      (window as any).__calls.filter((c: any) => c.command === 'remove_installed_model'),
    ),
  ).toEqual([]);
  await manager.getByRole('button', { name: 'Supprimer MossFormer2', exact: true }).click();
  await confirm.getByRole('button', { name: 'Supprimer le modèle', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(
    manager.getByRole('button', { name: 'Supprimer MossFormer2', exact: true }),
  ).toHaveCount(0);
  await expect(
    manager.getByRole('button', { name: 'Supprimer Téléchargement incomplet', exact: true }),
  ).toBeEnabled();
  await expect(manager.getByText('Fichiers présents : 1 Mio', { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__calls
        .filter((c: any) => c.command === 'remove_installed_model')
        .map((c: any) => c.args),
    ),
  ).toEqual([{ id: 'separation:mossformer2-16k', confirmed: true }]);
  expect(await page.evaluate(() => (window as any).__getMockProject())).toEqual(before);
});

test('model removal rejects unsafe linked entries and exposes retryable errors without removing weights', async ({
  page,
}) => {
  const manager = await models(page);
  await expect(
    manager.getByRole('button', { name: 'Supprimer Dossier lié', exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as any).__removeModelError = 'BUSY';
  });
  await manager
    .getByRole('button', { name: 'Supprimer Téléchargement incomplet', exact: true })
    .click();
  const confirm = page.getByRole('dialog', {
    name: 'Supprimer les fichiers du modèle',
    exact: true,
  });
  await confirm.getByRole('button', { name: 'Supprimer le modèle', exact: true }).click();
  await expect(confirm.getByRole('alert')).toBeVisible();
  await expect(
    confirm.getByRole('button', { name: 'Supprimer le modèle', exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__managedModels.length)).toBe(3);
  await page.evaluate(() => {
    (window as any).__removeModelError = null;
  });
  await confirm.getByRole('button', { name: 'Supprimer le modèle', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(manager.getByText('Téléchargement incomplet', { exact: true })).toHaveCount(0);
});

test('global MossFormer installation finishes in the dubbing inspector even after global job history is pruned', async ({
  page,
}) => {
  await nativeMock(page);
  await page.addInitScript(() => {
    (window as any).__speakerInstalled = false;
    (window as any).__slowSpeakerInstall = true;
  });
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
  await page.evaluate(() => (window as any).__seedDubbing());
  await page.locator('.dialogue-card').first().locator('.line-select').click();
  await page.getByRole('button', { name: 'Ajouter un doublage', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Doublage', exact: true });
  const section = panel.locator('.speaker-separation');
  await section.locator('summary').click();
  await section.getByRole('button', { name: 'Installer le séparateur', exact: true }).click();
  const progress = panel.locator('.current-job-progress');
  await expect(progress).not.toContainText('Préparation du traitement');
  await expect(progress.locator('progress')).toHaveAttribute('value', '0.5');
  await page.evaluate(() => (window as any).__completeSpeakerSeparation());
  await expect(progress).toContainText('Terminé');
  await expect(
    section.getByRole('button', { name: 'Isoler les voix de cette réplique', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    for (let i = 0; i < 105; i++)
      (window as any).__timedJob({
        id: 'other-' + i,
        projectId: '',
        kind: 'ttsInstall',
        status: 'succeeded',
        stage: 'done',
        progress: 1,
        logs: [],
        error: null,
      });
  });
  await expect(progress).toContainText('Terminé');
  await expect(progress).not.toContainText('Préparation du traitement');
  await expect(page.getByRole('dialog', { name: 'Traitements', exact: true })).toHaveCount(0);
});
