import data from '../../resources/audio-effects.json' with { type: 'json' };
export type EffectKind =
  | 'equalizer'
  | 'pitch'
  | 'highpass'
  | 'lowpass'
  | 'compressor'
  | 'limiter'
  | 'gate'
  | 'normalize'
  | 'denoise'
  | 'deesser'
  | 'echo'
  | 'reverb'
  | 'saturation'
  | 'distortion'
  | 'robot'
  | 'chorus'
  | 'flanger'
  | 'phaser'
  | 'tremolo'
  | 'vibrato';
export interface AudioEffect {
  kind: EffectKind;
  enabled: boolean;
  parameters: Record<string, number>;
}
export interface AudioEffectsOptions {
  name?: string;
  trackId: string;
  scope: 'track' | 'selection';
  startMs: number;
  endMs: number;
  effects: AudioEffect[];
  replaceInMix: boolean;
}
export interface EffectsCatalog {
  version: number;
  maxChain: number;
  effects: {
    id: EffectKind;
    label: { fr: string; en: string };
    group: string;
    parameters: {
      id: string;
      label: { fr: string; en: string };
      min: number;
      max: number;
      step: number;
      default: number;
      unit: string;
    }[];
  }[];
  presets: { id: string; label: { fr: string; en: string }; chain: AudioEffect[] }[];
}
export const audioEffectsCatalog = data as unknown as EffectsCatalog;
export function defaultEffect(kind: EffectKind): AudioEffect {
  const item = data.effects.find((e) => e.id === kind);
  if (!item) throw Error('INVALID_AUDIO_EFFECTS');
  return {
    kind,
    enabled: true,
    parameters: Object.fromEntries(item.parameters.map((p) => [p.id, p.default])),
  };
}
export function validateEffects(effects: AudioEffect[]) {
  if (!Array.isArray(effects) || effects.length > data.maxChain)
    throw Error('INVALID_AUDIO_EFFECTS');
  for (const effect of effects) {
    if (!effect || typeof effect !== 'object') throw Error('INVALID_AUDIO_EFFECTS');
    const spec = data.effects.find((e) => e.id === effect.kind);
    if (
      !spec ||
      typeof effect.enabled !== 'boolean' ||
      !effect.parameters ||
      typeof effect.parameters !== 'object' ||
      Array.isArray(effect.parameters)
    )
      throw Error('INVALID_AUDIO_EFFECTS');
    for (const [key, value] of Object.entries(effect.parameters)) {
      const param = spec.parameters.find((p) => p.id === key);
      if (!param || !Number.isFinite(value) || value < param.min || value > param.max)
        throw Error('INVALID_AUDIO_EFFECTS');
    }
  }
}
export function removeEffectsTrack(project: import('./types').Project, id: string) {
  const record = project.generations.find((g) => g.kind === 'audioEffects' && g.trackId === id) as
    | { id: string; sourceTrackId?: unknown; replaceInMix?: unknown; sourceMuteBefore?: unknown }
    | undefined;
  if (
    !record ||
    project.generations.some((g) => g.kind === 'audioEffects' && g.sourceTrackId === id)
  )
    throw Error('AUDIO_EFFECTS_SOURCE_IN_USE');
  const next = structuredClone(project);
  next.tracks = next.tracks
    .filter((t) => t.id !== id)
    .map((t) =>
      t.id === record.sourceTrackId && record.replaceInMix
        ? { ...t, mute: record.sourceMuteBefore === true }
        : t,
    );
  next.generations = next.generations.filter(
    (g) =>
      !(g.kind === 'audioEffects' && g.trackId === id) &&
      !(g.kind === 'audioPatch' && g.trackId === id),
  );
  return next;
}
export function validateEffectsProject(project: import('./types').Project) {
  const safe = (p: unknown) =>
    typeof p === 'string' &&
    p.startsWith('stems/patch-') &&
    p.endsWith('.wav') &&
    !p.includes('..') &&
    !/[\\:]/.test(p);
  for (const generation of project.generations) {
    const g = generation as unknown as Record<string, unknown>;
    if (g.kind !== 'audioEffects' && !(g.kind === 'audioPatch' && g.operation === 'effects'))
      continue;
    if (project.formatVersion < 18 || !safe(g.effectsSourcePath))
      throw Error('INVALID_AUDIO_EFFECTS');
    validateEffects(g.effects as AudioEffect[]);
    if (
      g.kind === 'audioEffects' &&
      (!safe(g.path) ||
        g.id !== g.trackId ||
        typeof g.sourceTrackId !== 'string' ||
        g.sourceTrackId === g.trackId ||
        typeof g.replaceInMix !== 'boolean' ||
        typeof g.sourceMuteBefore !== 'boolean' ||
        !project.tracks.some((t) => t.id === g.trackId && t.kind === 'audio' && t.path === g.path))
    )
      throw Error('INVALID_AUDIO_EFFECTS');
  }
}
