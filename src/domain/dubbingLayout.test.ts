import { test, expect } from 'vitest';
import { dubbingLayout } from './dubbingLayout';
const clips = () =>
  Array.from({ length: 5 }, (_, i) => ({
    generation: { id: 'take-' + i },
    laneId: 'main',
    startMs: 1000,
    endMs: 3000,
    lane: i,
  }));
test('five simultaneous voices receive five visible rows in their shared track', () => {
  const source = clips(),
    before = structuredClone(source),
    layout = dubbingLayout(source);
  expect(layout.counts.get('main')).toBe(5);
  expect([...layout.rows.values()]).toEqual([0, 1, 2, 3, 4]);
  expect(source).toEqual(before);
});
test('independent tracks compact separator voice indices back to row zero', () => {
  const layout = dubbingLayout(clips().map((c, i) => ({ ...c, laneId: 'person-' + i })));
  expect([...layout.rows.values()]).toEqual([0, 0, 0, 0, 0]);
  expect([...layout.counts.values()]).toEqual([1, 1, 1, 1, 1]);
});
test('non-overlapping or touching takes reuse a row while real overlaps get another', () => {
  const a = clips()[0],
    b = { ...clips()[1], startMs: 3000, endMs: 5000 },
    c = { ...clips()[2], startMs: 4000, endMs: 6000 };
  const layout = dubbingLayout([c, b, a]);
  expect(layout.rows.get(a.generation.id)).toBe(0);
  expect(layout.rows.get(b.generation.id)).toBe(0);
  expect(layout.rows.get(c.generation.id)).toBe(1);
  expect(layout.counts.get('main')).toBe(2);
});
