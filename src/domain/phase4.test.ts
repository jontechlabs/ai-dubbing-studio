import { expect, test } from 'vitest';
import { demoProject, validateProject } from './project';
import {
  addCharacter,
  assignCharacter,
  deleteCharacter,
  applySpeakers,
  analysisCurrent,
} from './characters';
import { rebaseProject } from './rebase';
import { setSubtitleDisplay, subtitleDisplay, toggleSubtitles } from './subtitleDisplay';
test('character rename/assignment survive serialization; deletion clears only its assignments', () => {
  let project = addCharacter(demoProject(), 'Shin');
  const id = project.characters[0].id;
  project = assignCharacter(
    project,
    project.dialogues.slice(0, 2).map((line) => line.id),
    id,
  );
  expect(validateProject(JSON.parse(JSON.stringify(project))).dialogues[1].characterId).toBe(id);
  expect(deleteCharacter(project, id).dialogues.every((line) => !line.characterId)).toBe(true);
});
test('speaker proposals keep manual assignments and refuse changed subtitle timings', () => {
  let project = addCharacter(demoProject(), 'Manual');
  project = assignCharacter(project, [project.dialogues[0].id], project.characters[0].id);
  project.speakerAnalysis = {
    id: 'run',
    sourcePath: 'demo.mp4',
    lines: project.dialogues.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })),
    clusters: [
      {
        speaker: 0,
        referencePath: 'characters/reference.wav',
        durationMs: 2000,
        referenceDialogueId: project.dialogues[1].id,
      },
    ],
    assignments: project.dialogues.map((line) => ({
      dialogueId: line.id,
      speaker: 0,
      similarity: 0.9,
      reason: 'identified',
    })),
  };
  const applied = applySpeakers(project);
  expect(applied.dialogues[0].characterId).toBe(project.characters[0].id);
  expect(applied.dialogues[1].characterId).toBe(applied.characters[1].id);
  expect(applied.characters[1].references[0].path).toBe('characters/reference.wav');
  project.dialogues[1].startMs++;
  expect(analysisCurrent(project)).toBe(false);
  expect(() => applySpeakers(project)).toThrow('STALE_REVISION');
});
test('an incoming voice reference survives an unsaved manual character rename', () => {
  const base = addCharacter(demoProject(), 'Speaker 1'),
    local = structuredClone(base),
    incoming = structuredClone(base);
  local.characters[0].name = 'Shin';
  incoming.characters[0].references.push({
    id: 'ref',
    label: 'Neutral',
    path: 'characters/reference.wav',
    durationMs: 2000,
    transcript: 'Hello',
  });
  incoming.characters[0].defaultReferenceId = 'ref';
  const merged = rebaseProject(base, local, incoming);
  expect(merged.characters[0].name).toBe('Shin');
  expect(merged.characters[0].references).toHaveLength(1);
  expect(merged.characters[0].defaultReferenceId).toBe('ref');
});
test('subtitle eye controls preserve timings, text and the saved preview mode', () => {
  const project = demoProject();
  expect(subtitleDisplay(project)).toBe('target');
  const both = toggleSubtitles(project, 'source');
  expect(subtitleDisplay(both)).toBe('both');
  const source = toggleSubtitles(both, 'target');
  expect(subtitleDisplay(source)).toBe('source');
  const hidden = setSubtitleDisplay(source, 'off');
  expect(hidden.sourceCues).toEqual(project.sourceCues);
  expect(hidden.targetCues).toEqual(project.targetCues);
  expect(subtitleDisplay(validateProject(JSON.parse(JSON.stringify(hidden))))).toBe('off');
});
