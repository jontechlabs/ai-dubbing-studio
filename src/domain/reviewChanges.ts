import type { Dialogue, Project } from './types';
import { jointReviewSnapshot } from './jointReview';
import { activeSpeakerGroup } from './speakerDubbing';
import { selectedGeneration, spokenText, staleGeneration } from './tts';
export function reviewLines(project: Project, line: Dialogue): Dialogue[] {
  const group = activeSpeakerGroup(project, line);
  return group
    ? group.voices.flatMap((v) => {
        const child = project.dialogues.find((l) => l.id === v.lineId && !l.excludedFromDubbing);
        return child ? [child] : [];
      })
    : [line];
}
export function changedReviewTakes(project: Project, line: Dialogue) {
  return reviewLines(project, line).flatMap((l) => {
    const take = selectedGeneration(project, l);
    if (!take || !staleGeneration(project, l, take)) return [];
    const reasons: string[] = [];
    if (take.text !== spokenText(project, l)) reasons.push('text');
    if (take.startMs !== l.startMs || take.endMs !== l.endMs) reasons.push('timing');
    if (take.characterId !== l.characterId) reasons.push('character');
    if (take.sourcePath !== (project.media?.path ?? null)) reasons.push('source');
    if (take.language !== project.languages.target) reasons.push('language');
    if (!reasons.length) reasons.push('reference');
    return [
      { id: take.id, reasons, generatedText: take.text, currentText: spokenText(project, l) },
    ];
  });
}
// Confirmation must never authorize a different take, project, group, text or mix.
export function reviewDecisionSnapshot(project: Project | null, id: string) {
  const line = project?.dialogues.find((l) => l.id === id);
  if (!project || !line) return null;
  return {
    projectId: project.id,
    languages: { ...project.languages },
    excluded: !!line.excludedFromDubbing,
    lines: reviewLines(project, line).map((l) => ({
      id: l.id,
      excluded: !!l.excludedFromDubbing,
      joint: jointReviewSnapshot(project, l),
    })),
  };
}
