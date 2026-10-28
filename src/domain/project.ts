import type { Project } from './types';
import { alignCues } from './subtitles';
import { validVoiceVariant } from './modelVariants';
import { validVoiceSettings } from './tts';
import { voiceSettingsFormat } from './voiceEngines';
import { validateAudioPatches } from './audioPatch';
import { validateLipVideos } from './inpaint';
import { validateVoiceEdit } from './voiceEdit';
import { validateProsody } from './prosody';
import { validateTakeOrigins, validateDubbingPipelines } from './voiceCapture';
import { validateEffectsProject } from './audioEffects';
import { validateCharacterProfiles } from './characterReview';
import { validateVoiceLibraries } from './voiceLibrary';
import packageInfo from '../../package.json' with { type: 'json' };
export const APP_VERSION = packageInfo.version;

export function blankProject(name = 'Untitled', source = 'ja', target = 'fr'): Project {
  const now = new Date().toISOString();
  return {
    formatVersion: 1,
    appVersion: APP_VERSION,
    id: crypto.randomUUID(),
    name,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    languages: { source, target },
    media: null,
    sourceCues: [],
    targetCues: [],
    dialogues: [],
    tracks: [],
    characters: [],
    generations: [],
    pronunciation: {},
  };
}
export function demoProject(): Project {
  const project = blankProject('First light · Demo', 'en', 'fr');
  project.media = {
    id: crypto.randomUUID(),
    path: 'demo.mp4',
    previewPath: null,
    audioStreamIndex: 1,
    originalName: 'First light.mp4',
    durationMs: 16000,
    streams: [
      {
        index: 0,
        kind: 'video',
        codec: 'h264',
        language: 'und',
        title: '',
        channels: null,
        width: 1280,
        height: 720,
        bitmap: false,
      },
      {
        index: 1,
        kind: 'audio',
        codec: 'aac',
        language: 'en',
        title: '',
        channels: 2,
        width: null,
        height: null,
        bitmap: false,
      },
    ],
  };
  const samples = [
    [750, 3250, 'Every story begins with a voice.', 'Chaque histoire commence par une voix.'],
    [4500, 7000, 'Listen. Find the right rhythm.', 'Écoutez. Trouvez le bon rythme.'],
    [8250, 11250, 'Make room for another language.', 'Faites place à une autre langue.'],
    [12500, 15000, 'Now, make it yours.', 'À vous de lui donner vie.'],
  ] as const;
  project.sourceCues = samples.map(([startMs, endMs, text]) => ({
    id: crypto.randomUUID(),
    startMs,
    endMs,
    text,
  }));
  project.targetCues = samples.map(([startMs, endMs, , text]) => ({
    id: crypto.randomUUID(),
    startMs,
    endMs,
    text,
  }));
  project.dialogues = alignCues(project.sourceCues, project.targetCues);
  project.tracks = [
    { id: 'video', kind: 'video', language: '', mute: false, solo: false, gain: 1 },
    { id: 'original', kind: 'original', language: 'en', mute: false, solo: false, gain: 1 },
    { id: 'source', kind: 'subtitle', language: 'en', mute: false, solo: false, gain: 1 },
    { id: 'target', kind: 'subtitle', language: 'fr', mute: false, solo: false, gain: 1 },
  ];
  return project;
}
export function validateProject(value: unknown): Project {
  if (!value || typeof value !== 'object') throw new Error('INVALID_PROJECT');
  const project = value as Project;
  const preferences = project.modelPreferences;
  if (
    preferences &&
    ['voxcpm2', 'chatterbox'].includes(preferences.ttsProviderId ?? '') &&
    project.formatVersion < 16
  )
    throw Error('UNSUPPORTED_PROJECT_VERSION');
  if (preferences && !validVoiceVariant(preferences.ttsProviderId, preferences.voiceVariantId))
    throw new Error('INVALID_PROJECT');
  if (
    !Number.isInteger(project.formatVersion) ||
    project.formatVersion < 1 ||
    project.formatVersion > 23
  )
    throw new Error('UNSUPPORTED_PROJECT_VERSION');
  if (project.voiceEdits !== undefined) {
    if (
      project.formatVersion < 11 ||
      !project.voiceEdits ||
      typeof project.voiceEdits !== 'object' ||
      Array.isArray(project.voiceEdits)
    )
      throw Error('INVALID_VOICE_EDIT');
    for (const [id, edit] of Object.entries(project.voiceEdits)) {
      const g = project.generations.find((g) => g.kind === 'tts' && g.id === id);
      if (!g) throw Error('INVALID_VOICE_EDIT');
      validateVoiceEdit(edit, Number(g.durationMs));
      if (edit.outputGain !== undefined && project.formatVersion < 22)
        throw Error('INVALID_OUTPUT_GAIN');
      if (project.formatVersion < 18 && edit.pieces.some((p) => p.effects?.length))
        throw Error('INVALID_AUDIO_EFFECTS');
      if (project.formatVersion < 12 && edit.pieces.some((p) => p.envelope !== undefined))
        throw Error('INVALID_VOICE_EDIT');
    }
  }
  if (project.translationApprovals !== undefined) {
    if (
      !project.translationApprovals ||
      typeof project.translationApprovals !== 'object' ||
      Array.isArray(project.translationApprovals)
    )
      throw Error('INVALID_PROJECT');
    for (const [id, approval] of Object.entries(project.translationApprovals)) {
      if (
        project.formatVersion < 10 ||
        !project.dialogues.some((line) => line.id === id) ||
        !approval ||
        ['sourceLanguage', 'targetLanguage', 'sourceText', 'targetText'].some(
          (key) => typeof approval[key as keyof typeof approval] !== 'string',
        ) ||
        !approval.targetText.trim()
      )
        throw Error('INVALID_PROJECT');
    }
  }
  if (project.dubbingTiming) {
    const timing = project.dubbingTiming;
    if (
      timing.durationsMs &&
      (typeof timing.durationsMs !== 'object' ||
        Array.isArray(timing.durationsMs) ||
        Object.values(timing.durationsMs).some(
          (v) =>
            !v ||
            typeof v !== 'object' ||
            Array.isArray(v) ||
            Object.values(v).some((n) => !Number.isSafeInteger(n) || n < 1 || n > 120000),
        ))
    )
      throw Error('INVALID_PROJECT');
    if (
      project.formatVersion < 7 ||
      typeof timing.sourcePath !== 'string' ||
      !timing.sourcePath ||
      timing.sourcePath.includes(':') ||
      timing.sourcePath.includes('\\') ||
      timing.sourcePath.split('/').some((v) => !v || v === '.' || v === '..') ||
      !timing.offsetsMs ||
      typeof timing.offsetsMs !== 'object' ||
      Array.isArray(timing.offsetsMs) ||
      Object.values(timing.offsetsMs).some(
        (v) =>
          !v ||
          typeof v !== 'object' ||
          Array.isArray(v) ||
          Object.values(v).some((n) => !Number.isSafeInteger(n) || Math.abs(n) > 86_400_000),
      )
    )
      throw new Error('INVALID_PROJECT');
  }
  if (
    project.subtitleDisplay &&
    !['off', 'source', 'target', 'both'].includes(project.subtitleDisplay)
  )
    throw new Error('INVALID_PROJECT');
  if (!project.id || typeof project.name !== 'string' || !Number.isInteger(project.revision))
    throw new Error('INVALID_PROJECT');
  if (
    !project.languages ||
    typeof project.languages.source !== 'string' ||
    typeof project.languages.target !== 'string'
  )
    throw new Error('INVALID_PROJECT');
  for (const key of [
    'sourceCues',
    'targetCues',
    'dialogues',
    'tracks',
    'characters',
    'generations',
  ] as const) {
    if (!Array.isArray(project[key])) throw new Error('INVALID_PROJECT');
  }
  validateEffectsProject(project);
  for (const cue of [...project.sourceCues, ...project.targetCues]) {
    if (
      !cue.id ||
      typeof cue.text !== 'string' ||
      !Number.isSafeInteger(cue.startMs) ||
      !Number.isSafeInteger(cue.endMs) ||
      cue.startMs < 0 ||
      cue.endMs <= cue.startMs
    )
      throw new Error('INVALID_CUE_RANGE');
  }
  for (const track of project.tracks) {
    if (
      track.kind === 'dubbing' &&
      (project.formatVersion < 6 || track.id !== 'dubbing' || track.path !== undefined)
    )
      throw new Error('INVALID_PROJECT');
    if (
      !Number.isFinite(track.gain) ||
      track.gain < 0 ||
      track.gain > 4 ||
      (track.gain > 2 && project.formatVersion < 18) ||
      (track.name !== undefined &&
        (typeof track.name !== 'string' ||
          !track.name ||
          track.name.length > 160 ||
          track.name.includes('\0')))
    )
      throw new Error('INVALID_PROJECT');
    if (track.regions !== undefined || track.regionsEnabled !== undefined) {
      if (
        project.formatVersion < 4 ||
        !['original', 'audio', 'dubbing'].includes(track.kind) ||
        (track.regionsEnabled !== undefined && typeof track.regionsEnabled !== 'boolean') ||
        (track.regions !== undefined && !Array.isArray(track.regions)) ||
        (track.regions?.length ?? 0) > 10000
      )
        throw new Error('INVALID_AUDIO_REGION');
      const limit = track.durationMs ?? project.media?.durationMs ?? 0;
      let previous = 0;
      const ids = new Set<string>();
      for (const item of track.regions ?? []) {
        if (
          !item.id ||
          ids.has(item.id) ||
          !Number.isSafeInteger(item.startMs) ||
          !Number.isSafeInteger(item.endMs) ||
          item.startMs < previous ||
          item.endMs <= item.startMs ||
          item.endMs > limit ||
          !Number.isFinite(item.gain) ||
          item.gain < 0 ||
          item.gain > 2 ||
          typeof item.mute !== 'boolean'
        )
          throw new Error('INVALID_AUDIO_REGION');
        previous = item.endMs;
        ids.add(item.id);
      }
    }
  }
  const sourceIds = new Set(project.sourceCues.map((cue) => cue.id));
  const characterIds = new Set<string>();
  for (const character of project.characters) {
    if (
      !character.id ||
      characterIds.has(character.id) ||
      !character.name.trim() ||
      !/^#[0-9a-f]{6}$/i.test(character.color) ||
      !Array.isArray(character.references)
    )
      throw new Error('INVALID_CHARACTER');
    characterIds.add(character.id);
    for (const reference of character.references)
      if (
        !reference.id ||
        !reference.path.startsWith('characters/') ||
        reference.path.includes('..') ||
        reference.durationMs < 500 ||
        reference.durationMs > 20000
      )
        throw new Error('INVALID_REFERENCE_AUDIO');
  }
  const targetIds = new Set(project.targetCues.map((cue) => cue.id));
  const referenceIds = new Set<string>();
  for (const reference of project.voiceReferences ?? []) {
    if (
      project.formatVersion < 9 ||
      !reference.id ||
      referenceIds.has(reference.id) ||
      !reference.path.startsWith('characters/') ||
      /\.\.|[\\:]/.test(reference.path) ||
      !Number.isSafeInteger(reference.durationMs) ||
      reference.durationMs < 1000 ||
      reference.durationMs > 20000 ||
      typeof reference.transcript !== 'string'
    )
      throw Error('INVALID_REFERENCE_AUDIO');
    referenceIds.add(reference.id);
  }
  for (const dialogue of project.dialogues) {
    if (dialogue.characterId && !characterIds.has(dialogue.characterId))
      throw new Error('INVALID_CHARACTER');
    if (
      !Array.isArray(dialogue.sourceCueIds) ||
      !Array.isArray(dialogue.targetCueIds) ||
      !Array.isArray(dialogue.warnings) ||
      dialogue.endMs <= dialogue.startMs
    )
      throw new Error('INVALID_PROJECT');
    if (
      dialogue.sourceCueIds.some((id) => !sourceIds.has(id)) ||
      dialogue.targetCueIds.some((id) => !targetIds.has(id))
    )
      throw new Error('INVALID_PROJECT');
  }
  if (
    project.media &&
    (!Number.isFinite(project.media.durationMs) ||
      project.media.durationMs < 0 ||
      !Array.isArray(project.media.streams))
  )
    throw new Error('INVALID_PROJECT');
  const generations = new Set<string>();
  for (const generation of project.generations) {
    if (generation.kind !== 'tts') continue;
    if (
      !validVoiceSettings(generation.options) ||
      (project.formatVersion < 9 &&
        (generation.options?.referenceMode === 'file' ||
          (generation.options?.accent && generation.options.accent !== 'auto'))) ||
      project.formatVersion < voiceSettingsFormat(generation.options) ||
      !Number.isSafeInteger(generation.startMs) ||
      !Number.isSafeInteger(generation.endMs) ||
      typeof generation.startMs !== 'number' ||
      typeof generation.endMs !== 'number' ||
      generation.endMs <= generation.startMs ||
      generation.sampleRate !== 24000 ||
      typeof generation.referenceTranscript !== 'string'
    )
      throw Error('INVALID_GENERATION');
    if (
      project.formatVersion < 5 ||
      !generation.id ||
      generations.has(generation.id) ||
      typeof generation.path !== 'string' ||
      !generation.path.startsWith('generations/') ||
      generation.path.includes('..') ||
      generation.path.includes('\\') ||
      generation.path.includes(':') ||
      typeof generation.durationMs !== 'number' ||
      !Number.isSafeInteger(generation.durationMs) ||
      generation.durationMs <= 0 ||
      generation.durationMs > 120000 ||
      !generation.dialogueId ||
      !generation.language ||
      typeof generation.text !== 'string' ||
      !generation.inputHash
    )
      throw Error('INVALID_GENERATION');
    generations.add(generation.id);
  }
  for (const line of project.dialogues) {
    if (
      line.voiceSettings &&
      (project.formatVersion < 5 ||
        !validVoiceSettings(line.voiceSettings) ||
        (project.formatVersion < 9 &&
          (line.voiceSettings.referenceMode === 'file' ||
            (line.voiceSettings.accent && line.voiceSettings.accent !== 'auto'))) ||
        project.formatVersion < voiceSettingsFormat(line.voiceSettings))
    )
      throw Error('INVALID_TTS_REQUEST');
    for (const [language, id] of Object.entries(line.selectedGenerationIds))
      if (
        !project.generations.some(
          (g) => g.id === id && g.dialogueId === line.id && g.language === language,
        )
      )
        throw Error('INVALID_GENERATION');
  }
  validateTakeOrigins(project);
  validateDubbingPipelines(project);
  validateCharacterProfiles(project);
  validateVoiceLibraries(project);
  validateProsody(project);
  validateLipVideos(project);
  validateAudioPatches(project);
  return project;
}
