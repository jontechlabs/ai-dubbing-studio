import type { Project } from './types';
import { validVoiceSettings } from './tts';
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
export interface DubbingPipelineRecord {
  stageIds: string[];
  settings: DubbingPipelineOptions;
  engine: 'chatterbox-vc';
}
export function validateDubbingPipelines(project: Project) {
  for (const g of project.generations) {
    if (g.kind !== 'tts' || g.dubbingPipeline === undefined) continue;
    const m = g.dubbingPipeline as DubbingPipelineRecord,
      o = m?.settings,
      c = o?.conversion,
      ids = m?.stageIds;
    if (
      !m ||
      !o ||
      project.formatVersion < 23 ||
      m.engine !== 'chatterbox-vc' ||
      o?.lineId !== g.dialogueId ||
      !Number.isFinite(o.guideStrength) ||
      o.guideStrength < 0 ||
      o.guideStrength > 1 ||
      !Array.isArray(ids) ||
      ids.length !== (o.guideStrength > 0 ? 3 : 2) ||
      new Set(ids).size !== ids.length ||
      ids.some((s) => typeof s !== 'string' || !s || s.length > 128) ||
      ids.at(-1) !== g.id ||
      !validVoiceSettings(o.tts) ||
      !c ||
      !c.generationId ||
      c.generationId.length > 128 ||
      (!['auto', 'cpu'].includes(c.device) && !/^cuda:\d{1,2}$/.test(c.device)) ||
      (c.referenceMode !== undefined && !['current', 'reference'].includes(c.referenceMode)) ||
      (c.referenceMode !== 'current' && (!c.referenceId || c.referenceId.length > 128))
    )
      throw Error('INVALID_DUBBING_PIPELINE');
  }
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
