import type { Project } from './types';
import { dubbingClips, dubbingDuration } from './mix';
import { dubbingLaneId, dubbingLanes, MAX_DUBBING_LANES } from './dubbingLanes';

/** Preserve existing clips first. New/changed clips keep their timestamp and
 * duration and use a free lane with the same mixer settings (or a new lane). */
export function resolveDubbingPlacement(before: Project, project: Project): Project {
  if (!project.media) return project;
  let next = project;
  const previous = new Map(before.dialogues.map((line) => [line.id, line]));
  const language = project.languages.target;
  // Timing belongs to the selected performance. Do not squeeze a new take into
  // the duration previously set for a different one. Explicit new timings win.
  for (const line of project.dialogues) {
    const old = previous.get(line.id);
    if (
      line.selectedGenerationIds[language] &&
      old?.selectedGenerationIds[language] !== line.selectedGenerationIds[language] &&
      dubbingDuration(before, line.id) !== undefined &&
      dubbingDuration(before, line.id) === dubbingDuration(project, line.id)
    ) {
      if (next === project) next = structuredClone(project);
      delete next.dubbingTiming?.durationsMs?.[line.id]?.[language];
    }
  }
  const oldClips = new Map(dubbingClips(before).map((clip) => [clip.line.id, clip]));
  const clips = dubbingClips(next).map((clip) => {
    const old = oldClips.get(clip.line.id);
    return {
      ...clip,
      changed:
        !old ||
        old.generation.id !== clip.generation.id ||
        old.startMs !== clip.startMs ||
        old.endMs !== clip.endMs ||
        old.laneId !== clip.laneId,
    };
  });
  clips.sort((a, b) => Number(a.changed) - Number(b.changed) || a.startMs - b.startMs);
  const occupied = new Map<string, { startMs: number; endMs: number }[]>();
  for (const clip of clips) {
    if (clip.endMs <= clip.startMs) continue;
    const free = (lane: string) =>
      !(occupied.get(lane) ?? []).some(
        (other) => other.startMs < clip.endMs && clip.startMs < other.endMs,
      );
    let laneId = dubbingLaneId(next, clip.line.id);
    if (!free(laneId)) {
      const lanes = dubbingLanes(next),
        current = lanes.find((lane) => lane.id === laneId);
      if (!current) throw Error('INVALID_DUBBING_LANES');
      const available = lanes.find(
        (lane) =>
          lane.id !== laneId &&
          lane.mute === current.mute &&
          lane.solo === current.solo &&
          lane.gain === current.gain &&
          (!next.dubbingLanes?.byCharacter?.enabled || lane.characterId === current.characterId) &&
          free(lane.id),
      );
      if (next === project) next = structuredClone(project);
      if (next.dubbingLanes?.sourcePath !== next.media!.path) {
        next.formatVersion = Math.max(next.formatVersion, 32);
        next.dubbingLanes = {
          sourcePath: next.media!.path,
          lanes: structuredClone(lanes),
          assignments: {},
        };
      }
      const state = next.dubbingLanes!;
      if (available) laneId = available.id;
      else {
        if (state.lanes.length >= MAX_DUBBING_LANES) throw Error('DUBBING_LANES_LIMIT');
        if (state.lanes.length >= 32) next.formatVersion = Math.max(next.formatVersion, 33);
        laneId = crypto.randomUUID();
        state.lanes.push({
          id: laneId,
          name: `Doublage ${state.lanes.length + 1}`,
          gain: current.gain,
          mute: current.mute,
          solo: current.solo,
        });
      }
      if (laneId === 'main') delete state.assignments[clip.line.id];
      else state.assignments[clip.line.id] = laneId;
      if (state.byCharacter && !state.byCharacter.manualLineIds.includes(clip.line.id))
        state.byCharacter.manualLineIds.push(clip.line.id);
    }
    const intervals = occupied.get(laneId) ?? [];
    intervals.push({ startMs: clip.startMs, endMs: clip.endMs });
    occupied.set(laneId, intervals);
  }
  return next;
}
