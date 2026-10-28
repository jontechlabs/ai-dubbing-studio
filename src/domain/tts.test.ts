import { describe, expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import type { Generation, Project } from './types';
import {
  defaultVoiceSettings,
  deleteGeneration,
  editVoiceSettings,
  reviewGeneration,
  selectGeneration,
  selectedGeneration,
  spokenText,
  staleGeneration,
  validVoiceSettings,
} from './tts';
import { rebaseProject } from './rebase';

function take(p: Project, id = 'take1', durationMs = 2000): Generation {
  const line = p.dialogues[0];
  return {
    kind: 'tts',
    id,
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosyvoice3-05b-rl',
    path: `generations/${id}.wav`,
    createdAt: new Date().toISOString(),
    sourcePath: p.media?.path ?? null,
    startMs: line.startMs,
    endMs: line.endMs,
    text: spokenText(p, line),
    language: p.languages.target,
    characterId: line.characterId,
    durationMs,
    sampleRate: 24000,
    options: { ...defaultVoiceSettings },
    referenceTranscript: 'Hello',
    device: 'cuda:0',
    deviceName: 'NVIDIA RTX',
    peakVramMb: 4000,
    inputHash: 'test-hash',
  };
}
describe('dubbing takes', () => {
  it('links explicit translation and selected voice review without approving a stale take', async () => {
    const { approveTranslation, translationState } = await import('./translation');
    const p = demoProject(),
      line = p.dialogues[0],
      g = take(p);
    p.generations = [g];
    line.selectedGenerationIds.fr = g.id;
    line.status = 'generated';
    const approved = approveTranslation(p, line.id, true);
    expect(approved.dialogues[0].status).toBe('validated');
    const withdrawn = reviewGeneration(approved, line.id, false);
    expect(withdrawn.dialogues[0].status).toBe('review');
    expect(translationState(withdrawn, withdrawn.dialogues[0])).toBe('translated');
    const reviewed = reviewGeneration(withdrawn, line.id, true);
    expect(translationState(reviewed, reviewed.dialogues[0])).toBe('approved');
    const stale = structuredClone(p);
    stale.dialogues[0].ttsText = 'Texte modifié';
    expect(approveTranslation(stale, line.id, true).dialogues[0].status).toBe('review');
    expect(() => reviewGeneration(stale, line.id, true)).toThrow('TTS_STALE_GENERATION');
    expect(p.dialogues[0].status).toBe('generated');
  });
  it('persists a two-stage take and rejects corrupt provenance while retaining the raw take', () => {
    const p = demoProject(),
      raw = take(p, 'raw'),
      final = take(p, 'final');
    p.formatVersion = 23;
    final.dubbingPipeline = {
      stageIds: [raw.id, final.id],
      engine: 'chatterbox-vc',
      settings: {
        lineId: p.dialogues[0].id,
        tts: { ...defaultVoiceSettings },
        conversion: {
          generationId: 'pipeline',
          referenceId: '',
          characterId: null,
          device: 'cpu',
          referenceMode: 'current',
        },
        guideStrength: 0,
      },
    };
    p.generations = [raw, final];
    expect(validateProject(structuredClone(p)).generations).toEqual([raw, final]);
    for (const change of [
      (p: Project) => {
        p.formatVersion = 22;
      },
      (p: Project) => {
        (p.generations[1] as Generation).dubbingPipeline!.stageIds = ['raw', 'raw'];
      },
      (p: Project) => {
        (p.generations[1] as Generation).dubbingPipeline!.settings.guideStrength = 2;
      },
      (p: Project) => {
        (p.generations[1] as Generation).dubbingPipeline!.settings.lineId = 'other';
      },
    ]) {
      const bad = structuredClone(p);
      change(bad);
      expect(() => validateProject(bad)).toThrow('INVALID_DUBBING_PIPELINE');
    }
    const retained = deleteGeneration(p, 'raw');
    expect(validateProject(retained).generations).toHaveLength(1);
    expect(p.generations).toEqual([raw, final]);
  });
  it('persists accent instructions in format 9 and rejects unsupported Qwen accents', () => {
    const p = demoProject(),
      changed = editVoiceSettings(p, p.dialogues[0].id, {
        ...defaultVoiceSettings,
        accent: 'fr-FR',
      });
    expect(changed.formatVersion).toBe(9);
    expect(validateProject(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    expect(() => validateProject({ ...changed, formatVersion: 8 })).toThrow('INVALID_TTS_REQUEST');
    expect(
      validVoiceSettings({
        ...defaultVoiceSettings,
        variantId: 'qwen3-06b-gguf-q8',
        accent: 'fr-FR',
      }),
    ).toBe(false);
    expect(validVoiceSettings({ ...defaultVoiceSettings, accent: 'arbitrary' })).toBe(false);
  });
  it('allows a reusable file reference without a character and detects transcript changes', () => {
    const p = demoProject();
    p.formatVersion = 9;
    p.characters = [];
    p.dialogues[0].characterId = null;
    p.voiceReferences = [
      {
        id: 'file',
        path: 'characters/file.wav',
        label: 'Voix française',
        durationMs: 5000,
        transcript: 'Bonjour',
        sourceDialogueId: null,
      },
    ];
    const g = take(p);
    g.options = { ...defaultVoiceSettings, referenceMode: 'file', referenceId: 'file' };
    g.referenceId = 'file';
    g.referenceTranscript = 'Bonjour';
    p.generations = [g];
    expect(validateProject(p)).toEqual(p);
    expect(staleGeneration(p, p.dialogues[0], g)).toBe(false);
    p.voiceReferences[0].transcript = 'Correction';
    expect(staleGeneration(p, p.dialogues[0], g)).toBe(true);
    p.voiceReferences[0].path = '../outside.wav';
    expect(() => validateProject(p)).toThrow('INVALID_REFERENCE_AUDIO');
  });
  it('preserves a pending file transcript edit when another reference receives an ASR result', () => {
    const base = demoProject();
    base.formatVersion = 9;
    base.voiceReferences = [
      {
        id: 'one',
        path: 'characters/one.wav',
        label: 'One',
        durationMs: 3000,
        transcript: '',
        sourceDialogueId: null,
      },
    ];
    const local = structuredClone(base),
      incoming = structuredClone(base);
    local.voiceReferences![0].transcript = 'Correction';
    incoming.voiceReferences!.push({
      ...base.voiceReferences[0],
      id: 'two',
      path: 'characters/two.wav',
      transcript: 'ASR',
    });
    const merged = rebaseProject(base, local, incoming);
    expect(merged.voiceReferences?.map((r) => r.transcript)).toEqual(['Correction', 'ASR']);
  });
  it('roundtrips mood settings, upgrades the project and rejects moods unavailable on Qwen Base', () => {
    const p = demoProject(),
      changed = editVoiceSettings(p, p.dialogues[0].id, { ...defaultVoiceSettings, mood: 'angry' });
    expect(changed.formatVersion).toBe(7);
    expect(validateProject(JSON.parse(JSON.stringify(changed)))).toEqual(changed);
    expect(() => validateProject({ ...changed, formatVersion: 6 })).toThrow('INVALID_TTS_REQUEST');
    expect(
      validVoiceSettings({
        ...defaultVoiceSettings,
        variantId: 'qwen3-06b-gguf-q8',
        mood: 'angry',
      }),
    ).toBe(false);
    expect(
      validVoiceSettings({ ...defaultVoiceSettings, variantId: 'fish-s2-gguf-q8', mood: 'happy' }),
    ).toBe(true);
  });
  it('keeps legacy settings compatible and validates persisted phase 6 engine/device choices', () => {
    expect(validVoiceSettings(defaultVoiceSettings)).toBe(true);
    const p = demoProject();
    p.formatVersion = 5;
    p.modelPreferences = { ttsProviderId: 'qwen3-tts', voiceVariantId: 'qwen3-06b-gguf-q8' };
    p.dialogues[0].voiceSettings = {
      ...defaultVoiceSettings,
      variantId: 'qwen3-06b-gguf-q8',
      device: 'vulkan:1',
    };
    expect(validateProject(p)).toEqual(p);
    expect(validVoiceSettings({ ...defaultVoiceSettings, variantId: 'unknown' })).toBe(false);
    expect(validVoiceSettings({ ...defaultVoiceSettings, device: 'vulkan:-1' })).toBe(false);
  });
  it('uses pronunciation separately and strips subtitle tags', () => {
    const p = demoProject();
    p.targetCues[0].text = '<i>Sakamoto</i>';
    p.pronunciation = { Sakamoto: 'Sakamotto' };
    expect(spokenText(p, p.dialogues[0])).toBe('Sakamotto');
    p.dialogues[0].ttsText = 'Une autre prononciation';
    expect(spokenText(p, p.dialogues[0])).toBe('Une autre prononciation');
    expect(p.targetCues[0].text).toBe('<i>Sakamoto</i>');
  });
  it('selects, reviews and removes without overwriting other takes or Bandit metadata', () => {
    const p = demoProject();
    p.formatVersion = 5;
    p.generations = [{ id: 'bandit', kind: 'separation' }, take(p), take(p, 'take2', 4000)];
    const selected = selectGeneration(p, 'take1');
    expect(selectedGeneration(selected, selected.dialogues[0])?.id).toBe('take1');
    expect(reviewGeneration(selected, p.dialogues[0].id, true).dialogues[0].status).toBe(
      'validated',
    );
    const second = selectGeneration(selected, 'take2');
    expect(second.dialogues[0].status).toBe('review');
    const removed = deleteGeneration(second, 'take2');
    expect(removed.generations).toHaveLength(2);
    expect(removed.dialogues[0].status).toBe('ungenerated');
    expect(p.generations).toHaveLength(3);
    expect(validateProject(removed)).toEqual(removed);
  });
  it('refuses validation after text, timings, source or character change', () => {
    const p = demoProject();
    p.formatVersion = 5;
    p.generations = [take(p)];
    const selected = selectGeneration(p, 'take1');
    selected.dialogues[0].ttsText = 'Nouveau texte';
    expect(
      staleGeneration(
        selected,
        selected.dialogues[0],
        selectedGeneration(selected, selected.dialogues[0])!,
      ),
    ).toBe(true);
    expect(() => reviewGeneration(selected, p.dialogues[0].id, true)).toThrow(
      'TTS_STALE_GENERATION',
    );
  });
  it('persists CUDA and reference settings, rejects unsafe generation metadata and older format', () => {
    let p = demoProject();
    p = editVoiceSettings(p, p.dialogues[0].id, {
      ...defaultVoiceSettings,
      device: 'cuda:0',
      speed: 1.2,
      referenceMode: 'current',
    });
    p.generations = [take(p)];
    expect(validateProject(JSON.parse(JSON.stringify(p))).dialogues[0].voiceSettings?.device).toBe(
      'cuda:0',
    );
    p.generations[0].path = '../outside.wav';
    expect(() => validateProject(p)).toThrow('INVALID_GENERATION');
    p.generations = [take(p)];
    p.formatVersion = 4;
    expect(() => validateProject(p)).toThrow('INVALID_GENERATION');
  });
  it('merges a completed generation with unsaved text and preserves deliberate deletion', () => {
    const base = demoProject(),
      local = structuredClone(base),
      incoming = structuredClone(base);
    local.dialogues[0].ttsText = 'Dernière frappe';
    incoming.formatVersion = 5;
    incoming.generations = [take(base)];
    incoming.dialogues[0].selectedGenerationIds.fr = 'take1';
    incoming.dialogues[0].status = 'generated';
    const result = rebaseProject(base, local, incoming);
    expect(result.dialogues[0].ttsText).toBe('Dernière frappe');
    expect(selectedGeneration(result, result.dialogues[0])?.id).toBe('take1');
    expect(
      staleGeneration(
        result,
        result.dialogues[0],
        selectedGeneration(result, result.dialogues[0])!,
      ),
    ).toBe(true);
    const deleted = deleteGeneration(result, 'take1'),
      server = structuredClone(result);
    server.generations.push(take(result, 'take2'));
    const rebased = rebaseProject(result, deleted, server);
    expect(rebased.generations.map((g) => g.id)).toEqual(['take2']);
    expect(validateProject(rebased)).toEqual(rebased);
    const before = selectGeneration(incoming, 'take1'),
      reviewed = reviewGeneration(before, before.dialogues[0].id, true),
      completed = structuredClone(before);
    completed.generations.push(take(completed, 'take2'));
    completed.dialogues[0].selectedGenerationIds.fr = 'take2';
    completed.dialogues[0].status = 'generated';
    const merge = rebaseProject(before, reviewed, completed);
    expect(merge.dialogues[0].selectedGenerationIds.fr).toBe('take2');
    expect(merge.dialogues[0].status).toBe('generated');
  });
});
