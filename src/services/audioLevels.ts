export const METER_FLOOR = -96;
export const MIX_METER = '$mix';
export type ChannelLevel = { peakDb: number; rmsDb: number; maxDb: number };
export type AudioLevel = { channels: ChannelLevel[]; clipped: boolean };
export type AudioLevels = {
  status: 'idle' | 'starting' | 'ready' | 'unavailable';
  playing: boolean;
  sampledAtMs: number | null;
  tracks: Record<string, AudioLevel>;
};
const silentChannel = (): ChannelLevel => ({
  peakDb: METER_FLOOR,
  rmsDb: METER_FLOOR,
  maxDb: METER_FLOOR,
});
const silent = (): AudioLevel => ({ channels: [silentChannel(), silentChannel()], clipped: false });
export const amplitudeDb = (value: number) =>
  Number.isFinite(value) && value > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(value)) : METER_FLOOR;

// Only meter consumers subscribe. Playback measurements never update project
// JSON, history, autosave or the entire editor on every audio frame.
export class AudioLevelStore {
  private value: AudioLevels = { status: 'idle', playing: false, sampledAtMs: null, tracks: {} };
  private listeners = new Set<() => void>();
  private owner: object | null = null;
  claim(owner: object) {
    this.owner = owner;
    this.clear();
  }
  release(owner: object) {
    if (this.owner === owner) {
      this.owner = null;
      this.clear();
    }
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: AudioLevels) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  configure(ids: string[]) {
    const keys = [...new Set([MIX_METER, ...ids])];
    if (
      keys.length === Object.keys(this.value.tracks).length &&
      keys.every((id) => id in this.value.tracks)
    )
      return;
    this.publish({
      ...this.value,
      tracks: Object.fromEntries(keys.map((id) => [id, this.value.tracks[id] ?? silent()])),
    });
  }
  status(status: AudioLevels['status']) {
    if (status === 'unavailable') this.playing(false);
    if (status !== this.value.status) this.publish({ ...this.value, status });
  }
  playing(playing: boolean) {
    if (playing === this.value.playing) return;
    this.publish({
      ...this.value,
      playing,
      tracks: Object.fromEntries(
        Object.entries(this.value.tracks).map(([id, level]) => [
          id,
          {
            ...level,
            channels: level.channels.map((c) => ({
              ...c,
              peakDb: METER_FLOOR,
              rmsDb: METER_FLOOR,
            })),
          },
        ]),
      ),
    });
  }
  ingest(id: string, peak: number[], rms: number[]) {
    const previous = this.value.tracks[id];
    if (
      !this.value.playing ||
      this.value.status !== 'ready' ||
      !previous ||
      peak.length !== 2 ||
      rms.length !== 2 ||
      [...peak, ...rms].some((v) => !Number.isFinite(v) || v < 0)
    )
      return;
    const level = {
      clipped: previous.clipped || peak.some((v) => v >= 1),
      channels: peak.map((p, i) => ({
        peakDb: amplitudeDb(p),
        rmsDb: amplitudeDb(rms[i]),
        maxDb: Math.max(previous.channels[i].maxDb, amplitudeDb(p)),
      })),
    };
    this.publish({
      ...this.value,
      sampledAtMs: Date.now(),
      tracks: { ...this.value.tracks, [id]: level },
    });
  }
  reset(id?: string) {
    this.publish({
      ...this.value,
      tracks: Object.fromEntries(
        Object.entries(this.value.tracks).map(([key, value]) => [
          key,
          id && key !== id
            ? value
            : {
                ...value,
                clipped: false,
                channels: value.channels.map((c) => ({ ...c, maxDb: c.peakDb })),
              },
        ]),
      ),
    });
  }
  clear() {
    this.publish({ status: 'idle', playing: false, sampledAtMs: null, tracks: {} });
  }
}

type Tap = { input: GainNode; meter: AudioWorkletNode; epoch: number };
export class AudioMeterRouter {
  readonly master: GainNode;
  readonly monitor: GainNode;
  private outputs = new Map<string, GainNode>();
  private taps = new Map<string, Tap>();
  private ready = false;
  private disposed = false;
  private active = false;
  private failed = false;
  constructor(
    private context: AudioContext,
    readonly store: AudioLevelStore,
  ) {
    this.master = this.stereoGain();
    this.monitor = this.stereoGain();
    this.monitor.gain.value = 0;
    this.master.connect(this.monitor).connect(context.destination);
    store.claim(this);
    store.status('starting');
    void Promise.resolve()
      .then(() =>
        context.audioWorklet.addModule(new URL('audio-meter.worklet.js', document.baseURI).href),
      )
      .then(() => {
        if (this.disposed) return;
        this.ready = true;
        this.tap(MIX_METER, this.master);
        for (const [id, output] of this.outputs) this.tap(id, output);
        store.status(this.failed ? 'unavailable' : 'ready');
      })
      .catch(() => {
        if (!this.disposed) store.status('unavailable');
      });
  }
  private stereoGain() {
    const node = this.context.createGain();
    node.channelCount = 2;
    node.channelCountMode = 'explicit';
    return node;
  }
  output(id: string) {
    let node = this.outputs.get(id);
    if (!node) {
      node = this.stereoGain();
      node.connect(this.master);
      this.outputs.set(id, node);
      if (this.ready) this.tap(id, node);
    }
    return node;
  }
  configure(ids: string[]) {
    for (const id of ids) this.output(id);
    for (const [id, output] of this.outputs)
      if (!ids.includes(id)) {
        const tap = this.taps.get(id);
        if (tap) {
          tap.meter.port.onmessage = null;
          tap.meter.port.close();
          tap.meter.disconnect();
          this.taps.delete(id);
        }
        output.disconnect();
        this.outputs.delete(id);
      }
    this.store.configure(ids);
  }
  private tap(id: string, input: GainNode) {
    try {
      const meter = new AudioWorkletNode(this.context, 'studio-audio-meter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
      });
      const tap = { input, meter, epoch: 0 };
      this.taps.set(id, tap);
      meter.port.onmessage = ({ data }) => {
        if (
          !this.disposed &&
          data.epoch === tap.epoch &&
          Array.isArray(data.peak) &&
          Array.isArray(data.rms)
        )
          this.store.ingest(id, data.peak, data.rms);
      };
      meter.onprocessorerror = () => {
        this.failed = true;
        if (!this.disposed) this.store.status('unavailable');
      };
      input.connect(meter);
      meter.connect(this.context.destination);
      meter.port.postMessage({ epoch: tap.epoch, active: this.active });
    } catch {
      this.failed = true;
      this.store.status('unavailable');
    }
  }
  playing(active: boolean) {
    if (active !== this.active) {
      this.active = active;
      for (const tap of this.taps.values())
        tap.meter.port.postMessage({ epoch: ++tap.epoch, active });
    }
    this.store.playing(active);
  }
  dispose() {
    this.disposed = true;
    for (const { input, meter } of this.taps.values()) {
      input.disconnect(meter);
      meter.port.onmessage = null;
      meter.port.close();
      meter.disconnect();
    }
    for (const output of this.outputs.values()) output.disconnect();
    this.taps.clear();
    this.outputs.clear();
    this.master.disconnect();
    this.monitor.disconnect();
    this.store.release(this);
  }
}
