import { expect, it, vi } from 'vitest';
import { AudioLevelStore, amplitudeDb, METER_FLOOR, MIX_METER } from './audioLevels';

function ready() {
  const store = new AudioLevelStore();
  store.configure(['voice', 'music']);
  store.status('ready');
  store.playing(true);
  return store;
}
it('reports dBFS without clipping float samples above full scale and keeps stereo channels independent', () => {
  const store = ready();
  store.ingest('voice', [2, 0.5], [1, 0.25]);
  const level = store.getSnapshot().tracks.voice;
  expect(level.clipped).toBe(true);
  expect(level.channels[0].peakDb).toBeCloseTo(6.0206);
  expect(level.channels[1].peakDb).toBeCloseTo(-6.0206);
  expect(level.channels[1].rmsDb).toBeCloseTo(-12.0412);
  expect(store.getSnapshot().tracks[MIX_METER].clipped).toBe(false);
  expect(amplitudeDb(0)).toBe(METER_FLOOR);
  expect(amplitudeDb(NaN)).toBe(METER_FLOOR);
});
it('latches even exact full-scale transients, retains maxima during silence/pause and resets independently', () => {
  const store = ready();
  store.ingest('voice', [1, 0], [0.01, 0]);
  store.ingest('music', [1.5, 0], [0.1, 0]);
  store.ingest('voice', [0, 0], [0, 0]);
  expect(store.getSnapshot().tracks.voice.clipped).toBe(true);
  expect(store.getSnapshot().tracks.voice.channels[0].maxDb).toBe(0);
  store.playing(false);
  store.ingest('voice', [3, 3], [1, 1]);
  expect(store.getSnapshot().tracks.voice.channels[0].peakDb).toBe(METER_FLOOR);
  store.reset('voice');
  expect(store.getSnapshot().tracks.voice.clipped).toBe(false);
  expect(store.getSnapshot().tracks.music.clipped).toBe(true);
  store.reset();
  expect(Object.values(store.getSnapshot().tracks).every((v) => !v.clipped)).toBe(true);
});
it('ignores malformed or removed measurements and notifies only meter subscribers', () => {
  const store = ready(),
    listener = vi.fn(),
    unsubscribe = store.subscribe(listener);
  store.ingest('voice', [NaN, 1], [0, 0]);
  store.ingest('voice', [1], [0, 0]);
  store.ingest('missing', [1, 1], [0, 0]);
  expect(listener).not.toHaveBeenCalled();
  store.ingest('voice', [0.1, 0.1], [0.05, 0.05]);
  expect(listener).toHaveBeenCalledTimes(1);
  const music = store.getSnapshot().tracks.music;
  store.configure(['music']);
  expect(store.getSnapshot().tracks.voice).toBeUndefined();
  expect(store.getSnapshot().tracks.music).toBe(music);
  unsubscribe();
  store.reset();
  expect(listener).toHaveBeenCalledTimes(2);
});
it('keeps a new media graph alive when an old graph finishes deferred disposal', () => {
  const store = ready(),
    oldGraph = {},
    newGraph = {};
  store.claim(oldGraph);
  store.claim(newGraph);
  store.configure(['new']);
  store.status('ready');
  store.release(oldGraph);
  expect(store.getSnapshot().status).toBe('ready');
  expect(store.getSnapshot().tracks.new).toBeDefined();
  store.release(newGraph);
  expect(store.getSnapshot().status).toBe('idle');
  expect(store.getSnapshot().tracks).toEqual({});
});
