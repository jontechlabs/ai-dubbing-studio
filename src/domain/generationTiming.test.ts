import { describe, it, expect } from 'vitest';
import {
  ownGenerationTiming,
  remainingGenerationMs,
  validGenerationTiming,
} from './generationTiming';
import type { GenerationTiming } from './generationTiming';
import type { Job } from './types';
const timing: GenerationTiming = {
  takeId: 'take',
  operation: 'tts',
  elapsedMs: 42000,
  inputUnits: 40,
  warmModel: false,
  contextKey: 'a'.repeat(64),
};
const job: Job = {
  id: 'j',
  projectId: 'p',
  kind: 'tts',
  status: 'running',
  stage: 'ttsGenerate',
  logs: [],
  progress: null,
  error: null,
  estimate: { operation: 'tts', estimatedMs: 60000, baselineElapsedMs: 30000, sampleCount: 3 },
};
describe('generation timing', () => {
  it('keeps old takes unknown and refuses to reuse a copied parent measurement', () => {
    expect(ownGenerationTiming({ id: 'take' })).toBeNull();
    expect(
      ownGenerationTiming({ id: 'take', generationTiming: JSON.parse(JSON.stringify(timing)) }),
    ).toEqual(timing);
    expect(ownGenerationTiming({ id: 'derived', generationTiming: timing })).toBeNull();
    for (const invalid of [
      null,
      {},
      { ...timing, elapsedMs: -1 },
      { ...timing, elapsedMs: Infinity },
      { ...timing, inputUnits: 0 },
      { ...timing, contextKey: 'bad' },
      { ...timing, warmModel: 0 },
    ])
      expect(validGenerationTiming(invalid)).toBe(false);
  });
  it('uses the current step offset in a long batch and displays overruns instead of zero seconds', () => {
    expect(remainingGenerationMs(job, 45000)).toBe(45000);
    expect(remainingGenerationMs(job, 90001)).toBe('overrun');
    expect(
      remainingGenerationMs(
        { ...job, estimate: { ...job.estimate!, estimatedMs: null, sampleCount: 0 } },
        45000,
      ),
    ).toBe('learning');
    for (const status of [
      'paused',
      'queued',
      'succeeded',
      'cancelled',
      'failed',
      'interrupted',
    ] as const)
      expect(remainingGenerationMs({ ...job, status }, 45000)).toBeNull();
    expect(remainingGenerationMs({ ...job, stage: 'vcGenerate' }, 45000)).toBeNull();
    expect(remainingGenerationMs({ ...job, stage: 'ttsRelease' }, 45000)).toBeNull();
    expect(
      remainingGenerationMs({ ...job, estimate: { ...job.estimate!, estimatedMs: NaN } }, 45000),
    ).toBeNull();
  });
});
