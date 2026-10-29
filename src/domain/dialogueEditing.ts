import type { Dialogue, Project } from './types';
export interface NewDialogueOptions {
  startMs: number;
  endMs: number;
  sourceText: string;
  targetText: string;
}
export function validateNewDialogueOptions(project: Project, options: NewDialogueOptions) {
  const { startMs, endMs, sourceText, targetText } = options;
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs - startMs < 100 ||
    endMs > Math.min(86_400_000, project.media?.durationMs ?? 86_400_000)
  )
    throw Error('INVALID_CUE_RANGE');
  if (
    typeof sourceText !== 'string' ||
    typeof targetText !== 'string' ||
    ![sourceText, targetText].some((s) => s.trim())
  )
    throw Error('DIALOGUE_TEXT_REQUIRED');
}
export function addDialogue(project: Project, options: NewDialogueOptions): Project {
  validateNewDialogueOptions(project, options);
  const { startMs, endMs, sourceText, targetText } = options;
  const next = structuredClone(project);
  const line: Dialogue = {
    id: crypto.randomUUID(),
    startMs,
    endMs,
    sourceCueIds: [],
    targetCueIds: [],
    ttsText: null,
    characterId: null,
    status: 'ungenerated',
    warnings: [],
    selectedGenerationIds: {},
  };
  for (const role of ['source', 'target'] as const) {
    const text = role === 'source' ? sourceText : targetText;
    if (!text.trim()) continue;
    const cue = { id: crypto.randomUUID(), startMs, endMs, text };
    (role === 'source' ? next.sourceCues : next.targetCues).push(cue);
    (role === 'source' ? line.sourceCueIds : line.targetCueIds).push(cue.id);
  }
  next.dialogues.push(line);
  for (const rows of [next.dialogues, next.sourceCues, next.targetCues])
    rows.sort((a, b) => a.startMs - b.startMs);
  return next;
}
// Exclusion preserves both SRTs, every take, edit, placement and source file.
// It is reversible from the excluded-lines view or the normal undo history.
export function setDialogueExclusion(project: Project, ids: string[], excluded = true): Project {
  const selected = new Set(ids),
    lines = new Map(project.dialogues.map((l) => [l.id, l]));
  if ([...selected].some((id) => !lines.has(id))) throw Error('NO_DIALOGUES');
  if (
    !selected.size ||
    [...selected].every((id) => !!lines.get(id)!.excludedFromDubbing === excluded)
  )
    return project;
  const next = structuredClone(project);
  next.formatVersion = Math.max(24, next.formatVersion);
  for (const line of next.dialogues)
    if (selected.has(line.id)) {
      if (excluded) line.excludedFromDubbing = true;
      else delete line.excludedFromDubbing;
      delete next.translationApprovals?.[line.id];
      if (line.status === 'validated') line.status = 'review';
    }
  return next;
}
