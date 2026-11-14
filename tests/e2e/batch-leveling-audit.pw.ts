import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { auditBasis, type DubbingAudit } from '../../src/domain/dubbingAudit';
import type { Project } from '../../src/domain/types';
const saved = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('mockMcpEnabled', 'true');
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(options?: AudioContextOptions) {
        super({ ...options, sinkId: { type: 'none' } } as AudioContextOptions);
      }
    };
  });
  await nativeMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    (window as any).__seedDubbing();
    (window as any).__completeSeparation();
  });
});
async function batch(page: Page) {
  const row = page.locator('.timeline-track.audio[data-track-id="music"]');
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right', position: { x: 20, y: 10 } });
  await page.getByRole('menuitem', { name: 'Égaliser toute la piste…', exact: true }).click();
  await page.getByRole('button', { name: 'Égaliser plusieurs pistes…', exact: true }).click();
  return page.getByRole('dialog', { name: 'Égalisation multi-pistes', exact: true });
}
async function prepareTwo(page: Page, modal: ReturnType<Page['getByRole']>) {
  await modal.getByRole('checkbox', { name: 'Original', exact: true }).check();
  await modal.getByRole('button', { name: 'Préparer les préécoutes', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__levelingId)).toBeTruthy();
  const first = await page.evaluate(() => (window as any).__levelingId);
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect.poll(() => page.evaluate(() => (window as any).__levelingId)).not.toBe(first);
  await page.evaluate(() => (window as any).__completeLeveling());
  await expect(
    modal.getByRole('checkbox', { name: 'Valider cette piste', exact: true }),
  ).toHaveCount(2);
  await expect(
    modal.getByRole('checkbox', { name: 'Valider cette piste', exact: true }).first(),
  ).toBeEnabled();
}
test('multi-track previews require individual approval and only approved tracks are applied', async ({
  page,
}) => {
  const modal = await batch(page),
    before = await saved(page);
  await prepareTwo(page, modal);
  await expect(modal.locator('audio')).toHaveCount(4);
  expect((await saved(page)).generations).toEqual(before.generations);
  await expect(modal.getByRole('button', { name: /Validez au moins une piste/ })).toBeDisabled();
  const a = modal.locator('audio').nth(0),
    b = modal.locator('audio').nth(2);
  await a.evaluate((a: HTMLAudioElement) => a.play());
  await b.evaluate((a: HTMLAudioElement) => a.play());
  await expect.poll(() => a.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await modal.getByRole('checkbox', { name: 'Valider cette piste', exact: true }).first().check();
  await modal.screenshot({ path: 'docs/screenshots/batch-leveling-fr.png' });
  await modal.getByRole('button', { name: 'Appliquer la piste validée', exact: true }).click();
  await expect(modal).not.toBeVisible();
  const after = await saved(page);
  expect(after.generations.length).toBe(before.generations.length + 1);
  expect(after.generations.at(-1).trackId).toBe('music');
  expect(after.tracks).toEqual(before.tracks);
});
test('stale multi-track results cannot apply and closing preserves the project', async ({
  page,
}) => {
  const modal = await batch(page),
    before = await saved(page);
  await prepareTwo(page, modal);
  await modal.getByRole('checkbox', { name: 'Valider cette piste', exact: true }).first().check();
  await page.evaluate(async () => {
    const w = window as any,
      s = await w.__mcp('studio_get_state', {});
    await w.__mcp('studio_project_patch', {
      context: s.context,
      patches: [{ op: 'replace', path: '/name', value: 'edited' }],
    });
  });
  await expect(modal.getByRole('alert')).toContainText('Le projet a changé');
  await expect(modal.getByRole('button', { name: /Appliquer la piste validée/ })).toBeDisabled();
  await modal.getByRole('button', { name: 'Annuler', exact: true }).click();
  expect((await saved(page)).generations).toEqual(before.generations);
});
async function audit(page: Page, voices = 'off') {
  await page.getByRole('button', { name: 'Analyser les doublages', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Analyser les doublages', exact: true });
  await modal
    .getByRole('combobox', { name: 'Recherche de plusieurs voix', exact: true })
    .selectOption(voices);
  await modal.getByRole('button', { name: 'Lancer l’analyse générale', exact: true }).click();
  const p: Project = await saved(page);
  const report: DubbingAudit = {
    id: 'test-audit',
    createdAt: new Date().toISOString(),
    basis: auditBasis(p),
    voicesStatus: 'disabled',
    sourceTrackId: 'speech',
    rows: p.dialogues.map((l, i) => ({
      lineId: l.id,
      takeId: l.selectedGenerationIds.fr ?? null,
      tags: i === 0 ? ['silent'] : i === 1 ? ['missing'] : i === 2 ? ['multipleVoices'] : [],
      metrics: null,
      sourceVoices: i === 2 ? 2 : null,
      dubbingVoices: null,
      error: null,
    })),
  };
  await page.evaluate((r) => (window as any).__completeAudit(r), report);
  await expect(
    modal.getByRole('region', { name: 'Résultats de l’analyse', exact: true }),
  ).toBeVisible();
  return modal;
}
test('saved analysis tags combine with translation filters and remain accessible after reload', async ({
  page,
}) => {
  const modal = await audit(page);
  await modal.screenshot({ path: 'docs/screenshots/dubbing-audit-fr.png' });
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.getByText('Filtres du doublage', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Doublage muet (1)', exact: true }).check();
  await expect(page.locator('[data-dialogue-row]')).toHaveCount(1);
  await page
    .getByRole('combobox', { name: 'Statut de traduction', exact: true })
    .selectOption('translated');
  await expect(page.locator('[data-dialogue-row]')).toHaveCount(1);
  const result = await page.evaluate(
    async () => await (window as any).__mcp('studio_get_dialogues', { qualityTags: ['silent'] }),
  );
  expect(result.total).toBe(1);
  expect(result.rows[0].qualityCurrent).toBe(true);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Lecture', exact: true })).toBeEnabled();
  await page.getByText('Filtres du doublage', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'Doublage muet (1)', exact: true }).check();
  await expect(page.locator('[data-dialogue-row]')).toHaveCount(1);
});
test('audio edits mark the report stale and its tags no longer filter as current', async ({
  page,
}) => {
  const modal = await audit(page);
  await modal.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.evaluate(async () => {
    const w = window as any,
      s = await w.__mcp('studio_get_state', {});
    await w.__mcp('studio_project_patch', {
      context: s.context,
      patches: [{ op: 'replace', path: '/dialogues/0/endMs', value: 3999 }],
    });
  });
  await page.getByText('Filtres du doublage', { exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Relancez l’analyse' })).toBeVisible();
  const result = await page.evaluate(
    async () => await (window as any).__mcp('studio_get_dialogues', { qualityTags: ['silent'] }),
  );
  expect(result.total).toBe(0);
});
test('missing speaker module is explicit; audio-only checks stay available', async ({ page }) => {
  await page.evaluate(() => ((window as any).__auditSpeakersInstalled = false));
  await page.getByRole('button', { name: 'Analyser les doublages', exact: true }).click();
  const modal = page.getByRole('dialog', { name: 'Analyser les doublages', exact: true });
  await expect(modal).toContainText('Module de locuteurs absent');
  await expect(
    modal.getByRole('button', { name: 'Lancer l’analyse générale', exact: true }),
  ).toBeEnabled();
  await modal
    .getByRole('combobox', { name: 'Recherche de plusieurs voix', exact: true })
    .selectOption('off');
  await expect(modal).not.toContainText('Module de locuteurs absent');
});
