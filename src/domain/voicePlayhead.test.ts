import { expect, it } from 'vitest';
import { sourceToEditedTime } from './voicePlayhead';
import { beginVoicePlayback, readVoicePlayback } from '../services/voicePlayback';
import type { VoiceEdit } from './voiceEdit';

it('maps the original audio clock through stretches, inserted silence and deleted sections', () => {
  const plan: VoiceEdit = {
    pieces: [
      { sourceStartMs: 0, sourceEndMs: 500, durationMs: 1000, gain: 1 },
      { sourceStartMs: null, sourceEndMs: null, durationMs: 250, gain: 1 },
      { sourceStartMs: 750, sourceEndMs: 2000, durationMs: 625, gain: 1 },
    ],
  };
  expect(sourceToEditedTime(plan, 250)).toBe(500);
  expect(sourceToEditedTime(plan, 600)).toBeNull();
  expect(sourceToEditedTime(plan, 1000)).toBe(1375);
  expect(sourceToEditedTime(plan, 2000)).toBe(1875);
  expect(sourceToEditedTime(plan, 2001)).toBeNull();
  expect(sourceToEditedTime(plan, NaN)).toBeNull();
});

it('reads the audio clock and retains the actual stop position without stale ownership', () => {
  let positionMs = 120;
  const finish = beginVoicePlayback(() => ({
    generationId: 'a',
    positionMs,
    durationMs: 2000,
    original: false,
    playing: true,
  }));
  positionMs = 555;
  expect(readVoicePlayback().playback?.positionMs).toBe(555);
  finish();
  positionMs = 900;
  expect(readVoicePlayback().playback).toMatchObject({ positionMs: 555, playing: false });
  const other = beginVoicePlayback(() => ({
    generationId: 'b',
    positionMs: 0,
    durationMs: 1000,
    original: true,
    playing: true,
  }));
  finish();
  expect(readVoicePlayback().playback).toMatchObject({ generationId: 'b', playing: true });
  other();
});
