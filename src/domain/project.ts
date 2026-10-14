import type { Project } from './types';
import { alignCues } from './subtitles';
export const APP_VERSION = '0.3.3';

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
  if (![1, 2].includes(project.formatVersion)) throw new Error('UNSUPPORTED_PROJECT_VERSION');
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
  const sourceIds = new Set(project.sourceCues.map((cue) => cue.id));
  const targetIds = new Set(project.targetCues.map((cue) => cue.id));
  for (const dialogue of project.dialogues) {
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
  return project;
}
