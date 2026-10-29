import type { Dialogue, Project } from './types';
import { dialogueText } from './subtitles';
import { selectedGeneration, staleGeneration } from './tts';
import {
  jointReviewSnapshot,
  sameReview,
  reviewIndex,
  indexedTake,
  type JointReviewSnapshot,
} from './jointReview';

export interface TranslationApproval {
  joint?: JointReviewSnapshot;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
}
export function hasTranslation(project: Project, line: Dialogue): boolean {
  return !!dialogueText(project, line, 'target')
    .replace(/<[^>]*>/g, '')
    .trim();
}
function snapshot(
  project: Project,
  line: Dialogue,
  sourceText = dialogueText(project, line, 'source'),
  targetText = dialogueText(project, line, 'target'),
): TranslationApproval {
  return {
    sourceLanguage: project.languages.source,
    targetLanguage: project.languages.target,
    sourceText,
    targetText,
  };
}
function matches(approval: TranslationApproval | undefined, current: TranslationApproval): boolean {
  return (
    !!approval &&
    Object.keys(current).every(
      (key) =>
        approval[key as keyof TranslationApproval] === current[key as keyof TranslationApproval],
    )
  );
}
function matchesReview(
  project: Project,
  line: Dialogue,
  approval: TranslationApproval | undefined,
  current: TranslationApproval,
  index?: ReturnType<typeof reviewIndex>,
) {
  if (line.excludedFromDubbing) return false;
  if (!matches(approval, current)) return false;
  const take = index ? indexedTake(project, line, index) : selectedGeneration(project, line);
  if (take && (line.status !== 'validated' || staleGeneration(project, line, take))) return false;
  return (
    !approval!.joint ||
    sameReview(approval!.joint, jointReviewSnapshot(project, line, take ?? null, index))
  );
}
export function translationState(project: Project, line: Dialogue) {
  if (!hasTranslation(project, line)) return 'untranslated';
  const approval = project.translationApprovals?.[line.id];
  const current = snapshot(project, line);
  return matchesReview(project, line, approval, current) ? 'approved' : 'translated';
}
export function cleanTranslationApprovals(project: Project): Project {
  if (!project.translationApprovals) {
    for (const line of project.dialogues) if (line.status === 'validated') line.status = 'review';
    return project;
  }
  const lines = new Map(project.dialogues.map((line) => [line.id, line]));
  const index = reviewIndex(project);
  const source = new Map(project.sourceCues.map((cue) => [cue.id, cue.text]));
  const target = new Map(project.targetCues.map((cue) => [cue.id, cue.text]));
  project.translationApprovals = Object.fromEntries(
    Object.entries(project.translationApprovals).filter(([id, approval]) => {
      const line = lines.get(id);
      if (!line) return false;
      const current = snapshot(
        project,
        line,
        line.sourceCueIds.map((id) => source.get(id) ?? '').join('\n'),
        line.targetCueIds.map((id) => target.get(id) ?? '').join('\n'),
      );
      const valid =
        !!current.targetText.replace(/<[^>]*>/g, '').trim() &&
        matchesReview(project, line, approval, current, index);
      if (valid && !approval.joint) {
        approval.joint = jointReviewSnapshot(
          project,
          line,
          indexedTake(project, line, index),
          index,
        );
        project.formatVersion = Math.max(24, project.formatVersion);
      }
      if (!valid && line.status === 'validated') line.status = 'review';
      return valid;
    }),
  );
  for (const line of project.dialogues)
    if (line.status === 'validated' && !project.translationApprovals[line.id])
      line.status = 'review';
  return project;
}
export function approveTranslation(project: Project, id: string, approved: boolean): Project {
  const next = structuredClone(project),
    line = next.dialogues.find((line) => line.id === id);
  if (!line || !hasTranslation(next, line)) throw Error('TRANSLATION_REQUIRED');
  if (line.excludedFromDubbing) throw Error('DIALOGUE_EXCLUDED');
  const take = selectedGeneration(next, line);
  if (approved && take && staleGeneration(next, line, take)) throw Error('TTS_STALE_GENERATION');
  next.translationApprovals ??= {};
  if (approved) {
    next.formatVersion = Math.max(24, next.formatVersion);
    next.translationApprovals[id] = {
      ...snapshot(next, line),
      joint: jointReviewSnapshot(next, line),
    };
  } else delete next.translationApprovals[id];
  if (approved && take) line.status = staleGeneration(next, line, take) ? 'review' : 'validated';
  else if (!approved && line.status === 'validated') line.status = 'review';
  return next;
}

// Index subtitles once and commit the entire selection as a single project edit.
// Empty translations are skipped; an unknown dialogue rejects the whole edit.
export function approveTranslations(project: Project, ids: string[], approved: boolean): Project {
  const index = reviewIndex(project);
  const lines = new Map(project.dialogues.map((line) => [line.id, line]));
  const selected = new Set(ids);
  if ([...selected].some((id) => !lines.has(id))) throw Error('NO_DIALOGUES');
  const source = new Map(project.sourceCues.map((cue) => [cue.id, cue.text]));
  const target = new Map(project.targetCues.map((cue) => [cue.id, cue.text]));
  const changes = new Map<string, TranslationApproval | null>();
  for (const id of selected) {
    if (!approved) {
      if (project.translationApprovals?.[id]) changes.set(id, null);
      continue;
    }
    const line = lines.get(id)!;
    if (line.excludedFromDubbing) continue;
    const take = indexedTake(project, line, index);
    const current = snapshot(
      project,
      line,
      line.sourceCueIds.map((id) => source.get(id) ?? '').join('\n'),
      line.targetCueIds.map((id) => target.get(id) ?? '').join('\n'),
    );
    if (
      current.targetText.replace(/<[^>]*>/g, '').trim() &&
      !(take && staleGeneration(project, line, take)) &&
      !matchesReview(project, line, project.translationApprovals?.[id], current, index)
    )
      changes.set(id, { ...current, joint: jointReviewSnapshot(project, line, take, index) });
  }
  const voiceChanges = [...selected].some((id) => {
    const l = lines.get(id)!;
    const g = indexedTake(project, l, index);
    return approved
      ? !l.excludedFromDubbing &&
          !!g &&
          hasTranslation(project, l) &&
          !staleGeneration(project, l, g) &&
          l.status !== 'validated'
      : l.status === 'validated';
  });
  if (!changes.size && !voiceChanges) return project;
  const next = structuredClone(project);
  next.translationApprovals ??= {};
  for (const [id, approval] of changes) {
    if (approval) next.translationApprovals[id] = approval;
    else delete next.translationApprovals[id];
  }
  for (const id of selected) {
    const l = next.dialogues.find((l) => l.id === id)!;
    const g = selectedGeneration(next, l);
    if (approved && !l.excludedFromDubbing && g && hasTranslation(next, l))
      l.status = staleGeneration(next, l, g) ? 'review' : 'validated';
    else if (!approved && l.status === 'validated') l.status = 'review';
  }
  if (approved) next.formatVersion = Math.max(24, next.formatVersion);
  return next;
}

export type TranslationState = 'untranslated' | 'translated' | 'approved';
export function translationStates(project: Project): Map<string, TranslationState> {
  const index = reviewIndex(project);
  const source = new Map(project.sourceCues.map((cue) => [cue.id, cue.text]));
  const target = new Map(project.targetCues.map((cue) => [cue.id, cue.text]));
  return new Map(
    project.dialogues.map((line) => {
      const current = snapshot(
        project,
        line,
        line.sourceCueIds.map((id) => source.get(id) ?? '').join('\n'),
        line.targetCueIds.map((id) => target.get(id) ?? '').join('\n'),
      );
      const state: TranslationState = !current.targetText.replace(/<[^>]*>/g, '').trim()
        ? 'untranslated'
        : matchesReview(project, line, project.translationApprovals?.[line.id], current, index)
          ? 'approved'
          : 'translated';
      return [line.id, state];
    }),
  );
}
