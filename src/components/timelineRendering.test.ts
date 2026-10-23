import { expect, it } from 'vitest';
import { peakEnvelope, peakInRange, timelineZoomBounds } from './timelineRendering';

it('fits short clips and limits long-film overviews to two minutes at all window widths', () => {
  for (const width of [760, 1200, 2400, 7680]) {
    for (const duration of [1000, 16000, 120000, 120001, 7200000, 21600000]) {
      const { minZoom, maxZoom } = timelineZoomBounds(duration, width);
      expect(duration / minZoom).toBeLessThanOrEqual(120000);
      expect(minZoom).toBeGreaterThanOrEqual(1);
      expect(maxZoom).toBeGreaterThanOrEqual(minZoom);
      expect(width * maxZoom).toBeLessThanOrEqual(8000000.000001);
      if (duration <= 120000) expect(minZoom).toBe(1);
    }
  }
});
it('preserves exact waveform peaks at pixel edges, including odd-length and empty waveforms', () => {
  const peaks = Array.from({ length: 200003 }, (_, i) => ((i * 7919) % 104729) / 104729);
  peaks[150001] = 1;
  const { levels, maximum } = peakEnvelope(peaks);
  expect(maximum).toBe(1);
  const ranges = [
    [0, 200003],
    [150001, 150002],
    [150002, 150003],
    [-50, 11],
    [200000, 300000],
    [0, 0],
  ];
  for (let i = 0; i < 60; i++) ranges.push([i * 3119, i * 3119 + i * 117 + 1]);
  for (const [start, end] of ranges) {
    const expected = peaks
      .slice(Math.max(0, start), Math.min(peaks.length, end))
      .reduce((a, b) => Math.max(a, b), 0);
    expect(peakInRange(levels, start, end)).toBe(expected);
  }
  expect(peakEnvelope([]).maximum).toBe(0.001);
  expect(peakInRange(peakEnvelope([]).levels, 0, 20)).toBe(0);
});
it('does not scan the whole waveform to draw a wide column or an out-of-media area', () => {
  const envelope = peakEnvelope(Array.from({ length: 200000 }, (_, i) => (i === 180000 ? 1 : 0.1)));
  let reads = 0;
  const levels = envelope.levels.map(
    (level) =>
      new Proxy(level, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
          return Reflect.get(target, key, receiver);
        },
      }),
  );
  expect(peakInRange(levels, 123, 199999)).toBe(1);
  expect(reads).toBeLessThan(40);
  reads = 0;
  expect(peakInRange(levels, 250000, 260000)).toBe(0);
  expect(reads).toBe(0);
});
