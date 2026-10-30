import { editDuration } from './voiceEdit';
import { MAX_VOICE_DURATION_MS, freeVoiceStart } from './voiceLimits';
import type { Project } from './types';
import { speakerDubbingState } from './speakerDubbing';
import { voiceGenerations, staleGeneration, spokenText } from './tts';
export function dubbingOffset(project: Project, lineId: string) {
  return project.dubbingTiming?.sourcePath === project.media?.path
    ? (project.dubbingTiming?.offsetsMs[lineId]?.[project.languages.target] ?? 0)
    : 0;
}
export function dubbingDuration(project: Project, lineId: string) {
  return project.dubbingTiming?.sourcePath === project.media?.path
    ? project.dubbingTiming?.durationsMs?.[lineId]?.[project.languages.target]
    : undefined;
}
function timingProject(project: Project) {
  if (!project.media) throw Error('MEDIA_MISSING');
  const next = structuredClone(project);
  next.formatVersion = Math.max(7, next.formatVersion);
  if (next.dubbingTiming?.sourcePath !== next.media!.path)
    next.dubbingTiming = { sourcePath: next.media!.path, offsetsMs: {} };
  return next;
}
export function dubbingBounds(project: Project, lineId: string) {
  const clips = dubbingClips(project),
    clip = clips.find((c) => c.line.id === lineId);
  const line = project.dialogues.find((l) => l.id === lineId);
  if (!line || !project.media) throw Error('INVALID_PROJECT');
  const startMs =
    clip?.startMs ??
    Math.max(
      0,
      Math.min(project.media.durationMs - 1, line.startMs + dubbingOffset(project, lineId)),
    );
  const family = speakerDubbingState(project);
  const others = clips.filter((c) => family.key(c.line.id) !== family.key(lineId));
  const next = others.reduce(
    (end, c) => (c.startMs >= startMs ? Math.min(end, c.startMs) : end),
    project.media.durationMs,
  );
  const min = Math.max(1, project.voiceEdits?.[clip?.generation.id ?? '']?.pieces.length ?? 1);
  const max = Math.max(0, Math.min(MAX_VOICE_DURATION_MS, next - startMs));
  const duration = clip ? clip.endMs - clip.startMs : 0;
  const requested = dubbingDuration(project, lineId);
  const natural = clip
    ? project.voiceEdits?.[clip.generation.id]
      ? editDuration(project.voiceEdits[clip.generation.id])
      : clip.generation.durationMs
    : 0;
  return {
    min,
    max,
    startMs,
    duration,
    limited:
      !!clip &&
      (duration < min ||
        (requested !== undefined && requested > max) ||
        (requested === undefined && dubbingOffset(project, lineId) !== 0 && natural > max)),
  };
}
export function resizeDubbing(
  project: Project,
  lineId: string,
  durationMs: number | null,
): Project {
  const bounds = dubbingBounds(project, lineId);
  if (
    durationMs !== null &&
    (!Number.isSafeInteger(durationMs) || durationMs < bounds.min || durationMs > bounds.max)
  )
    throw Error('VOICE_DURATION_OUT_OF_RANGE');
  const next = timingProject(project);
  next.dubbingTiming!.offsetsMs[lineId] = {
    ...next.dubbingTiming!.offsetsMs[lineId],
    [next.languages.target]: dubbingOffset(project, lineId),
  };
  const values = ((next.dubbingTiming!.durationsMs ??= {})[lineId] ??= {});
  if (durationMs === null) {
    delete values[next.languages.target];
    if (dubbingBounds(next, lineId).duration < bounds.min)
      throw Error('VOICE_DURATION_OUT_OF_RANGE');
  } else values[next.languages.target] = durationMs;
  return next;
}
function placeDubbing(
  project: Project,
  lineId: string,
  offsetMs: number,
  restore: boolean,
  preferNatural = false,
  durationOverride?: number,
): Project {
  const line = project.dialogues.find((l) => l.id === lineId);
  if (!line || !project.media || !Number.isSafeInteger(offsetMs)) throw Error('INVALID_PROJECT');
  const clips = dubbingClips(project),
    clip = clips.find((c) => c.line.id === lineId);
  const generation = voiceGenerations(project).find(
    (g) =>
      g.id === line.selectedGenerationIds[project.languages.target] &&
      g.sourcePath === project.media!.path,
  );
  const natural = generation
    ? project.voiceEdits?.[generation.id]
      ? editDuration(project.voiceEdits[generation.id])
      : generation.durationMs
    : line.endMs - line.startMs;
  const wanted = Math.min(
    MAX_VOICE_DURATION_MS,
    project.media.durationMs,
    durationOverride ??
      (restore
        ? Math.max(
            dubbingBounds(project, lineId).min,
            preferNatural ? natural : (dubbingDuration(project, lineId) ?? natural),
          )
        : Math.max(
            dubbingBounds(project, lineId).min,
            clip ? clip.endMs - clip.startMs || natural : natural,
          )),
  );
  if (wanted < dubbingBounds(project, lineId).min) throw Error('VOICE_EDIT_NO_ROOM');
  const family = speakerDubbingState(project);
  const start = freeVoiceStart(
    line.startMs + offsetMs,
    wanted,
    project.media.durationMs,
    clips
      .filter((c) => family.key(c.line.id) !== family.key(lineId))
      .map((c) => ({
        startMs: c.startMs,
        endMs:
          c.endMs > c.startMs
            ? c.endMs
            : Math.min(
                project.media!.durationMs,
                c.startMs +
                  Math.max(
                    1,
                    Math.min(
                      MAX_VOICE_DURATION_MS,
                      dubbingDuration(project, c.line.id) ??
                        (project.voiceEdits?.[c.generation.id]
                          ? editDuration(project.voiceEdits[c.generation.id])
                          : Math.min(c.generation.durationMs, c.line.endMs - c.line.startMs)),
                    ),
                  ),
              ),
      })),
    Math.max(0, line.startMs - 86_400_000),
    Math.min(project.media.durationMs - wanted, line.startMs + 86_400_000),
  );
  const next = timingProject(project);
  next.dubbingTiming!.offsetsMs[lineId] = {
    ...next.dubbingTiming!.offsetsMs[lineId],
    [next.languages.target]: start - line.startMs,
  };
  if (
    restore ||
    dubbingDuration(project, lineId) !== undefined ||
    (clip && clip.endMs - clip.startMs < wanted)
  )
    ((next.dubbingTiming!.durationsMs ??= {})[lineId] ??= {})[next.languages.target] = wanted;
  return next;
}
export function moveDubbing(project: Project, lineId: string, offsetMs: number): Project {
  return placeDubbing(project, lineId, offsetMs, false);
}
export function retimeDubbing(
  project: Project,
  lineId: string,
  offsetMs: number,
  durationMs: number,
): Project {
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > MAX_VOICE_DURATION_MS)
    throw Error('VOICE_DURATION_OUT_OF_RANGE');
  const next = placeDubbing(project, lineId, offsetMs, true, false, durationMs);
  // An analysis proposal must keep its reviewed onset. Never silently snap a
  // mouth-alignment proposal somewhere else to avoid a neighbouring voice.
  if (dubbingOffset(next, lineId) !== offsetMs) throw Error('VOICE_EDIT_NO_ROOM');
  return resizeDubbing(next, lineId, durationMs);
}
export function recoverDubbing(project: Project, lineId: string): Project {
  const bounds = dubbingBounds(project, lineId),
    requested = dubbingDuration(project, lineId);
  if (requested !== undefined && requested > bounds.max && bounds.duration >= bounds.min)
    return resizeDubbing(project, lineId, bounds.duration);
  try {
    return placeDubbing(project, lineId, dubbingOffset(project, lineId), true);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'VOICE_EDIT_NO_ROOM') throw error;
    // A legacy request may be both oversized and collapsed by a collision.
    // Recover using its complete original/edited audio duration if the saved
    // request itself cannot fit anywhere. No source samples are removed.
    return placeDubbing(project, lineId, dubbingOffset(project, lineId), true, true);
  }
}
export function dubbingClips(project: Project) {
  const family = speakerDubbingState(project);
  const generations = new Map(voiceGenerations(project).map((g) => [g.id, g]));
  const ordered = project.dialogues
    .flatMap((line) => {
      const generation = generations.get(line.selectedGenerationIds[project.languages.target]);
      if (
        !family.enabled(line.id) ||
        !generation ||
        generation.dialogueId !== line.id ||
        generation.language !== project.languages.target ||
        generation.sourcePath !== project.media?.path ||
        line.startMs >= (project.media?.durationMs ?? 0)
      )
        return [];
      const startMs = Math.max(
        0,
        Math.min(project.media!.durationMs - 1, line.startMs + dubbingOffset(project, line.id)),
      );
      const edit = project.voiceEdits?.[generation.id];
      const naturalDuration = edit ? editDuration(edit) : generation.durationMs;
      const durationMs = dubbingDuration(project, line.id);
      return [
        {
          line,
          lane: family.child.get(line.id)?.lane ?? 0,
          groupKey: family.child.get(line.id)?.group.id ?? null,
          overlapKey: family.key(line.id),
          generation,
          startMs,
          exactDuration: durationMs !== undefined,
          slotEndMs: Math.min(
            project.media!.durationMs,
            startMs + (durationMs ?? line.endMs - line.startMs),
          ),
          endMs: Math.min(project.media!.durationMs, startMs + naturalDuration),
        },
      ];
    })
    .sort((a, b) => a.startMs - b.startMs);
  const conflicts = new Set<number>();
  ordered.forEach((clip, index) => {
    const previous = ordered[index - 1];
    if (previous?.startMs === clip.startMs && previous.overlapKey !== clip.overlapKey)
      conflicts.add(clip.startMs);
  });
  return ordered.map((clip, index, clips) => {
    let following = index + 1;
    while (following < clips.length && clips[following].overlapKey === clip.overlapKey) following++;
    const next = clips[following];
    const duplicate = conflicts.has(clip.startMs);
    const slotMs = duplicate
      ? 0
      : Math.max(
          0,
          Math.min(
            MAX_VOICE_DURATION_MS + clip.startMs,
            clip.slotEndMs,
            next?.startMs ?? Infinity,
            project.media!.durationMs,
          ) - clip.startMs,
        );
    return {
      ...clip,
      slotMs,
      endMs:
        clip.startMs +
        (clip.exactDuration
          ? slotMs
          : Math.min(
              slotMs,
              project.voiceEdits?.[clip.generation.id]
                ? editDuration(project.voiceEdits[clip.generation.id])
                : clip.generation.durationMs,
            )),
      cacheKey: `${project.id}:${clip.generation.id}:${clip.startMs}:${slotMs}:${clip.exactDuration}:${JSON.stringify(project.voiceEdits?.[clip.generation.id] ?? null)}`,
    };
  });
}
export function mixReport(project: Project) {
  const family = speakerDubbingState(project);
  const clips = dubbingClips(project);
  const selected = new Set(clips.map((c) => c.line.id));
  const missing = project.dialogues.filter(
    (line) => family.enabled(line.id) && spokenText(project, line) && !selected.has(line.id),
  ).length;
  return {
    clips,
    missing,
    stale: clips.filter((c) => staleGeneration(project, c.line, c.generation)).length,
    adjusted: clips.filter(
      (c) =>
        c.slotMs > 0 &&
        (project.voiceEdits?.[c.generation.id]
          ? editDuration(project.voiceEdits[c.generation.id])
          : c.generation.durationMs) > c.slotMs,
    ).length,
    fast: clips.filter(
      (c) =>
        c.slotMs > 0 &&
        (project.voiceEdits?.[c.generation.id]
          ? editDuration(project.voiceEdits[c.generation.id])
          : c.generation.durationMs) /
          c.slotMs >
          1.5,
    ).length,
    conflicts: clips.filter((c) => c.slotMs === 0).length,
  };
}
