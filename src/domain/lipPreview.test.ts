import { expect, test } from 'vitest';
import { lipPreviewPlan } from './lipPreview';
import type { LipVideo } from './inpaint';

const edit = (id: string, startMs: number, durationMs: number) =>
  ({ id, startMs, durationMs }) as LipVideo;
test('preloads only the next bounded sequence and keeps exact half-open dialogue boundaries', () => {
  const edits = [edit('one', 1000, 2000), edit('two', 3000, 1000), edit('three', 12000, 2000)];
  expect(lipPreviewPlan(edits, 0)).toEqual({ active: undefined, next: edits[0] });
  expect(lipPreviewPlan(edits, 1000)).toEqual({ active: edits[0], next: edits[1] });
  expect(lipPreviewPlan(edits, 2999).active?.id).toBe('one');
  expect(lipPreviewPlan(edits, 3000)).toEqual({ active: edits[1], next: undefined });
  expect(lipPreviewPlan(edits, 4000)).toEqual({ active: undefined, next: undefined });
  expect(lipPreviewPlan(edits, 7000).next?.id).toBe('three');
  expect(lipPreviewPlan([], 0)).toEqual({ active: undefined, next: undefined });
});

test('random seeks across thousands of dialogue clips keep the active and nearest upcoming sequence', () => {
  const edits = Array.from({ length: 3000 }, (_, i) => edit(String(i), i * 3000, 1500));
  for (const ms of [0, 1499, 1500, 2999, 3000, 4500001, 8997000, 9000000]) {
    const result = lipPreviewPlan(edits, ms);
    expect(result.active).toBe(edits.find((e) => e.startMs <= ms && ms < e.startMs + e.durationMs));
    expect(result.next).toBe(edits.find((e) => e.startMs > ms && e.startMs - ms <= 5000));
  }
});
