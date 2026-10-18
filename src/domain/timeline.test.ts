import { it, expect } from 'vitest';
import { navigationLeft } from './timeline';
it('brings a selected reply and pre-roll into view at the current zoom on a long film', () => {
  const request = {
    projectId: 'p',
    lineId: 'line',
    startMs: 3600000,
    endMs: 3602000,
    timeMs: 3599750,
  };
  const zoom = 1000,
    viewport = 1000,
    duration = 7200000,
    scale = (viewport * zoom) / duration;
  const left = navigationLeft(duration, viewport, zoom, request);
  expect(request.timeMs * scale - left).toBeGreaterThan(0);
  expect(request.endMs * scale - left).toBeLessThan(viewport);
  expect(left).toBeGreaterThan(0);
});
it('clamps navigation at media boundaries and prioritizes the playhead when the reply exceeds the viewport', () => {
  const request = { projectId: 'p', lineId: 'line', startMs: 0, endMs: 16000, timeMs: 12000 };
  expect(navigationLeft(16000, 1000, 1, request)).toBe(0);
  const left = navigationLeft(16000, 1000, 10, request);
  expect((request.timeMs * 10000) / 16000 - left).toBe(200);
});
