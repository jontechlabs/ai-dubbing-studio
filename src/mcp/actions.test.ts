import { expect, it } from 'vitest';
import { demoProject } from '../domain/project';
import { checkContext, editProject, patchProject } from './actions';

it('rejects a stale revision and a different project before editing', () => {
  const p = demoProject();
  expect(checkContext(p, { projectId: p.id, expectedRevision: p.revision })).toBe(p);
  expect(() => checkContext(p, { projectId: 'another', expectedRevision: p.revision })).toThrow(
    'STALE_REVISION',
  );
  expect(() => checkContext(p, { projectId: p.id, expectedRevision: p.revision + 1 })).toThrow(
    'STALE_REVISION',
  );
});
it('applies tested JSON pointers atomically and never mutates the original on failure', () => {
  const p = demoProject(),
    before = structuredClone(p),
    id = p.dialogues[0].id;
  const next = patchProject(p, [
    { op: 'test', path: '/dialogues/0/id', value: id },
    { op: 'replace', path: '/name', value: 'Edited by AI' },
  ]);
  expect(next.name).toBe('Edited by AI');
  expect(p).toEqual(before);
  expect(() =>
    patchProject(p, [
      { op: 'replace', path: '/name', value: 'Temporary' },
      { op: 'test', path: '/dialogues/0/id', value: 'wrong' },
    ]),
  ).toThrow('MCP_PATCH_TEST_FAILED');
  expect(p).toEqual(before);
});
it('blocks prototype paths, metadata changes, missing values and invalid array indices', () => {
  const p = demoProject();
  for (const path of [
    '/__proto__/x',
    '/pronunciation/constructor/x',
    '/id',
    '/revision',
    '/dialogues/01',
    '/dialogues/-',
    '/unknownField',
  ])
    expect(() => patchProject(p, [{ op: 'replace', path, value: 'bad' }])).toThrow();
  expect(() => patchProject(p, [{ op: 'add', path: '/name' }])).toThrow('MCP_INVALID_PATCH');
  expect(() => patchProject(p, [{ op: 'replace', path: '/unknown/child', value: 1 }])).toThrow(
    'MCP_INVALID_PATCH',
  );
  expect(() =>
    patchProject(p, [{ op: 'replace', path: '/sourceCues/0/endMs', value: -1 }]),
  ).toThrow();
  expect(({} as Record<string, unknown>).x).toBeUndefined();
});
it('supports escaped pronunciation keys and remove/add without unsafe path resolution', () => {
  const p = demoProject();
  const next = patchProject(p, [
    { op: 'add', path: '/pronunciation/a~1b~0c', value: 'Pronunciation' },
  ]);
  expect(next.pronunciation['a/b~c']).toBe('Pronunciation');
  expect(
    patchProject(next, [{ op: 'remove', path: '/pronunciation/a~1b~0c' }]).pronunciation['a/b~c'],
  ).toBeUndefined();
});
it('uses the normal translation approval and timing operations', () => {
  const p = demoProject(),
    lineId = p.dialogues[0].id;
  const next = editProject(p, 'studio_edit_dialogue', {
    lineId,
    role: 'target',
    text: 'Traduction IA.',
    approved: true,
  });
  expect(next.translationApprovals?.[lineId].targetText).toBe('Traduction IA.');
  const timed = editProject(next, 'studio_retime_dialogue', {
    lineId,
    startMs: 1000,
    endMs: 3000,
    role: 'both',
  });
  expect(timed.dialogues[0].startMs).toBe(1000);
  expect(timed.dialogues[0].endMs).toBe(3000);
  expect(() =>
    editProject(p, 'studio_edit_dialogue', { lineId: 'missing', role: 'target', text: 'Bad' }),
  ).toThrow('MCP_UNKNOWN_DIALOGUE');
});
