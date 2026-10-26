import type { Character, Project } from './types';
import { sameSnapshot, speakerAudioSnapshot } from './characterReview';
const colors = ['#a48bd4', '#82bda0', '#dc9b72', '#79a9cf', '#d18db2', '#c3bd73'];
export function addCharacter(project: Project, name: string): Project {
  const value = name.trim();
  if (!value) throw new Error('INVALID_CHARACTER');
  const next = structuredClone(project);
  next.formatVersion = Math.max(next.formatVersion, 3);
  next.characters.push({
    id: crypto.randomUUID(),
    name: value,
    color: colors[next.characters.length % colors.length],
    references: [],
    defaultReferenceId: null,
  });
  return next;
}
export function editCharacter(
  project: Project,
  id: string,
  change: Partial<Pick<Character, 'name' | 'color' | 'defaultReferenceId' | 'references'>>,
): Project {
  const next = structuredClone(project);
  const character = next.characters.find((item) => item.id === id);
  if (!character) throw new Error('INVALID_CHARACTER');
  if (change.name !== undefined && !change.name.trim()) throw new Error('INVALID_CHARACTER');
  Object.assign(character, change);
  if (change.name !== undefined && next.characterProfiles?.[id])
    next.characterProfiles[id].temporaryName = false;
  return next;
}
export function deleteCharacter(project: Project, id: string): Project {
  const next = structuredClone(project);
  next.characters = next.characters.filter((item) => item.id !== id);
  delete next.characterProfiles?.[id];
  if (
    next.speakerAnalysis?.scope?.referenceCharacterId === id ||
    next.speakerAnalysis?.clusters.some((c) => c.characterId === id)
  )
    next.speakerAnalysis = null;
  next.dialogues.forEach((line) => {
    if (line.characterId === id) line.characterId = null;
  });
  return next;
}
export function assignCharacter(
  project: Project,
  ids: string[],
  characterId: string | null,
): Project {
  if (characterId && !project.characters.some((item) => item.id === characterId))
    throw new Error('INVALID_CHARACTER');
  const next = structuredClone(project),
    selected = new Set(ids);
  next.dialogues.forEach((line) => {
    if (selected.has(line.id)) line.characterId = characterId;
  });
  return next;
}
export function analysisCurrent(project: Project): boolean {
  const analysis = project.speakerAnalysis;
  if (!analysis || analysis.sourcePath !== project.media?.path) return false;
  const lines = new Map(project.dialogues.map((line) => [line.id, line]));
  const scope = analysis.scope;
  const expected =
    scope?.startMs !== undefined && scope.endMs !== undefined
      ? project.dialogues.filter((l) => l.startMs < scope.endMs! && l.endMs > scope.startMs!)
      : project.dialogues;
  if (
    analysis.audioSnapshot &&
    !sameSnapshot(
      analysis.audioSnapshot,
      speakerAudioSnapshot(project, scope?.referenceCharacterId),
    )
  )
    return false;
  if (
    scope?.replaceAssigned &&
    analysis.originalAssignments &&
    Object.entries(analysis.originalAssignments).some(
      ([id, owner]) => lines.get(id)?.characterId !== owner,
    )
  )
    return false;
  return (
    analysis.lines.length === expected.length &&
    analysis.lines.every((line) => {
      const current = lines.get(line.id);
      return current?.startMs === line.startMs && current?.endMs === line.endMs;
    })
  );
}
export function applySpeakers(
  project: Project,
  referenceLabel = 'Voice sample',
  temporaryPrefix = 'Speaker',
): Project {
  if (!analysisCurrent(project)) throw new Error('STALE_REVISION');
  const next = structuredClone(project);
  const analysis = next.speakerAnalysis!,
    mapping = new Map<number, string>();
  for (const cluster of analysis.clusters) {
    if (
      !analysis.assignments.some(
        (assignment) =>
          assignment.speaker === cluster.speaker &&
          next.dialogues.some(
            (line) =>
              line.id === assignment.dialogueId &&
              (!line.characterId || analysis.scope?.replaceAssigned),
          ),
      )
    )
      continue;
    let character = cluster.characterId
      ? next.characters.find((c) => c.id === cluster.characterId)
      : undefined;
    if (!character) {
      let number = next.characters.length + 1;
      while (
        next.characters.some(
          (c) => c.name === `${temporaryPrefix} ${String(number).padStart(2, '0')}`,
        )
      )
        number++;
      next.characters.push({
        id: crypto.randomUUID(),
        name: `${temporaryPrefix} ${String(number).padStart(2, '0')}`,
        color: colors[next.characters.length % colors.length],
        references: [],
        defaultReferenceId: null,
      });
      character = next.characters.at(-1)!;
    }
    const reference = {
      id: crypto.randomUUID(),
      label: referenceLabel,
      path: cluster.referencePath,
      durationMs: cluster.durationMs,
      transcript: next.sourceCues
        .filter((cue) =>
          next.dialogues
            .find((line) => line.id === cluster.referenceDialogueId)
            ?.sourceCueIds.includes(cue.id),
        )
        .map((cue) => cue.text)
        .join('\n'),
      sourceDialogueId: cluster.referenceDialogueId,
    };
    character.references.push(reference);
    character.defaultReferenceId ??= reference.id;
    next.formatVersion = Math.max(20, next.formatVersion);
    next.characterProfiles ??= {};
    next.characterProfiles[character.id] = {
      temporaryName: !cluster.characterId,
      ...next.characterProfiles[character.id],
      ...(cluster.vocalRegister ? { vocalRegister: cluster.vocalRegister } : {}),
      ...(!next.characterProfiles[character.id]?.portrait && cluster.portrait
        ? { portrait: cluster.portrait }
        : {}),
    };
    mapping.set(cluster.speaker, character.id);
  }
  const assignments = new Map(analysis.assignments.map((item) => [item.dialogueId, item]));
  next.dialogues.forEach((line) => {
    const match = assignments.get(line.id);
    if (
      (!line.characterId || analysis.scope?.replaceAssigned) &&
      match?.speaker !== null &&
      match?.speaker !== undefined
    )
      line.characterId = mapping.get(match.speaker) ?? null;
  });
  next.speakerAnalysis = null;
  return next;
}
