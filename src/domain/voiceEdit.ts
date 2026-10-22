import {
  validEnvelope,
  sliceEnvelope,
  scaleEnvelope,
  fadeEnvelope,
  type VoicePoint,
} from './voiceEnvelope';
import type { Generation, Project } from './types';
import { dubbingClips, dubbingBounds, resizeDubbing } from './mix';
import { MAX_VOICE_DURATION_MS, fitPieceDurations } from './voiceLimits';
import { validateEffects, type AudioEffect } from './audioEffects';

// Source coordinates always refer to the immutable generated WAV. Output
// durations describe the edited take; null coordinates are inserted silence.
export interface VoicePiece {
  effects?: AudioEffect[];
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  durationMs: number;
  gain: number;
  envelope?: VoicePoint[];
}
export interface VoiceEdit {
  pieces: VoicePiece[];
}
export const editDuration = (edit: VoiceEdit) => edit.pieces.reduce((n, p) => n + p.durationMs, 0);
export function validateVoiceEdit(edit: VoiceEdit, duration: number) {
  if (Array.isArray(edit?.pieces)) for (const p of edit.pieces) validateEffects(p.effects ?? []);
  if (
    !edit ||
    !Array.isArray(edit.pieces) ||
    !edit.pieces.length ||
    edit.pieces.length > 256 ||
    edit.pieces.some(
      (p) =>
        !Number.isSafeInteger(p.durationMs) ||
        p.durationMs < 1 ||
        !Number.isFinite(p.gain) ||
        p.gain < 0 ||
        p.gain > 2 ||
        !validEnvelope(p.envelope, p.durationMs) ||
        (p.sourceStartMs === null
          ? p.sourceEndMs !== null
          : !Number.isSafeInteger(p.sourceStartMs) ||
            !Number.isSafeInteger(p.sourceEndMs) ||
            p.sourceStartMs < 0 ||
            p.sourceEndMs! <= p.sourceStartMs ||
            p.sourceEndMs! > duration),
    ) ||
    editDuration(edit) > MAX_VOICE_DURATION_MS
  )
    throw Error('INVALID_VOICE_EDIT');
}
export function voicePlan(project: Project, generation: Generation): VoiceEdit {
  const existing = project.voiceEdits?.[generation.id];
  const clip = dubbingClips(project).find((c) => c.generation.id === generation.id);
  if (existing) {
    const target = clip ? Math.max(1, clip.endMs - clip.startMs) : editDuration(existing);
    const total = editDuration(existing);
    if (target === total || target < existing.pieces.length) return existing;
    const durations = fitPieceDurations(
      existing.pieces.map((p) => p.durationMs),
      target,
    );
    return {
      pieces: existing.pieces.map((p, i) => ({
        ...p,
        durationMs: durations[i],
        envelope: scaleEnvelope(p.envelope, p.durationMs, durations[i]),
      })),
    };
  }
  return {
    pieces: [
      {
        sourceStartMs: 0,
        sourceEndMs: generation.durationMs,
        durationMs: clip ? Math.max(1, clip.endMs - clip.startMs) : generation.durationMs,
        gain: 1,
      },
    ],
  };
}
function split(pieces: VoicePiece[], at: number): [VoicePiece[], VoicePiece[]] {
  const before: VoicePiece[] = [],
    after: VoicePiece[] = [];
  let offset = 0;
  for (const p of pieces) {
    const end = offset + p.durationMs;
    if (end <= at) before.push({ ...p });
    else if (offset >= at) after.push({ ...p });
    else {
      const left = at - offset;
      const boundary =
        p.sourceStartMs === null
          ? null
          : Math.round(
              p.sourceStartMs + ((p.sourceEndMs! - p.sourceStartMs) * left) / p.durationMs,
            );
      // A sub-millisecond source slice cannot be represented. Preserve duration
      // as silence rather than create an invalid/inverted source interval.
      before.push({
        ...p,
        sourceStartMs: boundary === p.sourceStartMs ? null : p.sourceStartMs,
        sourceEndMs: boundary === p.sourceStartMs ? null : boundary,
        durationMs: left,
        envelope: sliceEnvelope(p.envelope, 0, left),
      });
      after.push({
        ...p,
        sourceStartMs: boundary === p.sourceEndMs ? null : boundary,
        sourceEndMs: boundary === p.sourceEndMs ? null : p.sourceEndMs,
        durationMs: end - at,
        envelope: sliceEnvelope(p.envelope, left, p.durationMs),
      });
    }
    offset = end;
  }
  return [before, after];
}
export type VoiceOperation =
  | { kind: 'effects'; effects: AudioEffect[] }
  | { kind: 'silence'; durationMs: number }
  | { kind: 'delete' }
  | { kind: 'gain'; gain: number }
  | { kind: 'stretch'; durationMs: number }
  | { kind: 'fade'; fadeInMs: number; fadeOutMs: number };
export function editVoice(
  project: Project,
  generationId: string,
  startMs: number,
  endMs: number,
  operation: VoiceOperation,
): Project {
  const generation = project.generations.find((g) => g.kind === 'tts' && g.id === generationId) as
    Generation | undefined;
  const clip = dubbingClips(project).find((c) => c.generation.id === generationId);
  if (!generation || !clip || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs))
    throw Error('INVALID_VOICE_EDIT');
  if (dubbingBounds(project, clip.line.id).duration < dubbingBounds(project, clip.line.id).min)
    throw Error('VOICE_EDIT_NO_ROOM');
  const plan = voicePlan(project, generation),
    total = editDuration(plan);
  if (
    startMs < 0 ||
    endMs < startMs ||
    endMs > total ||
    (operation.kind !== 'silence' && endMs === startMs)
  )
    throw Error('INVALID_VOICE_EDIT');
  const [before, tail] = split(plan.pieces, startMs),
    [selected, after] = split(tail, endMs - startMs);
  let pieces: VoicePiece[];
  if (operation.kind === 'silence') {
    if (!Number.isSafeInteger(operation.durationMs) || operation.durationMs < 1)
      throw Error('INVALID_VOICE_EDIT');
    pieces = [
      ...before,
      { sourceStartMs: null, sourceEndMs: null, durationMs: operation.durationMs, gain: 1 },
      ...tail,
    ];
  } else if (operation.kind === 'effects') {
    validateEffects(operation.effects);
    pieces = [
      ...before,
      ...selected.map((p) => ({ ...p, effects: structuredClone(operation.effects) })),
      ...after,
    ];
  } else if (operation.kind === 'delete') pieces = [...before, ...after];
  else if (operation.kind === 'gain')
    pieces = [...before, ...selected.map((p) => ({ ...p, gain: operation.gain })), ...after];
  else if (operation.kind === 'fade') {
    if (
      ![operation.fadeInMs, operation.fadeOutMs].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      operation.fadeInMs + operation.fadeOutMs > endMs - startMs
    )
      throw Error('INVALID_VOICE_FADE');
    let offset = 0;
    pieces = [
      ...before,
      ...selected.map((p) => {
        const envelope = fadeEnvelope(
          offset,
          p.durationMs,
          endMs - startMs,
          operation.fadeInMs,
          operation.fadeOutMs,
        );
        offset += p.durationMs;
        return { ...p, envelope };
      }),
      ...after,
    ];
  } else {
    if (!Number.isSafeInteger(operation.durationMs) || operation.durationMs < selected.length)
      throw Error('INVALID_VOICE_EDIT');
    const durations = fitPieceDurations(
      selected.map((p) => p.durationMs),
      operation.durationMs,
    );
    const stretched = selected.map((p, i) => ({
      ...p,
      durationMs: durations[i],
      envelope: scaleEnvelope(p.envelope, p.durationMs, durations[i]),
    }));
    pieces = [...before, ...stretched, ...after];
  }
  // Coalesce adjacent silence and unchanged contiguous source pieces, keeping
  // repeated volume adjustments from unnecessarily growing the edit list.
  const merged: VoicePiece[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (
      last &&
      !last.envelope &&
      !p.envelope &&
      last.gain === p.gain &&
      JSON.stringify(last.effects ?? []) === JSON.stringify(p.effects ?? []) &&
      ((last.sourceStartMs === null && p.sourceStartMs === null) ||
        (last.sourceEndMs === p.sourceStartMs &&
          p.sourceStartMs !== null &&
          last.sourceStartMs !== null &&
          Math.abs(
            (last.sourceEndMs! - last.sourceStartMs) / last.durationMs -
              (p.sourceEndMs! - p.sourceStartMs) / p.durationMs,
          ) < 1e-9))
    ) {
      last.sourceEndMs = p.sourceEndMs;
      last.durationMs += p.durationMs;
    } else merged.push({ ...p });
  }
  const edit = { pieces: merged };
  validateVoiceEdit(edit, generation.durationMs);
  const duration = editDuration(edit);
  if (duration > dubbingBounds(project, clip.line.id).max) throw Error('VOICE_EDIT_NO_ROOM');
  const changed = structuredClone(project);
  (changed.voiceEdits ??= {})[generationId] = edit;
  const next = resizeDubbing(changed, clip.line.id, duration);
  next.formatVersion = Math.max(pieces.some((p) => p.envelope) ? 12 : 11, next.formatVersion);
  if (pieces.some((p) => p.effects?.length)) next.formatVersion = Math.max(18, next.formatVersion);
  (next.voiceEdits ??= {})[generationId] = edit;
  const line = next.dialogues.find((l) => l.id === clip.line.id)!;
  if (line.status === 'validated') line.status = 'review';
  for (const g of next.generations)
    if (g.kind === 'lipVideo' && g.generationId === generationId) g.enabled = false;
  return next;
}
export function resetVoiceEdit(project: Project, generationId: string): Project {
  const next = structuredClone(project);
  delete next.voiceEdits?.[generationId];
  for (const g of next.generations)
    if (g.kind === 'lipVideo' && g.generationId === generationId) g.enabled = false;
  const clip = dubbingClips(project).find((c) => c.generation.id === generationId);
  return clip ? resizeDubbing(next, clip.line.id, null) : next;
}
