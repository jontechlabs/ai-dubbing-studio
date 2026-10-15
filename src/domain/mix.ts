import type { Project } from './types';
import { voiceGenerations, staleGeneration, spokenText } from './tts';
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
      return [
        {
          line,
          generation,
          startMs: line.startMs,
          endMs: Math.min(project.media!.durationMs, line.startMs + generation.durationMs),
        },
      ];
    })
    .sort((a, b) => a.startMs - b.startMs);
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
    long: clips.filter((c) => c.generation.durationMs > c.line.endMs - c.line.startMs).length,
  };
}
