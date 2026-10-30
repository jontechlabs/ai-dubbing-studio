import type { Dialogue, Generation, Project } from './types';
import { selectedGeneration, staleGeneration } from './tts';
import { isolatedVoice, type IsolatedVoice } from './speakerDubbing';
import { libraryReference } from './voiceLibrary';

export interface JointReviewSnapshot {
  isolatedVoice?: IsolatedVoice;
  sourceCues: import('./types').Cue[];
  targetCues: import('./types').Cue[];
  ttsText: string | null;
  pronunciation: Record<string, string>;
  startMs: number;
  endMs: number;
  characterId: string | null;
  sourcePath: string | null;
  generation: Generation | null;
  reference: { id: string; path: string; transcript: string; defaultId: string | null } | null;
  edit: {
    outputGain: number;
    pieces: {
      sourceStartMs: number | null;
      sourceEndMs: number | null;
      durationMs: number;
      gain: number;
      envelope: import('./voiceEnvelope').VoicePoint[];
      effects: import('./audioEffects').AudioEffect[];
    }[];
  } | null;
  offsetMs: number;
  durationMs: number | null;
}
export function reviewIndex(project: Project) {
  return {
    source: new Map(project.sourceCues.map((c) => [c.id, c])),
    target: new Map(project.targetCues.map((c) => [c.id, c])),
    generations: new Map(
      project.generations.filter((g): g is Generation => g.kind === 'tts').map((g) => [g.id, g]),
    ),
  };
}
export function indexedTake(
  project: Project,
  line: Dialogue,
  index: ReturnType<typeof reviewIndex>,
) {
  const g = index.generations.get(line.selectedGenerationIds[project.languages.target]);
  return g?.dialogueId === line.id && g.language === project.languages.target ? g : null;
}
export function jointReviewSnapshot(
  project: Project,
  line: Dialogue,
  generation: Generation | null = selectedGeneration(project, line) ?? null,
  index?: ReturnType<typeof reviewIndex>,
): JointReviewSnapshot {
  const edit = generation && project.voiceEdits?.[generation.id];
  const mode = generation?.options.referenceMode;
  const character = project.characters.find((c) => c.id === line.characterId);
  const reference =
    !generation || generation.takeOrigin || mode === 'current'
      ? undefined
      : mode === 'library'
        ? libraryReference(project, line.characterId, generation.referenceId ?? null)
        : mode === 'file'
          ? project.voiceReferences?.find((r) => r.id === generation.referenceId)
          : character?.references.find(
              (r) =>
                r.id ===
                (generation.referenceId ??
                  (mode === 'custom'
                    ? generation.options.referenceId
                    : character.defaultReferenceId)),
            );
  const timing =
    project.dubbingTiming?.sourcePath === project.media?.path ? project.dubbingTiming : undefined;
  return {
    ...(isolatedVoice(project, line.id)
      ? { isolatedVoice: structuredClone(isolatedVoice(project, line.id)!.voice) }
      : {}),
    sourceCues: line.sourceCueIds.flatMap((id) => {
      const c = index ? index.source.get(id) : project.sourceCues.find((c) => c.id === id);
      return c ? [{ ...c }] : [];
    }),
    targetCues: line.targetCueIds.flatMap((id) => {
      const c = index ? index.target.get(id) : project.targetCues.find((c) => c.id === id);
      return c ? [{ ...c }] : [];
    }),
    ttsText: line.ttsText,
    pronunciation: structuredClone(project.pronunciation),
    startMs: line.startMs,
    endMs: line.endMs,
    characterId: line.characterId,
    sourcePath: project.media?.path ?? null,
    generation: generation ? structuredClone(generation) : null,
    reference: reference
      ? {
          id: reference.id,
          path: reference.path,
          transcript: reference.transcript,
          defaultId: mode === 'character' ? (character?.defaultReferenceId ?? null) : null,
        }
      : null,
    edit: edit
      ? {
          outputGain: edit.outputGain ?? 1,
          pieces: edit.pieces.map((p) => ({
            sourceStartMs: p.sourceStartMs,
            sourceEndMs: p.sourceEndMs,
            durationMs: p.durationMs,
            gain: p.gain,
            envelope: p.envelope ?? [],
            effects: p.effects ?? [],
          })),
        }
      : null,
    offsetMs: timing?.offsetsMs[line.id]?.[project.languages.target] ?? 0,
    durationMs: timing?.durationsMs?.[line.id]?.[project.languages.target] ?? null,
  };
}
// JSON object order changes across the JS/Rust persistence boundary.
export function sameReview(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameReview(v, b[i]))
    );
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  return (
    Object.keys(x).length === Object.keys(y).length &&
    Object.keys(x).every((k) => Object.hasOwn(y, k) && sameReview(x[k], y[k]))
  );
}
export function canApproveJointReview(project: Project, line: Dialogue) {
  if (line.excludedFromDubbing) return false;
  const take = selectedGeneration(project, line);
  return !take || !staleGeneration(project, line, take);
}
