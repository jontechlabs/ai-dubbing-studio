import type { Project } from './types';
export interface SourceTranscriptionOptions {
  lineId: string;
  language: string;
  trackId?: string | null;
}
export interface SourceTranscriptSlot {
  cueId: string | null;
  startMs: number;
  endMs: number;
  text: string;
}
export interface SourceTranscriptBasis {
  projectId: string;
  lineId: string;
  sourceLanguage: string;
  sourcePath: string;
  startMs: number;
  endMs: number;
  slots: SourceTranscriptSlot[];
}
export interface SourceTranscriptionProposal {
  id: string;
  basis: SourceTranscriptBasis;
  segments: { text: string; noSpeech: boolean }[];
  trackId: string;
  language: string;
  stale: boolean;
  model: string;
}
export function sourceProposalCurrent(project: Project, p: SourceTranscriptionProposal): boolean {
  const b = p.basis,
    l = project.dialogues.find((l) => l.id === b.lineId);
  if (
    !l ||
    p.stale ||
    project.id !== b.projectId ||
    project.languages.source !== b.sourceLanguage ||
    project.media?.path !== b.sourcePath ||
    l.startMs !== b.startMs ||
    l.endMs !== b.endMs
  )
    return false;
  if (!l.sourceCueIds.length) return b.slots.length === 1 && b.slots[0].cueId === null;
  return (
    l.sourceCueIds.length === b.slots.length &&
    b.slots.every((s, i) => {
      const c = project.sourceCues.find((c) => c.id === l.sourceCueIds[i]);
      return (
        c && c.id === s.cueId && c.startMs === s.startMs && c.endMs === s.endMs && c.text === s.text
      );
    })
  );
}
