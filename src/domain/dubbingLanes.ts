import type { Project } from './types';
export interface DubbingLane {
  characterId?: string;
  characterName?: string;
  id: string;
  name: string;
  mute: boolean;
  solo: boolean;
  gain: number;
}
export interface DubbingLanes {
  byCharacter?: { enabled: boolean; manualLineIds: string[] };
  sourcePath: string;
  lanes: DubbingLane[];
  assignments: Record<string, string>;
}
export const MAIN_DUBBING_LANE = 'main';
export const MAX_DUBBING_LANES = 256;
export interface CharacterLaneOptions {
  enabled: boolean;
  preserveManual: boolean;
}
export function dubbingLanes(project: Project): DubbingLane[] {
  const state = project.dubbingLanes;
  return state && state.sourcePath === project.media?.path
    ? state.lanes
    : [{ id: MAIN_DUBBING_LANE, name: 'Doublage 1', mute: false, solo: false, gain: 1 }];
}
export function dubbingLaneId(project: Project, lineId: string) {
  const state = project.dubbingLanes;
  return state && state.sourcePath === project.media?.path
    ? (state.assignments[lineId] ?? MAIN_DUBBING_LANE)
    : MAIN_DUBBING_LANE;
}
export function dubbingLaneGain(project: Project, lineId: string) {
  const lanes = dubbingLanes(project),
    lane = lanes.find((l) => l.id === dubbingLaneId(project, lineId));
  return !lane || lane.mute || (lanes.some((l) => l.solo && !l.mute) && !lane.solo) ? 0 : lane.gain;
}
function editable(project: Project) {
  if (!project.media) throw Error('MEDIA_MISSING');
  const next = structuredClone(project);
  next.formatVersion = Math.max(32, next.formatVersion);
  if (next.dubbingLanes?.sourcePath !== next.media!.path)
    next.dubbingLanes = {
      sourcePath: next.media!.path,
      lanes: dubbingLanes(project),
      assignments: {},
    };
  return next;
}
export function addDubbingLane(project: Project, name: string, lineIds: string[] = []) {
  const next = editable(project);
  if (next.dubbingLanes!.lanes.length >= MAX_DUBBING_LANES) throw Error('DUBBING_LANES_LIMIT');
  if (next.dubbingLanes!.lanes.length >= 32) next.formatVersion = Math.max(33, next.formatVersion);
  const id = crypto.randomUUID();
  next.dubbingLanes!.lanes.push({ id, name: name.trim(), gain: 1, mute: false, solo: false });
  return assignDubbingLane(next, lineIds, id);
}
export function assignDubbingLane(project: Project, lineIds: string[], laneId: string) {
  const next = editable(project),
    state = next.dubbingLanes!;
  if (
    !state.lanes.some((l) => l.id === laneId) ||
    lineIds.some((id) => !next.dialogues.some((l) => l.id === id))
  )
    throw Error('INVALID_DUBBING_LANES');
  for (const id of lineIds) {
    if (laneId === MAIN_DUBBING_LANE) delete state.assignments[id];
    else state.assignments[id] = laneId;
  }
  if (state.byCharacter)
    state.byCharacter.manualLineIds = [
      ...new Set([...state.byCharacter.manualLineIds, ...lineIds]),
    ];
  validateDubbingLanes(next);
  return next;
}
export function editDubbingLane(
  project: Project,
  id: string,
  patch: Partial<Pick<DubbingLane, 'name' | 'mute' | 'solo' | 'gain'>>,
) {
  const next = editable(project),
    lane = next.dubbingLanes!.lanes.find((l) => l.id === id);
  if (!lane) throw Error('INVALID_DUBBING_LANES');
  Object.assign(lane, patch);
  validateDubbingLanes(next);
  return next;
}
export function removeDubbingLane(project: Project, id: string) {
  if (id === MAIN_DUBBING_LANE || !dubbingLanes(project).some((l) => l.id === id))
    throw Error('INVALID_DUBBING_LANES');
  const next = editable(project),
    state = next.dubbingLanes!;
  state.lanes = state.lanes.filter((l) => l.id !== id);
  for (const [line, lane] of Object.entries(state.assignments))
    if (lane === id) {
      delete state.assignments[line];
      if (state.byCharacter && !state.byCharacter.manualLineIds.includes(line))
        state.byCharacter.manualLineIds.push(line);
    }
  return next;
}
export function syncCharacterLanes(project: Project): Project {
  if (
    !project.dubbingLanes?.byCharacter?.enabled ||
    project.dubbingLanes.sourcePath !== project.media?.path
  )
    return project;
  validateDubbingLanes(project);
  const next = structuredClone(project),
    state = next.dubbingLanes!,
    routing = state.byCharacter!;
  const characters = new Map(next.characters.map((c) => [c.id, c]));
  const lines = new Map(next.dialogues.map((l) => [l.id, l]));
  routing.manualLineIds = routing.manualLineIds.filter((id) => lines.has(id));
  const manual = new Set(routing.manualLineIds),
    needed = new Set(
      next.dialogues
        .filter((l) => !manual.has(l.id) && l.characterId && characters.has(l.characterId))
        .map((l) => l.characterId!),
    );
  const ids = new Set(state.lanes.map((l) => l.id)),
    linked = new Map<string, DubbingLane>();
  const label = (name: string) => [...name.trim()].slice(0, 80).join('');
  for (const lane of state.lanes) {
    const character = lane.characterId ? characters.get(lane.characterId) : undefined;
    if (lane.characterId && !character) {
      delete lane.characterId;
      delete lane.characterName;
    }
    if (character) {
      if (lane.name === lane.characterName) lane.name = label(character.name);
      lane.characterName = label(character.name);
      linked.set(character.id, lane);
    }
  }
  const owners = new Map<string, Set<string | null>>();
  for (const [lineId, laneId] of Object.entries(state.assignments)) {
    const line = lines.get(lineId);
    if (!line) {
      delete state.assignments[lineId];
      continue;
    }
    const set = owners.get(laneId) ?? new Set<string | null>();
    set.add(line.characterId);
    owners.set(laneId, set);
  }
  const nameCounts = new Map<string, number>();
  for (const c of next.characters) nameCounts.set(c.name, (nameCounts.get(c.name) ?? 0) + 1);
  let serial = 1;
  for (const character of next.characters) {
    if (!needed.has(character.id) || linked.has(character.id)) continue;
    const available = state.lanes.filter((l) => l.id !== MAIN_DUBBING_LANE && !l.characterId);
    const named =
      nameCounts.get(character.name) === 1
        ? available.filter(
            (l) =>
              l.name === character.name &&
              (!owners.has(l.id) ||
                (owners.get(l.id)!.size === 1 && owners.get(l.id)!.has(character.id))),
          )
        : [];
    const exclusive = available.filter(
      (l) => owners.get(l.id)?.size === 1 && owners.get(l.id)!.has(character.id),
    );
    let lane = named.length === 1 ? named[0] : exclusive.length === 1 ? exclusive[0] : undefined;
    if (!lane) {
      if (state.lanes.length >= MAX_DUBBING_LANES) throw Error('DUBBING_LANES_LIMIT');
      while (ids.has('character-' + serial)) serial++;
      const id = 'character-' + serial++;
      ids.add(id);
      lane = { id, name: label(character.name), gain: 1, mute: false, solo: false };
      state.lanes.push(lane);
    }
    lane.characterId = character.id;
    lane.characterName = label(character.name);
    linked.set(character.id, lane);
  }
  for (const line of next.dialogues) {
    if (manual.has(line.id)) continue;
    const lane = line.characterId ? linked.get(line.characterId) : undefined;
    if (lane) state.assignments[line.id] = lane.id;
    else delete state.assignments[line.id];
  }
  validateDubbingLanes(next);
  return next;
}
export function configureCharacterLanes(project: Project, options: CharacterLaneOptions): Project {
  const next = editable(project),
    state = next.dubbingLanes!;
  next.formatVersion = Math.max(33, next.formatVersion);
  state.byCharacter = {
    enabled: options.enabled,
    manualLineIds: options.preserveManual
      ? (state.byCharacter?.manualLineIds ?? Object.keys(state.assignments).sort())
      : [],
  };
  return syncCharacterLanes(next);
}
export function resetCharacterLane(project: Project, lineIds: string[]): Project {
  if (
    !project.dubbingLanes?.byCharacter?.enabled ||
    lineIds.some((id) => !project.dialogues.some((l) => l.id === id))
  )
    throw Error('INVALID_DUBBING_LANES');
  const next = structuredClone(project),
    ids = new Set(lineIds);
  next.dubbingLanes!.byCharacter!.manualLineIds =
    next.dubbingLanes!.byCharacter!.manualLineIds.filter((id) => !ids.has(id));
  return syncCharacterLanes(next);
}
export function validateDubbingLanes(project: Project) {
  const s = project.dubbingLanes;
  if (s === undefined) return;
  if (
    project.formatVersion < 32 ||
    !s ||
    typeof s !== 'object' ||
    Array.isArray(s) ||
    typeof s.sourcePath !== 'string' ||
    !s.sourcePath ||
    s.sourcePath.startsWith('/') ||
    s.sourcePath.includes('\\') ||
    s.sourcePath.includes(':') ||
    s.sourcePath.split('/').some((p) => !p || p === '..' || p === '.') ||
    !Array.isArray(s.lanes) ||
    !s.lanes.length ||
    s.lanes.length > (project.formatVersion >= 33 ? MAX_DUBBING_LANES : 32) ||
    s.lanes[0]?.id !== MAIN_DUBBING_LANE ||
    !s.assignments ||
    typeof s.assignments !== 'object' ||
    Array.isArray(s.assignments)
  )
    throw Error('INVALID_DUBBING_LANES');
  const ids = new Set<string>(),
    characters = new Set<string>();
  for (const lane of s.lanes) {
    if (
      !lane ||
      typeof lane.id !== 'string' ||
      !lane.id ||
      lane.id.length > 128 ||
      ids.has(lane.id) ||
      typeof lane.name !== 'string' ||
      !lane.name.trim() ||
      [...lane.name].length > 80 ||
      typeof lane.mute !== 'boolean' ||
      typeof lane.solo !== 'boolean' ||
      !Number.isFinite(lane.gain) ||
      lane.gain < 0 ||
      lane.gain > 3
    )
      throw Error('INVALID_DUBBING_LANES');
    ids.add(lane.id);
    if (lane.characterId !== undefined || lane.characterName !== undefined) {
      if (
        project.formatVersion < 33 ||
        lane.id === MAIN_DUBBING_LANE ||
        typeof lane.characterId !== 'string' ||
        !lane.characterId ||
        lane.characterId.length > 128 ||
        characters.has(lane.characterId) ||
        typeof lane.characterName !== 'string' ||
        !lane.characterName.trim() ||
        [...lane.characterName].length > 80
      )
        throw Error('INVALID_DUBBING_LANES');
      characters.add(lane.characterId);
    }
  }
  if (s.byCharacter !== undefined) {
    const r = s.byCharacter;
    if (
      project.formatVersion < 33 ||
      !r ||
      typeof r.enabled !== 'boolean' ||
      !Array.isArray(r.manualLineIds) ||
      r.manualLineIds.length > 100000 ||
      new Set(r.manualLineIds).size !== r.manualLineIds.length ||
      r.manualLineIds.some((id) => typeof id !== 'string' || !id || id.length > 128)
    )
      throw Error('INVALID_DUBBING_LANES');
  }
  const assignments = Object.entries(s.assignments);
  if (
    assignments.length > 100000 ||
    assignments.some(([id, lane]) => !id || id.length > 128 || !ids.has(lane))
  )
    throw Error('INVALID_DUBBING_LANES');
}
