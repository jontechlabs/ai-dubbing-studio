import type { Generation, Project } from './types';
import { dubbingClips, resizeDubbing } from './mix';

// Source coordinates always refer to the immutable generated WAV. Output
// durations describe the edited take; null coordinates are inserted silence.
export interface VoicePiece {
  sourceStartMs: number | null;
  sourceEndMs: number | null;
  durationMs: number;
  gain: number;
}
export interface VoiceEdit {
  pieces: VoicePiece[];
}
export const editDuration = (edit: VoiceEdit) => edit.pieces.reduce((n, p) => n + p.durationMs, 0);
export function validateVoiceEdit(edit: VoiceEdit, duration: number) {
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
        (p.sourceStartMs === null
          ? p.sourceEndMs !== null
          : !Number.isSafeInteger(p.sourceStartMs) ||
            !Number.isSafeInteger(p.sourceEndMs) ||
            p.sourceStartMs < 0 ||
            p.sourceEndMs! <= p.sourceStartMs ||
            p.sourceEndMs! > duration),
    ) ||
    editDuration(edit) > 120000
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
    let offset = 0,
      assigned = 0;
    return {
      pieces: existing.pieces.map((p, i) => {
        offset += p.durationMs;
        const end = Math.max(
          assigned + 1,
          Math.min(
            target - (existing.pieces.length - i - 1),
            Math.round((offset / total) * target),
          ),
        );
        const durationMs = end - assigned;
        assigned = end;
        return { ...p, durationMs };
      }),
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
      });
      after.push({
        ...p,
        sourceStartMs: boundary === p.sourceEndMs ? null : boundary,
        sourceEndMs: boundary === p.sourceEndMs ? null : p.sourceEndMs,
        durationMs: end - at,
      });
    }
    offset = end;
  }
  return [before, after];
}
export type VoiceOperation =
  | { kind: 'silence'; durationMs: number }
  | { kind: 'delete' }
  | { kind: 'gain'; gain: number }
  | { kind: 'stretch'; durationMs: number };
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
  } else if (operation.kind === 'delete') pieces = [...before, ...after];
  else if (operation.kind === 'gain')
    pieces = [...before, ...selected.map((p) => ({ ...p, gain: operation.gain })), ...after];
  else {
    if (!Number.isSafeInteger(operation.durationMs) || operation.durationMs < selected.length)
      throw Error('INVALID_VOICE_EDIT');
    let assigned = 0,
      old = 0;
    const stretched = selected.map((p) => {
      old += p.durationMs;
      const boundary = Math.round((old * operation.durationMs) / (endMs - startMs));
      const durationMs = boundary - assigned;
      assigned = boundary;
      return { ...p, durationMs };
    });
    pieces = [...before, ...stretched, ...after];
  }
  // Coalesce adjacent silence and unchanged contiguous source pieces, keeping
  // repeated volume adjustments from unnecessarily growing the edit list.
  const merged: VoicePiece[] = [];
  for (const p of pieces) {
    const last = merged.at(-1);
    if (
      last &&
      last.gain === p.gain &&
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
  const nextStart = dubbingClips(project)
    .filter((c) => c.line.id !== clip.line.id && c.startMs > clip.startMs)
    .reduce((n, c) => Math.min(n, c.startMs), project.media!.durationMs);
  if (duration > total && duration > nextStart - clip.startMs) throw Error('VOICE_EDIT_NO_ROOM');
  const next = resizeDubbing(project, clip.line.id, duration);
  next.formatVersion = Math.max(11, next.formatVersion);
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
