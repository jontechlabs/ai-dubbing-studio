import type { Project } from './types';
export interface VoiceConversionOptions {
  referenceMode?: 'current' | 'reference';
  referenceTrackId?: string;
  generationId: string;
  referenceId: string;
  characterId: string | null;
  device: string;
}
export interface DubbingPipelineOptions {
  lineId: string;
  tts: import('./types').VoiceSettings;
  conversion: VoiceConversionOptions;
  guideStrength: number;
}
export interface TakeOrigin {
  type: 'microphone' | 'conversion';
  sourceGenerationId?: string;
  referenceId?: string;
  characterId?: string | null;
}
export function validateTakeOrigins(project: Project) {
  for (const item of project.generations) {
    if (item.takeOrigin === undefined) continue;
    const origin = item.takeOrigin as TakeOrigin;
    if (
      !origin ||
      typeof origin !== 'object' ||
      Array.isArray(origin) ||
      project.formatVersion < 17 ||
      item.kind !== 'tts' ||
      !['microphone', 'conversion'].includes(origin.type) ||
      (origin.type === 'conversion' &&
        (typeof origin.sourceGenerationId !== 'string' ||
          !origin.sourceGenerationId ||
          origin.sourceGenerationId === item.id ||
          typeof origin.referenceId !== 'string' ||
          !origin.referenceId))
    )
      throw Error('INVALID_VOICE_CONVERSION');
  }
}
