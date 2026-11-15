import type { Job } from './types';

export interface GenerationTiming {
  takeId: string;
  operation: 'tts' | 'voiceConversion' | 'prosody';
  elapsedMs: number;
  inputUnits: number;
  warmModel: boolean;
  contextKey: string;
}
export interface GenerationEstimate {
  operation: GenerationTiming['operation'];
  estimatedMs: number | null;
  baselineElapsedMs: number;
  sampleCount: number;
}
export function validGenerationTiming(value: unknown): value is GenerationTiming {
  if (!value || typeof value !== 'object') return false;
  const t = value as GenerationTiming;
  return (
    typeof t.takeId === 'string' &&
    t.takeId.length > 0 &&
    t.takeId.length <= 128 &&
    ['tts', 'voiceConversion', 'prosody'].includes(t.operation) &&
    Number.isSafeInteger(t.elapsedMs) &&
    t.elapsedMs > 0 &&
    t.elapsedMs <= 86400000 &&
    Number.isSafeInteger(t.inputUnits) &&
    t.inputUnits > 0 &&
    t.inputUnits <= 120000 &&
    typeof t.warmModel === 'boolean' &&
    typeof t.contextKey === 'string' &&
    /^[a-fA-F0-9]{64}$/.test(t.contextKey)
  );
}
export function ownGenerationTiming(g: {
  id: string;
  generationTiming?: unknown;
}): GenerationTiming | null {
  const timing = g.generationTiming;
  // Older clients may copy metadata when deriving a take. Do not attribute the
  // parent's computation to a child that was never timed.
  return validGenerationTiming(timing) && timing.takeId === g.id ? timing : null;
}
export function remainingGenerationMs(
  job: Job,
  elapsed: number | null,
): number | null | 'learning' | 'overrun' {
  const e = job.estimate;
  const prefix =
    e?.operation === 'voiceConversion' ? 'vc' : e?.operation === 'prosody' ? 'prosody' : 'tts';
  if (job.status !== 'running' || !e || !job.stage.startsWith(prefix) || job.stage === 'ttsRelease')
    return null;
  if (e.estimatedMs === null || e.sampleCount < 1) return 'learning';
  if (
    elapsed === null ||
    !Number.isFinite(elapsed) ||
    !Number.isFinite(e.estimatedMs) ||
    e.estimatedMs <= 0 ||
    e.estimatedMs > 86400000 ||
    !Number.isFinite(e.baselineElapsedMs) ||
    e.baselineElapsedMs < 0
  )
    return null;
  const remaining = e.estimatedMs - Math.max(0, elapsed - e.baselineElapsedMs);
  return remaining <= 0 ? 'overrun' : remaining;
}
