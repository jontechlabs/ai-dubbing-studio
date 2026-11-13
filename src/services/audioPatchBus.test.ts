import { expect, it, vi } from 'vitest';
import { AudioPatchBus } from './audioPatchBus';
import { demoProject } from '../domain/project';
vi.mock('./bridge', () => ({ audioPatchUrl: vi.fn(async () => 'local-fragment.wav') }));
it('adjacent long-track fragments meet on the same audio clock despite video-tick jitter', async () => {
  const starts: number[][] = [];
  const gain = {
    gain: { value: 0, cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() },
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  gain.connect.mockReturnValue(gain);
  const context = {
    currentTime: 10,
    sampleRate: 48000,
    decodeAudioData: vi.fn(async () => ({ duration: 30, length: 1440000, numberOfChannels: 2 })),
    createGain: () => gain,
    createBufferSource: () => ({
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect: () => gain,
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: (...args: number[]) => starts.push(args),
    }),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
  const p = demoProject();
  p.formatVersion = 28;
  p.media!.durationMs = 180000;
  p.tracks = [
    { id: 'original', kind: 'original', language: 'ja', mute: false, solo: false, gain: 1 },
  ];
  p.generations = [
    {
      kind: 'audioPatch',
      id: 'long',
      operationId: 'op',
      operation: 'leveling',
      sourcePath: p.media!.path,
      trackId: 'original',
      sourceTrackId: 'original',
      startMs: 0,
      endMs: 180000,
      mode: 'replace',
      path: 'stems/patch-long.wav',
      gain: 1,
    },
  ];
  const bus = new AudioPatchBus(
    context as unknown as AudioContext,
    vi.fn(),
    () => gain as unknown as AudioNode,
  );
  const video = {
    paused: false,
    seeking: false,
    readyState: 4,
    currentTime: 29.5,
    playbackRate: 1,
  };
  try {
    await bus.prepare(p, 29500, 1);
    bus.tick(p, video as HTMLVideoElement, 1);
    expect(starts).toHaveLength(1);
    context.currentTime = 10.2;
    video.currentTime = 29.71; // 10 ms video-clock jitter, below resync threshold
    bus.tick(p, video as HTMLVideoElement, 1);
    expect(starts).toHaveLength(2);
    expect(starts[1][0]).toBeCloseTo(starts[0][0] + starts[0][2], 10);
    expect(starts[1][0]).toBe(10.5);
    expect(starts[1][1]).toBe(0);
    video.paused = true;
    bus.tick(p, video as HTMLVideoElement, 1);
  } finally {
    bus.dispose();
    vi.unstubAllGlobals();
  }
});
