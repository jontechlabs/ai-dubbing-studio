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
    'pronunciation',
    'modelPreferences',
    'subtitleDisplay',
  ] as const)
    if (changed(base[key], local[key])) Object.assign(next, { [key]: structuredClone(local[key]) });
  if (changed(base.dialogues, local.dialogues))
    next.dialogues = local.dialogues.map((line) => {
      const before = base.dialogues.find((d) => d.id === line.id),
        server = incoming.dialogues.find((d) => d.id === line.id);
      if (!server || !before) return structuredClone(line);
      return {
        ...structuredClone(line),
        selectedGenerationIds: changed(before.selectedGenerationIds, line.selectedGenerationIds)
          ? line.selectedGenerationIds
          : server.selectedGenerationIds,
        status:
          changed(before.status, line.status) &&
          (!changed(before.selectedGenerationIds, server.selectedGenerationIds) ||
            changed(before.selectedGenerationIds, line.selectedGenerationIds))
            ? line.status
            : server.status,
      };
    });
  if (changed(base.generations, local.generations)) {
    const localIds = new Set(local.generations.map((g) => g.id)),
      previousIds = new Set(base.generations.map((g) => g.id));
    next.generations = next.generations.filter((g) => !previousIds.has(g.id) || localIds.has(g.id));
    for (const g of local.generations)
      if (!next.generations.some((item) => item.id === g.id))
        next.generations.push(structuredClone(g));
  }
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
      if (
        !before ||
        (['original', 'dubbing'].includes(localTrack.kind) &&
          !base.tracks.some((track) => track.id === localTrack.id))
      )
        next.tracks.push(
          structuredClone(
            ['original', 'dubbing'].includes(localTrack.kind) &&
              incoming.media?.path !== base.media?.path
              ? { ...localTrack, regions: undefined, regionsEnabled: undefined }
              : localTrack,
          ),
        );
      continue;
    }
    for (const key of ['mute', 'solo', 'gain', 'regions', 'regionsEnabled'] as const)
      if (
        ['original', 'dubbing'].includes(localTrack.kind) &&
        (key === 'regions' || key === 'regionsEnabled') &&
        incoming.media?.path !== base.media?.path
      )
        continue;
      else if (changed(before?.[key], localTrack[key]))
        Object.assign(server, { [key]: localTrack[key] });
  }
  next.formatVersion = Math.max(next.formatVersion, local.formatVersion);
  return next;
}
