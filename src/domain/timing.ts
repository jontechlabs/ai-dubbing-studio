import type { Cue, Dialogue, Project } from './types';
import { dialogueText } from './subtitles';

export type SubtitleRole = 'source' | 'target';
export type TimingRole = SubtitleRole | 'both';
const key = (role: SubtitleRole) => (role === 'source' ? 'sourceCues' : 'targetCues');
const refs = (line: Dialogue, role: SubtitleRole) =>
  role === 'source' ? line.sourceCueIds : line.targetCueIds;

export function cueBounds(cues: Cue[]) {
  return {
    startMs: Math.min(...cues.map((c) => c.startMs)),
    endMs: Math.max(...cues.map((c) => c.endMs)),
  };
}
function range(start: number, end: number) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end - start < 100)
    throw new Error('INVALID_CUE_RANGE');
}
export function reviewLine(line: Dialogue, warning = 'timing'): Dialogue {
  return {
    ...line,
    status: line.status === 'ungenerated' ? 'ungenerated' : 'review',
    warnings: [...new Set([...line.warnings, warning])],
  };
}
export function refreshBounds(project: Project, line: Dialogue): Dialogue {
  const source = project.sourceCues.filter((cue) => line.sourceCueIds.includes(cue.id));
  const target = project.targetCues.filter((cue) => line.targetCueIds.includes(cue.id));
  const bounds = cueBounds([...source, ...target]);
  return Number.isFinite(bounds.startMs) ? { ...line, ...bounds } : line;
}
export function moveCue(
  project: Project,
  role: SubtitleRole,
  id: string,
  startMs: number,
  endMs: number,
): Project {
  range(startMs, endMs);
  const next = structuredClone(project);
  const cue = next[key(role)].find((c) => c.id === id);
  if (!cue) throw new Error('INVALID_PROJECT');
  Object.assign(cue, { startMs, endMs });
  next.dialogues = next.dialogues.map((line) =>
    refs(line, role).includes(id) ? reviewLine(refreshBounds(next, line)) : line,
  );
  return next;
}
export function retimeDialogue(
  project: Project,
  id: string,
  startMs: number,
  endMs: number,
  role: TimingRole,
): Project {
  range(startMs, endMs);
  const next = structuredClone(project);
  const line = next.dialogues.find((d) => d.id === id);
  if (!line) throw new Error('INVALID_PROJECT');
  for (const side of ['source', 'target'] as const) {
    if (role !== 'both' && role !== side) continue;
    const cues = next[key(side)].filter((cue) => refs(line, side).includes(cue.id));
    if (!cues.length) continue;
    const old = cueBounds(cues);
    const scale = (endMs - startMs) / (old.endMs - old.startMs);
    for (const cue of cues) {
      const start = Math.round(startMs + (cue.startMs - old.startMs) * scale);
      const end = Math.round(startMs + (cue.endMs - old.startMs) * scale);
      if (end <= start) throw new Error('INVALID_CUE_RANGE');
      Object.assign(cue, { startMs: start, endMs: end });
    }
  }
  next.dialogues = next.dialogues.map((d) =>
    d.id === id ? reviewLine(refreshBounds(next, d)) : d,
  );
  return next;
}
export function editCueText(
  project: Project,
  role: SubtitleRole,
  id: string,
  text: string,
): Project {
  const next = structuredClone(project);
  const cue = next[key(role)].find((c) => c.id === id);
  if (!cue) return project;
  cue.text = text;
  next.dialogues = next.dialogues.map((line) =>
    refs(line, role).includes(id) && ['generated', 'validated'].includes(line.status)
      ? { ...line, status: 'review' }
      : line,
  );
  return next;
}
function splitText(text: string, fraction: number): [string, string] {
  const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(
    (part) => part.segment,
  );
  if (parts.length < 2) return [text, ''];
  let index = Math.max(1, Math.min(parts.length - 1, Math.round(parts.length * fraction)));
  const boundaries = parts
    .map((part, i) => (/\s/.test(part) ? i : -1))
    .filter((i) => i > 0 && Math.abs(i - index) <= 8);
  if (boundaries.length)
    index = boundaries.sort((a, b) => Math.abs(a - index) - Math.abs(b - index))[0];
  return [parts.slice(0, index).join('').trim(), parts.slice(index).join('').trim()];
}
export function splitDialogue(project: Project, id: string, atMs: number): Project {
  const next = structuredClone(project);
  const index = next.dialogues.findIndex((d) => d.id === id);
  const line = next.dialogues[index];
  if (!line || atMs < line.startMs + 100 || atMs > line.endMs - 100)
    throw new Error('INVALID_SPLIT');
  const first: Dialogue = {
    ...structuredClone(line),
    endMs: atMs,
    sourceCueIds: [],
    targetCueIds: [],
    selectedGenerationIds: {},
    warnings: [...new Set([...line.warnings, 'split'])],
    status: 'review',
  };
  const second: Dialogue = {
    ...structuredClone(first),
    id: crypto.randomUUID(),
    startMs: atMs,
    endMs: line.endMs,
    sourceCueIds: [],
    targetCueIds: [],
  };
  for (const role of ['source', 'target'] as const) {
    const cues = next[key(role)];
    for (const cue of cues.filter((c) => refs(line, role).includes(c.id))) {
      if (cue.endMs <= atMs) refs(first, role).push(cue.id);
      else if (cue.startMs >= atMs) refs(second, role).push(cue.id);
      else {
        const [left, right] = splitText(cue.text, (atMs - cue.startMs) / (cue.endMs - cue.startMs));
        const after = { ...cue, id: crypto.randomUUID(), startMs: atMs, text: right };
        cue.endMs = atMs;
        cue.text = left;
        cues.push(after);
        refs(first, role).push(cue.id);
        refs(second, role).push(after.id);
      }
    }
  }
  if (line.ttsText !== null)
    [first.ttsText, second.ttsText] = splitText(
      line.ttsText,
      (atMs - line.startMs) / (line.endMs - line.startMs),
    );
  next.dialogues.splice(index, 1, first, second);
  return next;
}
export function mergeDialogue(project: Project, id: string): Project {
  const next = structuredClone(project);
  const ordered = [...next.dialogues].sort((a, b) => a.startMs - b.startMs);
  const index = ordered.findIndex((d) => d.id === id);
  const first = ordered[index],
    second = ordered[index + 1];
  if (!first || !second) throw new Error('NO_NEXT_DIALOGUE');
  const merged: Dialogue = {
    ...first,
    startMs: Math.min(first.startMs, second.startMs),
    endMs: Math.max(first.endMs, second.endMs),
    sourceCueIds: [...new Set([...first.sourceCueIds, ...second.sourceCueIds])],
    targetCueIds: [...new Set([...first.targetCueIds, ...second.targetCueIds])],
    ttsText:
      first.ttsText !== null || second.ttsText !== null
        ? [
            first.ttsText ?? dialogueText(project, first, 'target'),
            second.ttsText ?? dialogueText(project, second, 'target'),
          ]
            .filter(Boolean)
            .join('\n')
        : null,
    characterId: first.characterId === second.characterId ? first.characterId : null,
    selectedGenerationIds: {},
    status: 'review',
    warnings: [...new Set([...first.warnings, ...second.warnings, 'merge'])],
  };
  for (const role of ['source', 'target'] as const) {
    const ids = refs(merged, role);
    const cues = next[key(role)]
      .filter((cue) => ids.includes(cue.id))
      .sort((a, b) => a.startMs - b.startMs);
    if (!cues.length) continue;
    const firstCue = {
      ...cues[0],
      ...cueBounds(cues),
      text: cues.map((cue) => cue.text).join('\n'),
    };
    next[key(role)] = [...next[key(role)].filter((cue) => !ids.includes(cue.id)), firstCue].sort(
      (a, b) => a.startMs - b.startMs,
    );
    if (role === 'source') merged.sourceCueIds = [firstCue.id];
    else merged.targetCueIds = [firstCue.id];
  }
  next.dialogues = next.dialogues
    .filter((line) => line.id !== second.id)
    .map((line) => (line.id === id ? merged : line));
  return next;
}
