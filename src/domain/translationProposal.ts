import type { Project } from './types';
import { dialogueText, editDialogue } from './subtitles';
import { editCueText } from './timing';

export interface TranslationBasis {
  projectId: string;
  lineId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceText: string;
  targetText: string;
  sourceCueIds: string[];
  targetCueIds: string[];
}
export interface TranslationProposal {
  basis: TranslationBasis;
  translations: string[];
  model: string;
}
export function proposalCurrent(project: Project, proposal: TranslationProposal): boolean {
  const b = proposal.basis,
    line = project.dialogues.find((l) => l.id === b.lineId);
  return (
    !!line &&
    project.id === b.projectId &&
    project.languages.source === b.sourceLanguage &&
    project.languages.target === b.targetLanguage &&
    dialogueText(project, line, 'source') === b.sourceText &&
    dialogueText(project, line, 'target') === b.targetText &&
    JSON.stringify(line.sourceCueIds) === JSON.stringify(b.sourceCueIds) &&
    JSON.stringify(line.targetCueIds) === JSON.stringify(b.targetCueIds)
  );
}
export function applyTranslationProposal(project: Project, proposal: TranslationProposal): Project {
  if (!proposalCurrent(project, proposal)) throw Error('TRANSLATION_STALE');
  const { translations, basis } = proposal;
  if (
    translations.length !== Math.max(1, basis.targetCueIds.length) ||
    translations.some((text) => !text.trim() || text.length > 8000 || text.includes('\0'))
  )
    throw Error('TRANSLATION_OUTPUT_INVALID');
  let next = project;
  if (!basis.targetCueIds.length)
    next = editDialogue(next, basis.lineId, 'target', translations[0].trim());
  else
    for (const [i, id] of basis.targetCueIds.entries())
      next = editCueText(next, 'target', id, translations[i].trim());
  if (next.translationApprovals) delete next.translationApprovals[basis.lineId];
  return next;
}
