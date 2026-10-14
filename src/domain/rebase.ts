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
    'pronunciation',
    'modelPreferences',
    'subtitleDisplay',
  ] as const)
    if (changed(base[key], local[key])) Object.assign(next, { [key]: structuredClone(local[key]) });
  if (changed(base.characters, local.characters)) {
    const original = new Map(base.characters.map((character) => [character.id, character]));
    const localIds = new Set(local.characters.map((character) => character.id));
    next.characters = next.characters.filter(
      (character) => !original.has(character.id) || localIds.has(character.id),
    );
    for (const localCharacter of local.characters) {
      const before = original.get(localCharacter.id),
        server = next.characters.find((character) => character.id === localCharacter.id);
      if (!server) {
        next.characters.push(structuredClone(localCharacter));
        continue;
      }
      for (const key of ['name', 'color', 'defaultReferenceId'] as const)
        if (changed(before?.[key], localCharacter[key]))
          Object.assign(server, { [key]: localCharacter[key] });
      const previousRefs = new Map(
        before?.references.map((reference) => [reference.id, reference]) ?? [],
      );
      const localRefIds = new Set(localCharacter.references.map((reference) => reference.id));
      server.references = server.references.filter(
        (reference) => !previousRefs.has(reference.id) || localRefIds.has(reference.id),
      );
      for (const reference of localCharacter.references) {
        const existing = server.references.findIndex((item) => item.id === reference.id);
        if (existing < 0) server.references.push(structuredClone(reference));
        else if (changed(previousRefs.get(reference.id), reference))
          server.references[existing] = structuredClone(reference);
      }
    }
  }
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
