import type { Dialogue, Project } from './types';
import { dialogueText } from './subtitles';

export interface TranslationApproval {
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
export function translationState(project: Project, line: Dialogue) {
  if (!hasTranslation(project, line)) return 'untranslated';
  const approval = project.translationApprovals?.[line.id];
  const current = snapshot(project, line);
  return matches(approval, current) ? 'approved' : 'translated';
}
export function cleanTranslationApprovals(project: Project): Project {
  if (!project.translationApprovals) return project;
  const lines = new Map(project.dialogues.map((line) => [line.id, line]));
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
      return !!current.targetText.replace(/<[^>]*>/g, '').trim() && matches(approval, current);
    }),
  );
  return project;
}
export function approveTranslation(project: Project, id: string, approved: boolean): Project {
  const next = structuredClone(project),
    line = next.dialogues.find((line) => line.id === id);
  if (!line || !hasTranslation(next, line)) throw Error('TRANSLATION_REQUIRED');
  next.translationApprovals ??= {};
  if (approved) {
    next.formatVersion = Math.max(10, next.formatVersion);
    next.translationApprovals[id] = snapshot(next, line);
  } else delete next.translationApprovals[id];
  return next;
}

// Index subtitles once and commit the entire selection as a single project edit.
// Empty translations are skipped; an unknown dialogue rejects the whole edit.
export function approveTranslations(project: Project, ids: string[], approved: boolean): Project {
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
    const current = snapshot(
      project,
      line,
      line.sourceCueIds.map((id) => source.get(id) ?? '').join('\n'),
      line.targetCueIds.map((id) => target.get(id) ?? '').join('\n'),
    );
    if (
      current.targetText.replace(/<[^>]*>/g, '').trim() &&
      !matches(project.translationApprovals?.[id], current)
    )
      changes.set(id, current);
  }
  if (!changes.size) return project;
  const next = structuredClone(project);
  next.translationApprovals ??= {};
  for (const [id, approval] of changes) {
    if (approval) next.translationApprovals[id] = approval;
    else delete next.translationApprovals[id];
  }
  if (approved) next.formatVersion = Math.max(10, next.formatVersion);
  return next;
}

export type TranslationState = 'untranslated' | 'translated' | 'approved';
export function translationStates(project: Project): Map<string, TranslationState> {
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
        : matches(project.translationApprovals?.[line.id], current)
          ? 'approved'
          : 'translated';
      return [line.id, state];
    }),
  );
}
