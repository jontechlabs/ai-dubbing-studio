import type { Project } from './types';
export interface ProsodyOptions {
  generationId: string;
  referenceMode: 'dialogue' | 'reference';
  referenceId: string | null;
  characterId?: string | null;
  referenceTrackId?: string | null;
  strength: number;
  pitch: boolean;
  rhythm: boolean;
  energy: boolean;
}
export interface ProsodyTransfer {
  algorithm: 'praat-psola-v1';
  sourceGenerationId: string;
  sourceDurationMs: number;
  guideDurationMs: number;
  options: ProsodyOptions;
}
export function validProsodyOptions(value: unknown): value is ProsodyOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const o = value as ProsodyOptions;
  return (
    typeof o.generationId === 'string' &&
    o.generationId.length > 0 &&
    o.generationId.length <= 128 &&
    ['dialogue', 'reference'].includes(o.referenceMode) &&
    [o.referenceId, o.characterId, o.referenceTrackId].every(
      (id) => id == null || (typeof id === 'string' && id.length > 0 && id.length <= 128),
    ) &&
    (o.referenceMode !== 'reference' || !!o.referenceId) &&
    Number.isFinite(o.strength) &&
    o.strength >= 0 &&
    o.strength <= 1 &&
    [o.pitch, o.rhythm, o.energy].every((v) => typeof v === 'boolean') &&
    (o.pitch || o.rhythm || o.energy) &&
    Object.keys(o).every((key) =>
      [
        'generationId',
        'referenceMode',
        'referenceId',
        'characterId',
        'referenceTrackId',
        'strength',
        'pitch',
        'rhythm',
        'energy',
      ].includes(key),
    )
  );
}
export function validateProsody(project: Project) {
  for (const g of project.generations) {
    if (g.prosodyTransfer === undefined) continue;
    const p = g.prosodyTransfer as ProsodyTransfer;
    if (
      !p ||
      project.formatVersion < 14 ||
      g.kind !== 'tts' ||
      p.algorithm !== 'praat-psola-v1' ||
      !validProsodyOptions(p.options) ||
      p.sourceGenerationId !== p.options.generationId ||
      p.sourceGenerationId === g.id ||
      [p.sourceDurationMs, p.guideDurationMs].some(
        (n) => !Number.isSafeInteger(n) || n < 150 || n > 30000,
      )
    )
      throw Error('INVALID_PROSODY_REQUEST');
  }
}
