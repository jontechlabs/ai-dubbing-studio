import type { AudioSelection, Project } from './types';
import { audioTracks } from './audio';

export function validAudioSelection(project: Project | null, selection: AudioSelection) {
  if (!project?.media || selection.mediaId !== project.media.id) return false;
  const track = audioTracks(project).find((t) => t.id === selection.trackId);
  return (
    !!track &&
    Number.isSafeInteger(selection.startMs) &&
    Number.isSafeInteger(selection.endMs) &&
    selection.startMs >= 0 &&
    selection.endMs > selection.startMs &&
    selection.endMs <=
      Math.min(track.durationMs ?? project.media.durationMs, project.media.durationMs)
  );
}

/** A transient monitor mix; never save these temporary mute/solo overrides. */
export function audioSelectionProject(
  project: Project,
  selection: AudioSelection,
  beforeLevels: boolean,
): Project {
  if (!validAudioSelection(project, selection)) throw Error('INVALID_AUDIO_REGION');
  return {
    ...project,
    tracks: [
      ...project.tracks.filter((t) => !['original', 'audio', 'dubbing'].includes(t.kind)),
      ...audioTracks(project).map((track) => ({
        ...track,
        mute: track.id !== selection.trackId,
        solo: track.id === selection.trackId,
        ...(beforeLevels && track.id === selection.trackId
          ? { gain: 1, regionsEnabled: false }
          : {}),
      })),
    ],
  };
}
