import { test, expect, type Page } from '@playwright/test';
import { nativeMock } from './nativeMock';
import { demoProject } from '../../src/domain/project';
import { addCharacter } from '../../src/domain/characters';
import { defaultVoiceSettings } from '../../src/domain/tts';
import type { VoiceLibrary } from '../../src/domain/voiceLibrary';

function fixture(withSample = true) {
  const p = addCharacter(addCharacter(demoProject(), 'Personnage 01'), 'Personnage 02');
  p.formatVersion = 21;
  for (const [i, c] of p.characters.entries()) {
    c.id = `c${i}`;
    c.references = [
      {
        id: `r${i}`,
        label: `Original ${i}`,
        path: `characters/r${i}.wav`,
        durationMs: 6000,
        transcript: '日本語の原文。',
      },
    ];
    c.defaultReferenceId = `r${i}`;
  }
  const lib: VoiceLibrary = {
    sources: [
      {
        id: 'source',
        reference: {
          id: 'source',
          label: 'Extraits japonais',
          path: 'characters/voice-library/source.wav',
          durationMs: 6000,
          transcript: '',
        },
        segments: [{ referenceId: 'r0', dialogueId: null, startMs: 0, endMs: 6000 }],
        sha256: 'a'.repeat(64),
        createdAt: p.createdAt,
      },
    ],
    samples: [],
    defaultSampleId: null,
  };
  if (withSample)
    lib.samples.push({
      id: 'sample',
      sourceId: 'source',
      reference: {
        id: 'sample',
        label: 'Voix française',
        path: 'characters/voice-library/sample.wav',
        durationMs: 6000,
        transcript: 'Nous avons encore quelques minutes.',
      },
      text: 'Nous avons encore quelques minutes.',
      mood: 'default',
      status: 'pending',
      options: { ...defaultVoiceSettings, variantId: 'voxcpm2-bf16', mood: 'default' },
      sha256: 'b'.repeat(64),
      createdAt: p.createdAt,
      deviceName: 'CPU (simulation)',
    });
  p.characterProfiles = { c0: { voiceLibrary: lib } };
  p.dialogues[0].characterId = 'c0';
  p.dialogues[0].voiceSettings = {
    ...defaultVoiceSettings,
    variantId: 'voxcpm2-bf16',
    referenceMode: 'character',
  };
  return p;
}
const saved = (page: Page) => page.evaluate(() => (window as any).__getMockProject());
async function ready(page: Page, withSample = true) {
  await nativeMock(page, false, fixture(withSample));
  await page.goto('/');
  await expect(page.locator('.dialogue-card').first()).toBeVisible();
}
async function bank(page: Page) {
  await page.getByRole('button', { name: 'Personnages', exact: true }).click();
  await page.locator('.voice-library>summary').click();
  return page.locator('.voice-library');
}
async function dub(page: Page) {
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Doubler', exact: true })
    .click();
  return page.getByRole('dialog', { name: 'Doublage' });
}

test('assemble two trimmed excerpts and generate new pending phrases without replacing dialogue takes', async ({
  page,
}) => {
  await ready(page, false);
  const b = await bank(page),
    before = await saved(page);
  for (let i = 0; i < 2; i++) {
    await b.getByRole('combobox', { name: 'Extrait à ajouter' }).selectOption('reference:r0');
    await b.getByRole('button', { name: 'Ajouter', exact: true }).click();
    await b.getByRole('spinbutton', { name: `Fin (s) ${i + 1}`, exact: true }).fill('3');
  }
  await b.getByRole('spinbutton', { name: 'Début (s) 2', exact: true }).fill('3');
  await b.getByRole('spinbutton', { name: 'Fin (s) 2', exact: true }).fill('6');
  await b.getByRole('button', { name: 'Assembler et conserver cette source' }).click();
  await expect
    .poll(async () => (await saved(page)).characterProfiles.c0.voiceLibrary.sources.length)
    .toBe(2);
  await b.getByRole('button', { name: 'Générer 1 phrase', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__pendingLibrary)).phrases).toHaveLength(1);
  await page.evaluate(() => (window as any).__completeLibrary());
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  const reopened = await bank(page);
  await expect(reopened.locator('.library-sample')).toHaveCount(1);
  expect((await saved(page)).characterProfiles.c0.voiceLibrary.samples[0].status).toBe('pending');
  expect((await saved(page)).generations).toEqual(before.generations);
  expect((await saved(page)).dialogues).toEqual(before.dialogues);
});
test('audition approval default withdrawal and transcript correction survive reopening without deleting samples', async ({
  page,
}) => {
  await ready(page);
  const b = await bank(page);
  await b.getByRole('button', { name: 'Écouter cette phrase', exact: true }).click();
  await expect(b.locator('audio')).toHaveAttribute('src', /sample.wav/);
  await b.getByRole('button', { name: 'Valider la phrase', exact: true }).click();
  await b.getByRole('button', { name: 'Utiliser par défaut', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.screenshot({ path: 'test-results/screenshots/voice-library-approved.png' });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  const panel = await dub(page);
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('library');
  await expect(panel.getByText(/Seules les phrases validées/)).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  const again = await bank(page);
  await again
    .getByRole('textbox', { name: 'Texte réellement prononcé · le modifier retire la validation' })
    .fill('La phrase réellement prononcée.');
  await expect(
    again.getByRole('button', { name: 'Utiliser par défaut', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  const lib = (await saved(page)).characterProfiles.c0.voiceLibrary;
  expect(lib.defaultSampleId).toBeNull();
  expect(lib.samples).toHaveLength(1);
  expect(lib.samples[0].status).toBe('pending');
});
test('French fidelity and independent Japanese guide expose compatible engine controls and retain previous takes', async ({
  page,
}) => {
  const p = fixture();
  p.voiceReferences = [
    {
      id: 'fr',
      label: 'Français uniquement',
      path: 'characters/fr.wav',
      durationMs: 6000,
      transcript: 'Cette cicatrice me lance.',
    },
  ];
  p.dialogues[0].voiceSettings = {
    ...defaultVoiceSettings,
    variantId: 'voxcpm2-bf16',
    referenceMode: 'file',
    referenceId: 'fr',
    accent: 'fr-FR',
    mood: 'anxious',
  };
  await nativeMock(page, false, p);
  await page.goto('/');
  const panel = await dub(page);
  await panel.getByRole('button', { name: 'Privilégier le français de cette référence' }).click();
  await expect(
    panel.getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true }),
  ).toBeDisabled();
  await expect(
    panel.getByRole('combobox', { name: 'Humeur / interprétation', exact: true }),
  ).toBeDisabled();
  await panel
    .getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' })
    .selectOption('style');
  await expect(
    panel.getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' })
    .selectOption('hybrid');
  await expect(
    panel.getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true }),
  ).toBeDisabled();
  await page.screenshot({ path: 'test-results/screenshots/dual-voice-guide.png' });
  await panel.getByRole('button', { name: 'Générer un nouvel essai', exact: true }).click();
  const o = (await page.evaluate(() => (window as any).__pendingTts)).options;
  expect(o.intonationGuide.mode).toBe('hybrid');
  expect(o.referenceId).toBe('fr');
  expect(o.accent).toBe('auto');
  expect(o.mood).toBe('default');
});
test('automatic voice candidates never assign until accepted and keep manual correction available', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('studio.characterSuggestions', 'on'));
  const p = fixture();
  p.dialogues[0].characterId = null;
  await nativeMock(page, false, p);
  await page.goto('/');
  const panel = await dub(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__pendingCharacterMatch?.lineId))
    .toBe(p.dialogues[0].id);
  expect((await saved(page)).dialogues[0].characterId).toBeNull();
  await page.evaluate(() => (window as any).__completeCharacterMatch());
  await expect(panel.locator('.speaker-candidate')).toHaveCount(2);
  expect((await saved(page)).dialogues[0].characterId).toBeNull();
  await panel
    .locator('.speaker-candidate')
    .first()
    .getByRole('button', { name: 'Accepter', exact: true })
    .click();
  await expect.poll(async () => (await saved(page)).dialogues[0].characterId).toBe('c0');
  await panel.locator('.character-suggestion>details>summary').click();
  await panel
    .getByRole('combobox', { name: 'Choisir le personnage manuellement' })
    .selectOption('c1');
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  expect((await saved(page)).dialogues[0].characterId).toBe('c1');
});

test('Vox Ultimate Hi-Fi is optional, persists and Standard clears a hybrid continuation without changing takes', async ({
  page,
}) => {
  const p = fixture();
  await nativeMock(page, false, p);
  await page.goto('/');
  const panel = await dub(page),
    clone = panel.getByRole('combobox', { name: 'Mode de clonage' });
  await expect(clone).toHaveValue('crossLingual');
  await expect(clone.locator('option:checked')).toHaveText('Standard · Ultimate / Hi-Fi désactivé');
  await clone.selectOption('zeroShot');
  await expect(
    panel.getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true }),
  ).toBeDisabled();
  await expect(panel.getByText(/Il peut reproduire son accent/)).toBeVisible();
  await panel
    .getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' })
    .selectOption('hybrid');
  await expect(clone).toHaveValue('hybrid');
  await expect(clone).toBeEnabled();
  await clone.selectOption('crossLingual');
  await expect(
    panel.getByRole('combobox', { name: 'Guide de jeu de la réplique d’origine' }),
  ).toHaveValue('off');
  await expect(
    panel.getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true }),
  ).toBeEnabled();
  await panel
    .getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true })
    .selectOption('fr-FR');
  // Selecting the approved bank must not silently re-enable Ultimate.
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('library');
  await expect(clone).toHaveValue('crossLingual');
  await clone.selectOption('zeroShot');
  await clone.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/screenshots/voxcpm-ultimate-toggle.png' });
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await expect(page.locator('.save-indicator')).toHaveText('Sauvegardé');
  await page.reload();
  const retained = await saved(page);
  expect(retained.dialogues[0].voiceSettings.mode).toBe('zeroShot');
  expect(retained.generations).toEqual(p.generations);
  expect(retained.characterProfiles).toEqual(p.characterProfiles);
});

test('Vox batch dispatches the explicitly chosen Standard or Ultimate mode without rewriting existing takes', async ({
  page,
}) => {
  const p = fixture();
  await nativeMock(page, false, p);
  await page.goto('/');
  await page.getByRole('button', { name: /Doublage par lot/ }).click();
  const panel = page.getByRole('dialog', { name: 'Doublage par lot', exact: true });
  await panel
    .getByRole('combobox', { name: 'Référence vocale', exact: true })
    .selectOption('current');
  const clone = panel.getByRole('combobox', { name: 'Mode de clonage' });
  await clone.selectOption('zeroShot');
  await expect(clone).toHaveValue('zeroShot');
  await clone.selectOption('crossLingual');
  await panel
    .getByRole('combobox', { name: 'Accent souhaité (consigne)', exact: true })
    .selectOption('fr-FR');
  await panel.getByRole('checkbox', { name: /Forcer un nouvel essai/ }).check();
  await panel.getByRole('button', { name: 'Doubler 4 répliques', exact: true }).click();
  const pending = await page.evaluate(() => (window as any).__pendingBatch);
  expect(pending.options.mode).toBe('crossLingual');
  expect(pending.options.accent).toBe('fr-FR');
  expect(pending.options.intonationGuide).toBeUndefined();
  expect((await saved(page)).generations).toEqual(p.generations);
});
test('too little speech asks for manual selection and ambiguous candidates remain review-only', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('studio.characterSuggestions', 'on'));
  await ready(page);
  const panel = await dub(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).__pendingCharacterMatch?.lineId))
    .toBeTruthy();
  await page.evaluate(() => (window as any).__completeCharacterMatch('tooShortOrNoSpeech'));
  await expect(panel.getByText(/Parole trop courte ou absente/)).toBeVisible();
  await expect(panel.locator('.speaker-candidate')).toHaveCount(0);
  await panel.locator('.character-suggestion>details>summary').click();
  await panel.getByRole('button', { name: 'Actualiser la proposition' }).click();
  await page.evaluate(() => (window as any).__completeCharacterMatch('uncertain'));
  await expect(panel.getByText(/Correspondance incertaine/)).toBeVisible();
  expect((await saved(page)).dialogues[0].characterId).toBe('c0');
});

test('Qwen recovery displays its effective conditioning without rewriting requested settings or earlier takes', async ({
  page,
}) => {
  const p = fixture(),
    line = p.dialogues[0];
  line.voiceSettings = {
    ...defaultVoiceSettings,
    variantId: 'qwen3-17b-gguf-q8',
    mode: 'zeroShot',
    referenceMode: 'current',
    device: 'vulkan:1',
  };
  p.generations = [
    {
      id: 'recovered',
      kind: 'tts',
      dialogueId: line.id,
      providerId: 'qwen3-tts',
      modelId: 'qwen3-17b-gguf-q8',
      path: 'generations/recovered.wav',
      createdAt: p.createdAt,
      sourcePath: p.media!.path,
      startMs: line.startMs,
      endMs: line.endMs,
      text: p.targetCues[0].text,
      language: 'fr',
      characterId: line.characterId,
      durationMs: 2155,
      sampleRate: 24000,
      options: line.voiceSettings,
      referenceTranscript: '日本語',
      device: 'vulkan:1',
      deviceName: 'RTX 5060 Ti (simulation)',
      peakVramMb: 0,
      inputHash: 'fixture',
      qwenRecovery: {
        attempt: 1,
        requestedMode: 'zeroShot',
        effectiveMode: 'crossLingual',
        requestedSeed: 0,
        effectiveSeed: 0,
        device: 'vulkan:1',
      },
    },
  ];
  line.selectedGenerationIds.fr = 'recovered';
  await nativeMock(page, false, p);
  await page.goto('/');
  await page
    .locator('.dialogue-card')
    .first()
    .getByRole('button', { name: 'Régénérer', exact: true })
    .click();
  const panel = page.getByRole('dialog', { name: 'Doublage' });
  await expect(panel.getByText(/Qwen3 : reprise sans transcription/)).toBeVisible();
  await page.getByRole('button', { name: 'Fermer', exact: true }).click();
  await page.reload();
  const savedProject = await saved(page);
  expect(savedProject.generations).toEqual(p.generations);
  expect(savedProject.dialogues[0].voiceSettings.mode).toBe('zeroShot');
});
