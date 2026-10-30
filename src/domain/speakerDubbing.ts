import type { Dialogue, Project } from './types';

export interface IsolatedVoice {
  lineId: string;
  outputId: string;
  label: string;
  audioPath: string;
  sourceText: string;
  translations: Record<string, string>;
}
export interface SpeakerDubbingGroup {
  id: string;
  parentId: string;
  separationId: string;
  modelId: string;
  sourcePath: string;
  sourceTrackId: string;
  startMs: number;
  endMs: number;
  createdAt: string;
  active: boolean;
  voices: IsolatedVoice[];
}
export interface SpeakerSeparationOptions {
  lineId: string;
  modelId: string;
  sourceTrackId: string;
  device: string;
  windowSeconds: number;
  startMs: number;
  endMs: number;
  prompt: string;
}
export interface SpeakerSeparationDestination {
  outputId: string;
  trackId: string | null;
  role: 'speech' | 'music' | 'sfx' | null;
  mode: 'replace' | 'add';
}
export interface SpeakerDubbingAssignment {
  outputId: string;
  label: string;
  characterId: string | null;
  sourceText: string;
  targetText: string;
}
export interface SpeakerSeparationResult {
  id: string;
  options: SpeakerSeparationOptions;
  outputs: string[];
  stale: boolean;
  applied: boolean;
  commonGain: number;
  deviceName: string;
}
export function isolatedVoice(project: Project, lineId: string) {
  for (const group of project.speakerDubbings ?? []) {
    const voice = group.voices.find((v) => v.lineId === lineId);
    if (voice) return { group, voice };
  }
}
/** Only explicitly related voices may overlap. Inactive variants remain saved. */
export function speakerDubbingState(project: Project) {
  const child = new Map<
    string,
    { group: SpeakerDubbingGroup; voice: IsolatedVoice; lane: number }
  >();
  const parents = new Set<string>();
  const excluded = new Set(project.dialogues.filter((l) => l.excludedFromDubbing).map((l) => l.id));
  for (const group of project.speakerDubbings ?? []) {
    if (group.active && group.sourcePath === project.media?.path) parents.add(group.parentId);
    group.voices.forEach((voice, lane) => child.set(voice.lineId, { group, voice, lane }));
  }
  const enabled = (lineId: string) => {
    if (excluded.has(lineId) || parents.has(lineId)) return false;
    const item = child.get(lineId);
    return (
      !item ||
      (item.group.active &&
        item.group.sourcePath === project.media?.path &&
        !excluded.has(item.group.parentId))
    );
  };
  return { child, parents, enabled, key: (id: string) => child.get(id)?.group.id ?? id };
}
export function setSpeakerDubbingGroup(project: Project, parentId: string, groupId: string | null) {
  const next = structuredClone(project);
  if (groupId && !next.speakerDubbings?.some((g) => g.id === groupId && g.parentId === parentId))
    throw Error('SPEAKER_SEPARATION_OPTIONS');
  for (const g of next.speakerDubbings ?? [])
    if (g.parentId === parentId) g.active = g.id === groupId;
  return next;
}
export function validateSpeakerDubbings(p: Project) {
  if (!p.speakerDubbings?.length) return;
  const groups = p.speakerDubbings;
  const lines = new Map(p.dialogues.map((l) => [l.id, l]));
  const groupIds = new Set<string>(),
    childIds = new Set<string>(),
    activeParents = new Set<string>();
  const parents = new Set(groups.map((g) => g.parentId));
  const text = (s: unknown, max: number) =>
    typeof s === 'string' && s.length <= max && !s.includes('\0');
  if (p.formatVersion < 25 || groups.length > 4096) throw Error('SPEAKER_SEPARATION_OPTIONS');
  for (const g of groups) {
    const parent = lines.get(g.parentId);
    if (
      !parent ||
      groupIds.has(g.id) ||
      !g.id ||
      !text(g.id, 128) ||
      typeof g.active !== 'boolean' ||
      !text(g.separationId, 128) ||
      !['mossformer2-16k', 'sepformer-2mix', 'sepformer-3mix'].includes(g.modelId) ||
      !text(g.sourcePath, 4096) ||
      !text(g.sourceTrackId, 128) ||
      !text(g.createdAt, 100) ||
      !Number.isSafeInteger(g.startMs) ||
      !Number.isSafeInteger(g.endMs) ||
      g.startMs < 0 ||
      g.endMs - g.startMs < 100 ||
      g.endMs - g.startMs > 60000 ||
      !Array.isArray(g.voices) ||
      g.voices.length < 1 ||
      g.voices.length > 3 ||
      (g.active && activeParents.has(g.parentId))
    )
      throw Error('SPEAKER_SEPARATION_OPTIONS');
    groupIds.add(g.id);
    if (g.active) activeParents.add(g.parentId);
    const outputs = new Set<string>();
    for (const v of g.voices) {
      const line = lines.get(v.lineId);
      if (
        !line ||
        parents.has(v.lineId) ||
        childIds.has(v.lineId) ||
        outputs.has(v.outputId) ||
        !/^voice-[123]$/.test(v.outputId) ||
        !/^stems\/isolated-[0-9a-f-]{36}\.wav$/.test(v.audioPath) ||
        line.sourceCueIds.length ||
        line.targetCueIds.length ||
        line.startMs < g.startMs ||
        line.endMs > g.endMs ||
        !text(v.label, 200) ||
        !text(v.sourceText, 20000) ||
        !v.translations ||
        Object.entries(v.translations).some(
          ([k, s]) => !/^[a-zA-Z-]{2,16}$/.test(k) || !text(s, 20000),
        )
      )
        throw Error('SPEAKER_SEPARATION_OPTIONS');
      outputs.add(v.outputId);
      childIds.add(v.lineId);
    }
  }
}
export function speakerLabel(project: Project, line: Dialogue) {
  return isolatedVoice(project, line.id)?.voice.label;
}
export function retainSpeakerDialogues(previous: Project, next: Project) {
  const retained = new Set(
    (previous.speakerDubbings ?? []).flatMap((g) => [g.parentId, ...g.voices.map((v) => v.lineId)]),
  );
  for (const old of previous.dialogues) {
    if (retained.has(old.id) && !next.dialogues.some((l) => l.id === old.id)) {
      next.dialogues.push({
        ...structuredClone(old),
        sourceCueIds: old.sourceCueIds.filter((id) => next.sourceCues.some((c) => c.id === id)),
        targetCueIds: old.targetCueIds.filter((id) => next.targetCues.some((c) => c.id === id)),
      });
    }
  }
}
