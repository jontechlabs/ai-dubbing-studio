import type { Project, VoiceReference } from './types';

export interface CharacterPortrait {
  path: string;
  sourcePath: string;
  atMs: number;
  lineId: string;
  crop: { x: number; y: number; width: number; height: number };
  differenceHash: string;
  colors: number[];
  confirmed: boolean;
}
export interface VocalRegister {
  medianHz: number;
  confidence: number;
  analyzedMs: number;
}
export interface CharacterProfile {
  gender?: 'unspecified' | 'man' | 'woman' | 'other';
  temporaryName?: boolean;
  portrait?: CharacterPortrait;
  vocalRegister?: VocalRegister;
}
export interface SpeakerScope {
  startMs?: number;
  endMs?: number;
  trackId?: string;
  referenceCharacterId?: string;
  replaceAssigned?: boolean;
}
export function editCharacterProfile(
  project: Project,
  id: string,
  changes: CharacterProfile,
): Project {
  if (!project.characters.some((c) => c.id === id)) throw Error('INVALID_CHARACTER');
  const next = structuredClone(project);
  next.formatVersion = Math.max(20, next.formatVersion);
  next.characterProfiles ??= {};
  next.characterProfiles[id] = { ...next.characterProfiles[id], ...changes };
  validateCharacterProfiles(next);
  return next;
}
export function validateCharacterProfiles(project: Project) {
  const entries = Object.entries(project.characterProfiles ?? {});
  if (entries.length && project.formatVersion < 20) throw Error('INVALID_CHARACTER');
  const characters = new Set(project.characters.map((c) => c.id));
  for (const [id, profile] of entries) {
    if (
      !characters.has(id) ||
      !profile ||
      typeof profile !== 'object' ||
      (profile.gender !== undefined &&
        !['unspecified', 'man', 'woman', 'other'].includes(profile.gender)) ||
      (profile.temporaryName !== undefined && typeof profile.temporaryName !== 'boolean')
    )
      throw Error('INVALID_CHARACTER');
    const p = profile.portrait,
      r = p?.crop;
    if (
      p &&
      (!p.path.startsWith('characters/') ||
        !p.path.endsWith('.png') ||
        p.path.includes('..') ||
        /[:\\]/u.test(p.path) ||
        !p.sourcePath ||
        !p.lineId ||
        !Number.isSafeInteger(p.atMs) ||
        p.atMs < 0 ||
        !r ||
        ![r.x, r.y, r.width, r.height].every(Number.isFinite) ||
        r.x < 0 ||
        r.y < 0 ||
        r.width <= 0 ||
        r.height <= 0 ||
        r.x + r.width > 1.000001 ||
        r.y + r.height > 1.000001 ||
        !/^[0-9a-f]{16}$/u.test(p.differenceHash) ||
        !Array.isArray(p.colors) ||
        p.colors.length !== 48 ||
        p.colors.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
        typeof p.confirmed !== 'boolean')
    )
      throw Error('CHARACTER_PORTRAIT_INVALID');
    const v = profile.vocalRegister;
    if (
      v &&
      (!Number.isFinite(v.medianHz) ||
        v.medianHz < 50 ||
        v.medianHz > 700 ||
        !Number.isFinite(v.confidence) ||
        v.confidence < 0 ||
        v.confidence > 1 ||
        !Number.isSafeInteger(v.analyzedMs) ||
        v.analyzedMs < 100 ||
        v.analyzedMs > 20000)
    )
      throw Error('INVALID_CHARACTER');
  }
  const a = project.speakerAnalysis;
  if (a) {
    const lineIds = new Set(a.lines.map((l) => l.id)),
      speakers = new Set(a.clusters.map((c) => c.speaker));
    if (
      lineIds.size !== a.lines.length ||
      speakers.size !== a.clusters.length ||
      a.clusters.length > 32 ||
      a.assignments.length !== a.lines.length ||
      new Set(a.assignments.map((v) => v.dialogueId)).size !== lineIds.size ||
      a.lines.some(
        (l) =>
          !l.id ||
          !Number.isSafeInteger(l.startMs) ||
          !Number.isSafeInteger(l.endMs) ||
          l.startMs < 0 ||
          l.endMs <= l.startMs,
      ) ||
      a.assignments.some(
        (v) =>
          !lineIds.has(v.dialogueId) ||
          (v.speaker !== null && !speakers.has(v.speaker)) ||
          (v.similarity !== null &&
            (!Number.isFinite(v.similarity) || v.similarity < -1 || v.similarity > 1)),
      )
    )
      throw Error('INVALID_CHARACTER');
    for (const c of a.clusters) {
      if (
        !Number.isSafeInteger(c.speaker) ||
        c.speaker < 0 ||
        c.speaker >= 32 ||
        !lineIds.has(c.referenceDialogueId) ||
        !c.referencePath.startsWith('characters/') ||
        !c.referencePath.endsWith('.wav') ||
        /[:\\]/u.test(c.referencePath) ||
        c.referencePath.includes('..') ||
        !Number.isSafeInteger(c.durationMs) ||
        c.durationMs < 1000 ||
        c.durationMs > 20000 ||
        (c.characterId && !characters.has(c.characterId))
      )
        throw Error('INVALID_CHARACTER');
      // Validate candidates using the same rules as saved profile metadata.
      if (c.portrait || c.vocalRegister)
        validateCharacterProfiles({
          ...project,
          formatVersion: Math.max(20, project.formatVersion),
          speakerAnalysis: null,
          characters: [
            { id: 'candidate', name: '', color: '', references: [], defaultReferenceId: null },
          ],
          characterProfiles: {
            candidate: { portrait: c.portrait, vocalRegister: c.vocalRegister },
          },
        });
    }
    const s = a.scope;
    if (
      s &&
      (project.formatVersion < 20 ||
        (s.startMs === undefined) !== (s.endMs === undefined) ||
        (s.startMs !== undefined &&
          (!Number.isSafeInteger(s.startMs) ||
            !Number.isSafeInteger(s.endMs) ||
            s.startMs < 0 ||
            s.endMs! <= s.startMs ||
            a.lines.some((l) => l.startMs >= s.endMs! || l.endMs <= s.startMs!))) ||
        (s.referenceCharacterId && !characters.has(s.referenceCharacterId)) ||
        (s.replaceAssigned !== undefined && typeof s.replaceAssigned !== 'boolean'))
    )
      throw Error('INVALID_CHARACTER');
    if (
      a.originalAssignments &&
      (Object.keys(a.originalAssignments).length !== lineIds.size ||
        Object.keys(a.originalAssignments).some((id) => !lineIds.has(id)))
    )
      throw Error('INVALID_CHARACTER');
  }
}
export function portraitSimilarity(a: CharacterPortrait, b: CharacterPortrait): number {
  let differing = 0;
  for (let i = 0; i < 16; i++) {
    let bits = Number.parseInt(a.differenceHash[i], 16) ^ Number.parseInt(b.differenceHash[i], 16);
    while (bits) {
      differing += bits & 1;
      bits >>>= 1;
    }
  }
  const dot = a.colors.reduce((sum, v, i) => sum + v * b.colors[i], 0);
  const norm = Math.sqrt(
    a.colors.reduce((s, v) => s + v * v, 0) * b.colors.reduce((s, v) => s + v * v, 0),
  );
  return 0.65 * (1 - differing / 64) + 0.35 * (norm > 0 ? dot / norm : 0);
}
export function similarCharacterPortraits(project: Project, minimum = 0.86) {
  const rows = project.characters.filter((c) => project.characterProfiles?.[c.id]?.portrait);
  const result: { firstId: string; secondId: string; similarity: number }[] = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const firstId = rows[i].id,
        secondId = rows[j].id;
      const similarity = portraitSimilarity(
        project.characterProfiles![firstId].portrait!,
        project.characterProfiles![secondId].portrait!,
      );
      if (similarity >= minimum) result.push({ firstId, secondId, similarity });
    }
  return result.sort((a, b) => b.similarity - a.similarity).slice(0, 50);
}
export interface CharacterMerge {
  ids: string[];
  keepId: string;
  defaultReferenceId?: string;
  portraitFromId?: string;
  preparedReference?: VoiceReference;
}
export function mergeCharacters(project: Project, options: CharacterMerge): Project {
  const ids = new Set(options.ids);
  if (
    ids.size < 2 ||
    !ids.has(options.keepId) ||
    [...ids].some((id) => !project.characters.some((c) => c.id === id))
  )
    throw Error('INVALID_CHARACTER');
  const next = structuredClone(project),
    keeper = next.characters.find((c) => c.id === options.keepId)!;
  const references = new Map<string, VoiceReference>();
  for (const c of next.characters.filter((c) => ids.has(c.id)))
    for (const r of c.references) {
      const previous = references.get(r.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(r))
        throw Error('CHARACTER_REFERENCE_CONFLICT');
      references.set(r.id, r);
    }
  if (options.preparedReference) {
    if (references.has(options.preparedReference.id)) throw Error('CHARACTER_REFERENCE_CONFLICT');
    references.set(options.preparedReference.id, structuredClone(options.preparedReference));
  }
  const defaultId =
    options.preparedReference?.id ?? options.defaultReferenceId ?? keeper.defaultReferenceId;
  if (defaultId && !references.has(defaultId)) throw Error('INVALID_REFERENCE_AUDIO');
  keeper.references = [...references.values()];
  keeper.defaultReferenceId = defaultId ?? null;
  if (options.portraitFromId) {
    if (!ids.has(options.portraitFromId)) throw Error('INVALID_CHARACTER');
    const portrait = next.characterProfiles?.[options.portraitFromId]?.portrait;
    if (!portrait) throw Error('CHARACTER_PORTRAIT_INVALID');
    next.characterProfiles ??= {};
    next.characterProfiles[keeper.id] = {
      ...next.characterProfiles[keeper.id],
      portrait: structuredClone(portrait),
    };
  }
  next.characters = next.characters.filter((c) => !ids.has(c.id) || c.id === keeper.id);
  for (const line of next.dialogues)
    if (line.characterId && ids.has(line.characterId)) line.characterId = keeper.id;
  for (const id of ids) if (id !== keeper.id) delete next.characterProfiles?.[id];
  next.speakerAnalysis = null;
  if (next.characterProfiles && Object.keys(next.characterProfiles).length)
    next.formatVersion = Math.max(20, next.formatVersion);
  // Historical takes retain their recorded metadata and immutable WAV files.
  return next;
}
export function speakerAudioSnapshot(project: Project, referenceCharacterId?: string): unknown {
  return structuredClone({
    tracks: project.tracks,
    patches: project.generations.filter((g) =>
      ['audioPatch', 'audioEffects'].includes(g.kind ?? ''),
    ),
    references: referenceCharacterId
      ? project.characters
          .filter((c) => c.id === referenceCharacterId)
          .map((c) => ({ id: c.id, references: c.references }))
      : [],
  });
}
export function sameSnapshot(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([, v]) => v !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
