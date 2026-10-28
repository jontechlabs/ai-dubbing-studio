import type { Cue, Dialogue, Project } from './types';
import { formatTime, parseTime } from './time';

export function parseSrt(text: string): Cue[] {
  const normalized = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];
  return normalized.split(/\n[ \t]*\n+/).map((block) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = /^(\S+)\s*-->\s*(\S+)(?:\s+.*)?$/.exec(lines.shift() ?? '');
    if (!match) throw new Error('INVALID_SRT');
    const startMs = parseTime(match[1]);
    const endMs = parseTime(match[2]);
    if (endMs <= startMs) throw new Error('INVALID_CUE_RANGE');
    return { id: crypto.randomUUID(), startMs, endMs, text: lines.join('\n') };
  });
}
export function exportSrt(cues: Cue[]): string {
  return [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTime(cue.startMs, ',')} --> ${formatTime(cue.endMs, ',')}\n${cue.text}\n`,
    )
    .join('\n');
}
export function alignCues(source: Cue[], target: Cue[]): Dialogue[] {
  const consumed = new Set<string>();
  const dialogues = source.map((cue): Dialogue => {
    const matches = target.filter(
      (candidate) =>
        Math.abs(candidate.startMs - cue.startMs) <= 100 &&
        Math.abs(candidate.endMs - cue.endMs) <= 100,
    );
    const candidate = matches.length === 1 ? matches[0] : undefined;
    const reverseCount = candidate
      ? source.filter(
          (other) =>
            Math.abs(candidate.startMs - other.startMs) <= 100 &&
            Math.abs(candidate.endMs - other.endMs) <= 100,
        ).length
      : 0;
    const matched =
      candidate && reverseCount === 1 && !consumed.has(candidate.id) ? candidate : undefined;
    if (matched) consumed.add(matched.id);
    return makeDialogue(cue, matched, target.length > 0 && !matched);
  });
  target
    .filter((cue) => !consumed.has(cue.id))
    .forEach((cue) => {
      dialogues.push(makeDialogue(undefined, cue, source.length > 0));
    });
  return dialogues.sort((a, b) => a.startMs - b.startMs);
}
function makeDialogue(source?: Cue, target?: Cue, uncertain = false): Dialogue {
  const cue = source ?? target!;
  return {
    id: crypto.randomUUID(),
    startMs: cue.startMs,
    endMs: cue.endMs,
    sourceCueIds: source ? [source.id] : [],
    targetCueIds: target ? [target.id] : [],
    ttsText: null,
    characterId: null,
    status: 'ungenerated',
    warnings: uncertain ? ['alignment'] : [],
    selectedGenerationIds: {},
  };
}
export function reconcileDialogues(previous: Dialogue[], aligned: Dialogue[]): Dialogue[] {
  return aligned.map((line) => {
    const old = previous.find(
      (d) =>
        (line.sourceCueIds.length > 0 &&
          d.sourceCueIds.join('|') === line.sourceCueIds.join('|')) ||
        (line.targetCueIds.length > 0 && d.targetCueIds.join('|') === line.targetCueIds.join('|')),
    );
    return old
      ? {
          ...line,
          id: old.id,
          ttsText: old.ttsText,
          characterId: old.characterId,
          selectedGenerationIds: old.selectedGenerationIds,
          status: old.status === 'ungenerated' ? 'ungenerated' : 'review',
        }
      : line;
  });
}
export function dialogueText(
  project: Project,
  dialogue: Dialogue,
  role: 'source' | 'target',
): string {
  const cues = role === 'source' ? project.sourceCues : project.targetCues;
  const ids = role === 'source' ? dialogue.sourceCueIds : dialogue.targetCueIds;
  return ids.map((id) => cues.find((cue) => cue.id === id)?.text ?? '').join('\n');
}
export function editDialogue(
  project: Project,
  id: string,
  role: 'source' | 'target' | 'tts',
  text: string,
): Project {
  const next = structuredClone(project);
  const dialogue = next.dialogues.find((line) => line.id === id);
  if (!dialogue) return project;
  if (role === 'tts') {
    dialogue.ttsText = text || null;
    if (dialogue.status === 'validated' || dialogue.status === 'generated')
      dialogue.status = 'review';
    return next;
  }
  const cues = role === 'source' ? next.sourceCues : next.targetCues;
  const ids = role === 'source' ? dialogue.sourceCueIds : dialogue.targetCueIds;
  if (!ids.length) {
    const cue = { id: crypto.randomUUID(), startMs: dialogue.startMs, endMs: dialogue.endMs, text };
    cues.push(cue);
    ids.push(cue.id);
  } else {
    const cue = cues.find((item) => item.id === ids[0]);
    if (cue) cue.text = text;
  }
  if (dialogue.status === 'validated' || dialogue.status === 'generated')
    dialogue.status = 'review';
  return next;
}
