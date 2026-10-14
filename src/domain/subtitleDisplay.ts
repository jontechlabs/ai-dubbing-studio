import type { Project } from './types';
export type SubtitleDisplay = NonNullable<Project['subtitleDisplay']>;
export function subtitleDisplay(project: Project): SubtitleDisplay {
  return (
    project.subtitleDisplay ??
    (project.targetCues.length ? 'target' : project.sourceCues.length ? 'source' : 'off')
  );
}
export function setSubtitleDisplay(project: Project, display: SubtitleDisplay): Project {
  const next = structuredClone(project);
  next.formatVersion = 3;
  next.subtitleDisplay = display;
  for (const role of ['source', 'target'] as const) {
    let track = next.tracks.find((item) => item.id === role);
    if (!track) {
      track = {
        id: role,
        kind: 'subtitle',
        language: project.languages[role],
        mute: false,
        solo: false,
        gain: 1,
      };
      next.tracks.push(track);
    }
    track.mute = display !== role && display !== 'both';
  }
  return next;
}
export function toggleSubtitles(project: Project, role: 'source' | 'target'): Project {
  const mode = subtitleDisplay(project),
    other = role === 'source' ? 'target' : 'source';
  const visible = mode === role || mode === 'both',
    otherVisible = mode === other || mode === 'both';
  return setSubtitleDisplay(
    project,
    visible ? (otherVisible ? other : 'off') : otherVisible ? 'both' : role,
  );
}
