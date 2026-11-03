import { expect, test } from 'vitest';
import { portraitDraw, portraitMove, portraitRectValid, portraitResize } from './portraitFrame';
test('portrait drawing stays within the source frame in either drag direction', () => {
  for (const [a, b] of [
    [
      { x: 0.8, y: 0.9 },
      { x: 0.1, y: 0.2 },
    ],
    [
      { x: -0.2, y: -0.4 },
      { x: 1.2, y: 2 },
    ],
    [
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ],
  ])
    expect(portraitRectValid(portraitDraw(a, b))).toBe(true);
  expect(portraitDraw({ x: 0.8, y: 0.9 }, { x: 0.1, y: 0.2 }).x).toBe(0.1);
});
test('moving and resizing every corner cannot cross or escape frame boundaries', () => {
  const crop = { x: 0.2, y: 0.3, width: 0.4, height: 0.5 };
  expect(portraitMove(crop, 10, -10)).toEqual({ ...crop, x: 0.6, y: 0 });
  for (const corner of ['nw', 'ne', 'sw', 'se'])
    for (const p of [
      { x: -2, y: -2 },
      { x: 3, y: 3 },
      { x: 0.4, y: 0.4 },
    ])
      expect(portraitRectValid(portraitResize(crop, corner, p))).toBe(true);
});
test('empty, non-finite and out-of-frame selections cannot be captured', () => {
  for (const crop of [
    null,
    { x: NaN, y: 0, width: 0.2, height: 0.2 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0.9, y: 0.8, width: 0.2, height: 0.4 },
  ])
    expect(portraitRectValid(crop)).toBe(false);
});
