import type { Project } from './types';
import { audioTracks } from './audio';
const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
// Media jobs add results while a user's last keystrokes may still await autosave.
export function rebaseProject(base: Project, local: Project, incoming: Project): Project {
  const next = structuredClone(incoming);
  for (const key of [
    'name',
    'languages',
    'sourceCues',
    'targetCues',
    'dialogues',
    'characters',
    'pronunciation',
  ] as const)
    if (changed(base[key], local[key])) Object.assign(next, { [key]: structuredClone(local[key]) });
  const originals = audioTracks(base);
  for (const localTrack of local.tracks) {
    const before =
      base.tracks.find((track) => track.id === localTrack.id) ??
      originals.find((track) => track.id === localTrack.id);
    const server = next.tracks.find((track) => track.id === localTrack.id);
    if (!server) {
      if (!before) next.tracks.push(structuredClone(localTrack));
      continue;
    }
    for (const key of ['mute', 'solo', 'gain'] as const)
      if (changed(before?.[key], localTrack[key]))
        Object.assign(server, { [key]: localTrack[key] });
  }
  return next;
}
