import type { Project } from './types';
export interface DubbingLane {
  id: string;
  name: string;
  mute: boolean;
  solo: boolean;
  gain: number;
}
export interface DubbingLanes {
  sourcePath: string;
  lanes: DubbingLane[];
  assignments: Record<string, string>;
}
export const MAIN_DUBBING_LANE = 'main';
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
  if (next.dubbingLanes!.lanes.length >= 32) throw Error('DUBBING_LANES_LIMIT');
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
    if (lane === id) delete state.assignments[line];
  return next;
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
    s.lanes.length > 32 ||
    s.lanes[0]?.id !== MAIN_DUBBING_LANE ||
    !s.assignments ||
    typeof s.assignments !== 'object' ||
    Array.isArray(s.assignments)
  )
    throw Error('INVALID_DUBBING_LANES');
  const ids = new Set<string>();
  for (const lane of s.lanes) {
    if (
      !lane ||
      typeof lane.id !== 'string' ||
      !lane.id ||
      lane.id.length > 128 ||
      ids.has(lane.id) ||
      typeof lane.name !== 'string' ||
      !lane.name.trim() ||
      lane.name.length > 80 ||
      typeof lane.mute !== 'boolean' ||
      typeof lane.solo !== 'boolean' ||
      !Number.isFinite(lane.gain) ||
      lane.gain < 0 ||
      lane.gain > 3
    )
      throw Error('INVALID_DUBBING_LANES');
    ids.add(lane.id);
  }
  const assignments = Object.entries(s.assignments);
  if (
    assignments.length > 100000 ||
    assignments.some(([id, lane]) => !id || id.length > 128 || !ids.has(lane))
  )
    throw Error('INVALID_DUBBING_LANES');
}
