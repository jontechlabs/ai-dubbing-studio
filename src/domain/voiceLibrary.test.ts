import { describe, expect, it } from 'vitest';
import { demoProject, validateProject } from './project';
import { addCharacter, deleteCharacter } from './characters';
import { defaultVoiceSettings, editVoiceSettings, validVoiceSettings } from './tts';
import {
  editLibrarySample,
  frenchVoicePhrases,
  libraryOf,
  libraryReference,
  validateVoiceLibraries,
  type VoiceLibrary,
  type VoiceLibrarySample,
} from './voiceLibrary';
import { rebaseProject } from './rebase';
import { mergeCharacters } from './characterReview';
import type { Generation } from './types';

function sample(id = 'sample'): VoiceLibrarySample {
  return {
    id,
    sourceId: 'source',
    reference: {
      id,
      label: 'Neutre',
      path: `characters/voice-library/${id}.wav`,
      durationMs: 6000,
      transcript: 'Nous avons encore quelques minutes.',
    },
    text: 'Nous avons encore quelques minutes.',
    mood: 'default',
    status: 'pending',
    options: { ...defaultVoiceSettings, variantId: 'voxcpm2-bf16', mood: 'default' },
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-27T00:00:00Z',
    deviceName: 'CPU',
  };
}
function library(): VoiceLibrary {
  return {
    sources: [
      {
        id: 'source',
        reference: {
          id: 'source',
          label: 'Deux extraits',
          path: 'characters/voice-library/source.wav',
          durationMs: 6000,
          transcript: '',
        },
        segments: [
          { referenceId: 'original-a', dialogueId: null, startMs: 0, endMs: 3000 },
          { referenceId: 'original-b', dialogueId: null, startMs: 500, endMs: 3500 },
        ],
        sha256: 'b'.repeat(64),
        createdAt: '2026-10-27T00:00:00Z',
      },
    ],
    samples: [sample()],
    defaultSampleId: null,
  };
}
function fixture() {
  const p = addCharacter(demoProject(), 'Personnage');
  p.formatVersion = 21;
  const c = p.characters[0],
    line = p.dialogues[0];
  line.characterId = c.id;
  p.characterProfiles = { [c.id]: { voiceLibrary: library() } };
  const take: Generation = {
    kind: 'tts',
    id: 'old',
    dialogueId: line.id,
    providerId: 'cosyvoice3',
    modelId: 'cosy3-official',
    path: 'generations/old.wav',
    createdAt: p.createdAt,
    sourcePath: p.media!.path,
    startMs: line.startMs,
    endMs: line.endMs,
    text: p.targetCues[0].text,
    language: 'fr',
    characterId: c.id,
    durationMs: 2000,
    sampleRate: 24000,
    options: { ...defaultVoiceSettings },
    referenceTranscript: 'Original',
    device: 'cpu',
    deviceName: 'CPU',
    peakVramMb: 0,
    inputHash: 'old-hash',
  };
  p.generations = [take];
  line.selectedGenerationIds.fr = 'old';
  return p;
}
describe('reviewed character voice library', () => {
  it('approval and default selection preserve every dialogue, timing, edit and historical take', () => {
    const p = fixture(),
      id = p.characters[0].id,
      before = structuredClone(p);
    expect(libraryReference(p, id, null)).toBeUndefined();
    const next = editLibrarySample(p, id, 'sample', { status: 'approved', useDefault: true });
    expect(libraryReference(next, id, null)?.id).toBe('sample');
    for (const key of [
      'dialogues',
      'generations',
      'sourceCues',
      'targetCues',
      'media',
      'tracks',
      'voiceEdits',
      'dubbingTiming',
    ] as const)
      expect(next[key]).toEqual(before[key]);
    expect(p).toEqual(before);
    expect(validateProject(JSON.parse(JSON.stringify(next)))).toEqual(next);
  });
  it('withdrawing approval and transcript edits revoke use without deleting any sample or WAV record', () => {
    let p = fixture();
    const id = p.characters[0].id;
    p = editLibrarySample(p, id, 'sample', { status: 'approved', useDefault: true });
    const old = JSON.stringify(p.generations),
      reference = structuredClone(libraryOf(p, id)!.samples[0].reference);
    const next = editLibrarySample(p, id, 'sample', { transcript: 'Texte corrigé.' });
    expect(libraryOf(next, id)!.defaultSampleId).toBeNull();
    expect(libraryReference(next, id, 'sample')).toBeUndefined();
    expect(libraryOf(next, id)!.samples[0].reference.path).toBe(reference.path);
    expect(JSON.stringify(next.generations)).toBe(old);
    expect(() => editLibrarySample(next, id, 'sample', { useDefault: true })).toThrow(
      'VOICE_LIBRARY_REFERENCE_REQUIRED',
    );
    const rejected = editLibrarySample(p, id, 'sample', { status: 'rejected' });
    expect(libraryOf(rejected, id)!.samples).toHaveLength(1);
    expect(libraryReference(rejected, id, 'sample')).toBeUndefined();
  });
  it('rejects duplicate IDs, unsafe assets, unknown sources, out-of-bounds lengths and invalid approved defaults', () => {
    for (const change of [
      (lib: VoiceLibrary) => {
        lib.samples[0].reference.path = 'characters/../outside.wav';
      },
      (lib: VoiceLibrary) => {
        lib.sources[0].reference.durationMs = 4999;
      },
      (lib: VoiceLibrary) => {
        lib.samples[0].reference.durationMs = 20001;
      },
      (lib: VoiceLibrary) => {
        lib.samples[0].sourceId = 'missing';
      },
      (lib: VoiceLibrary) => {
        lib.samples.push(structuredClone(lib.samples[0]));
      },
      (lib: VoiceLibrary) => {
        lib.defaultSampleId = 'sample';
      },
      (lib: VoiceLibrary) => {
        lib.samples[0].sha256 = 'wrong';
      },
      (lib: VoiceLibrary) => {
        lib.sources[0].segments[0].dialogueId = 'both';
      },
    ]) {
      const p = fixture();
      change(libraryOf(p, p.characters[0].id)!);
      expect(() => validateVoiceLibraries(p)).toThrow('INVALID_VOICE_LIBRARY');
    }
  });
  it('requires format 21 for library and dual guidance while preserving old formats', () => {
    const p = fixture(),
      line = p.dialogues[0],
      settings = {
        ...defaultVoiceSettings,
        variantId: 'voxcpm2-bf16',
        referenceMode: 'library' as const,
        intonationGuide: { mode: 'style' as const },
      };
    const next = editVoiceSettings(p, line.id, settings);
    expect(next.formatVersion).toBe(21);
    validateProject(next);
    expect(() => validateVoiceLibraries({ ...next, formatVersion: 20 })).toThrow(
      'INVALID_VOICE_LIBRARY',
    );
    expect(validateProject(demoProject()).formatVersion).toBe(1);
    expect(() => validateProject({ ...next, formatVersion: 23 })).toThrow(
      'UNSUPPORTED_PROJECT_VERSION',
    );
  });
  it('accepts distinct guides only with VoxCPM2 and refuses incompatible mood/accent continuation settings', () => {
    const base = {
      ...defaultVoiceSettings,
      variantId: 'voxcpm2-bf16',
      referenceMode: 'library' as const,
      intonationGuide: { mode: 'style' as const },
    };
    expect(validVoiceSettings(base)).toBe(true);
    expect(validVoiceSettings({ ...base, referenceMode: 'current' })).toBe(false);
    expect(validVoiceSettings({ ...base, variantId: 'chatterbox-multilingual-v3' })).toBe(false);
    expect(validVoiceSettings({ ...base, mode: 'zeroShot' })).toBe(false);
    expect(
      validVoiceSettings({ ...base, intonationGuide: { mode: 'hybrid' }, accent: 'fr-FR' }),
    ).toBe(false);
    expect(
      validVoiceSettings({ ...base, intonationGuide: { mode: 'hybrid' }, mood: 'angry' }),
    ).toBe(false);
    expect(validVoiceSettings({ ...base, intonationGuide: { mode: 'hybrid' } })).toBe(true);
  });
  it('rebase retains native samples added while an approval is waiting for autosave', () => {
    const base = fixture(),
      id = base.characters[0].id,
      local = editLibrarySample(base, id, 'sample', { status: 'approved', useDefault: true }),
      incoming = structuredClone(base);
    libraryOf(incoming, id)!.samples.push(sample('new-native-sample'));
    const next = rebaseProject(base, local, incoming);
    expect(libraryOf(next, id)!.samples).toHaveLength(2);
    expect(libraryReference(next, id, null)?.id).toBe('sample');
    expect(libraryOf(next, id)!.samples[1].status).toBe('pending');
    validateProject(next);
  });
  it('merging characters retains both banks and deleting a character never deletes dialogue takes', () => {
    let p = fixture();
    p = addCharacter(p, 'Autre');
    const [first, second] = p.characters;
    const other = library();
    other.sources[0].id = other.sources[0].reference.id = 'source-two';
    other.sources[0].reference.path = 'characters/voice-library/source-two.wav';
    other.samples[0] = sample('sample-two');
    other.samples[0].sourceId = 'source-two';
    p.characterProfiles![second.id] = { voiceLibrary: other };
    const merged = mergeCharacters(p, { ids: [first.id, second.id], keepId: first.id });
    expect(libraryOf(merged, first.id)!.samples).toHaveLength(2);
    validateProject(merged);
    expect(merged.generations).toEqual(p.generations);
    expect(deleteCharacter(merged, first.id).generations).toEqual(p.generations);
  });
  it('every bundled French phrase has a supported style and fits input limits', () => {
    for (const phrase of frenchVoicePhrases) {
      expect(phrase.text.length).toBeGreaterThan(20);
      expect(phrase.text.length).toBeLessThanOrEqual(500);
      expect(
        validVoiceSettings({
          ...defaultVoiceSettings,
          variantId: 'voxcpm2-bf16',
          mood: phrase.mood,
        }),
      ).toBe(true);
    }
  });
});
