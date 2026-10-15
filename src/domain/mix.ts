import type { Project } from './types';
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
export function resizeDubbing(
  project: Project,
  lineId: string,
  durationMs: number | null,
): Project {
  if (
    durationMs !== null &&
    (!Number.isFinite(durationMs) || durationMs < 1 || durationMs > 120000)
  )
    throw Error('INVALID_PROJECT');
  const next = moveDubbing(project, lineId, dubbingOffset(project, lineId));
  const durations = (next.dubbingTiming!.durationsMs ??= {});
  const values = (durations[lineId] ??= {});
  if (durationMs === null) delete values[next.languages.target];
  else values[next.languages.target] = Math.round(durationMs);
  return next;
}
export function moveDubbing(project: Project, lineId: string, offsetMs: number): Project {
  const line = project.dialogues.find((line) => line.id === lineId);
  if (!line || !project.media || !Number.isFinite(offsetMs)) throw Error('INVALID_PROJECT');
  const offset = Math.max(
    -86_400_000,
    -line.startMs,
    Math.min(86_400_000, project.media.durationMs - 1 - line.startMs, Math.round(offsetMs)),
  );
  const next = structuredClone(project);
  next.formatVersion = Math.max(7, next.formatVersion);
  if (next.dubbingTiming?.sourcePath !== next.media!.path)
    next.dubbingTiming = { sourcePath: next.media!.path, offsetsMs: {} };
  const offsets = next.dubbingTiming!.offsetsMs;
  offsets[lineId] = { ...offsets[lineId], [next.languages.target]: offset };
  return next;
}
export function dubbingClips(project: Project) {
  const generations = new Map(voiceGenerations(project).map((g) => [g.id, g]));
  return project.dialogues
    .flatMap((line) => {
      const generation = generations.get(line.selectedGenerationIds[project.languages.target]);
      if (
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
      const durationMs = dubbingDuration(project, line.id);
      return [
        {
          line,
          generation,
          startMs,
          exactDuration: durationMs !== undefined,
          slotEndMs: Math.min(
            project.media!.durationMs,
            startMs + (durationMs ?? line.endMs - line.startMs),
          ),
          endMs: Math.min(project.media!.durationMs, startMs + generation.durationMs),
        },
      ];
    })
    .sort((a, b) => a.startMs - b.startMs)
    .map((clip, index, clips) => {
      const next = clips[index + 1];
      const duplicate = clips[index - 1]?.startMs === clip.startMs;
      const slotMs = duplicate
        ? 0
        : Math.max(
            0,
            Math.min(clip.slotEndMs, next?.startMs ?? Infinity, project.media!.durationMs) -
              clip.startMs,
          );
      return {
        ...clip,
        slotMs,
        endMs:
          clip.startMs +
          (clip.exactDuration ? slotMs : Math.min(slotMs, clip.generation.durationMs)),
        cacheKey: `${project.id}:${clip.generation.id}:${clip.startMs}:${slotMs}:${clip.exactDuration}`,
      };
    });
}
export function mixReport(project: Project) {
  const clips = dubbingClips(project);
  const selected = new Set(clips.map((c) => c.line.id));
  const missing = project.dialogues.filter(
    (line) => spokenText(project, line) && !selected.has(line.id),
  ).length;
  return {
    clips,
    missing,
    stale: clips.filter((c) => staleGeneration(project, c.line, c.generation)).length,
    adjusted: clips.filter((c) => c.slotMs > 0 && c.generation.durationMs > c.slotMs).length,
    fast: clips.filter((c) => c.slotMs > 0 && c.generation.durationMs / c.slotMs > 1.5).length,
    conflicts: clips.filter((c) => c.slotMs === 0).length,
  };
}
