import type { Project, Dialogue } from '../domain/types';
import { spokenText } from '../domain/tts';
export const MIC_RATE = 24000;
export const MIC_MAX_MS = 120000;
export interface MicrophoneState {
  phase: 'idle' | 'requesting' | 'recording' | 'ready' | 'saving';
  projectId: string | null;
  lineId: string | null;
  durationMs: number;
  level: number;
  clipped: boolean;
  url: string;
  error: string | null;
  errorDetail: string | null;
}
let state: MicrophoneState = {
  phase: 'idle',
  projectId: null,
  lineId: null,
  durationMs: 0,
  level: 0,
  clipped: false,
  url: '',
  error: null,
  errorDetail: null,
};
const listeners = new Set<() => void>();
export const readMicrophone = () => state;
export function subscribeMicrophone(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function update(change: Partial<MicrophoneState>) {
  state = { ...state, ...change };
  listeners.forEach((f) => f());
}
let stream: MediaStream | null = null,
  context: AudioContext | null = null,
  node: AudioWorkletNode | null = null;
let chunks: Float32Array[] = [],
  wav: ArrayBuffer | null = null,
  epoch = 0,
  basis = '';
let finish: (() => void) | null = null;
let stopping: Promise<void> | null = null;
export function microphoneBasis(p: Project, line: Dialogue) {
  return JSON.stringify([
    p.id,
    p.languages.target,
    p.media?.path ?? null,
    line.id,
    line.startMs,
    line.endMs,
    line.characterId,
    spokenText(p, line),
  ]);
}
export function encodeMicrophone(samples: Float32Array): ArrayBuffer {
  if (samples.length < MIC_RATE * 0.15 || samples.length > MIC_RATE * 120)
    throw Error('MIC_INVALID_AUDIO');
  const buffer = new ArrayBuffer(44 + samples.length * 2),
    v = new DataView(buffer);
  const text = (at: number, value: string) =>
    [...value].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, MIC_RATE, true);
  v.setUint32(28, MIC_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    if (!Number.isFinite(sample)) throw Error('MIC_INVALID_AUDIO');
    const value = Math.max(-1, Math.min(1, sample));
    v.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  });
  return buffer;
}
function release() {
  node?.disconnect();
  node = null;
  stream?.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
  stream = null;
  if (context) void context.close().catch(() => {});
  context = null;
}
export function discardMicrophone() {
  if (state.phase === 'saving') throw Error('BUSY');
  epoch++;
  release();
  chunks = [];
  wav = null;
  basis = '';
  finish?.();
  finish = null;
  if (state.url) URL.revokeObjectURL(state.url);
  update({
    phase: 'idle',
    projectId: null,
    lineId: null,
    durationMs: 0,
    level: 0,
    clipped: false,
    url: '',
    error: null,
    errorDetail: null,
  });
}
export async function startMicrophone(project: Project, line: Dialogue, deviceId = '') {
  if (state.phase !== 'idle') throw Error('MIC_DRAFT_EXISTS');
  if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode)
    throw Error('MIC_UNAVAILABLE');
  const token = ++epoch;
  basis = microphoneBasis(project, line);
  update({
    phase: 'requesting',
    projectId: project.id,
    lineId: line.id,
    error: null,
    errorDetail: null,
    durationMs: 0,
    level: 0,
    clipped: false,
  });
  let startupStage = 'getUserMedia';
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (token !== epoch) {
      acquired.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = acquired;
    startupStage = 'AudioContext';
    context = new AudioContext({ sampleRate: MIC_RATE });
    startupStage = 'AudioContext sampleRate=' + context.sampleRate;
    if (context.sampleRate !== MIC_RATE) throw Error('MIC_UNAVAILABLE');
    startupStage = 'AudioWorklet module';
    await context.audioWorklet.addModule('/microphone-worklet.js');
    if (token !== epoch || !context) return;
    node = new AudioWorkletNode(context, 'studio-microphone', {
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    node.onprocessorerror = () => {
      if (token !== epoch) return;
      discardMicrophone();
      update({ error: 'MIC_UNAVAILABLE' });
    };
    node.port.onmessage = (event: MessageEvent<{ samples?: Float32Array; done?: boolean }>) => {
      if (token !== epoch) return;
      if (event.data.samples) {
        const samples = event.data.samples;
        chunks.push(samples);
        let peak = 0;
        for (const value of samples) peak = Math.max(peak, Math.abs(value));
        update({
          durationMs: Math.round(chunks.reduce((n, c) => n + c.length, 0) / 24),
          level: peak,
          clipped: state.clipped || peak >= 0.99,
        });
      }
      if (event.data.done) {
        release();
        try {
          const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const chunk of chunks) {
            samples.set(chunk, at);
            at += chunk.length;
          }
          chunks = [];
          wav = encodeMicrophone(samples);
          update({
            phase: 'ready',
            level: 0,
            url: URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })),
          });
        } catch {
          update({
            phase: 'idle',
            projectId: null,
            lineId: null,
            durationMs: 0,
            level: 0,
            error: 'MIC_INVALID_AUDIO',
          });
        }
        finish?.();
        finish = null;
      }
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    context.createMediaStreamSource(stream).connect(node);
    node.connect(silent);
    silent.connect(context.destination);
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        void stopMicrophone();
      };
    });
    startupStage = 'AudioContext resume';
    await context.resume();
    update({ phase: 'recording' });
  } catch (error) {
    if (token !== epoch) return;
    release();
    update({
      phase: 'idle',
      projectId: null,
      lineId: null,
      errorDetail:
        startupStage +
        ': ' +
        (error instanceof Error ? error.name + ': ' + error.message : String(error)),
      error:
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'MIC_PERMISSION_DENIED'
          : 'MIC_UNAVAILABLE',
    });
    throw Error(state.error!, { cause: error });
  }
}
export async function stopMicrophone() {
  if (stopping) return stopping;
  if (state.phase === 'requesting') {
    discardMicrophone();
    return;
  }
  if (state.phase !== 'recording' || !node) return;
  const token = epoch;
  const timer = setTimeout(() => {
    if (token === epoch && state.phase === 'recording') {
      discardMicrophone();
      update({ error: 'MIC_UNAVAILABLE' });
    }
  }, 3000);
  stopping = new Promise<void>((resolve) => {
    finish = resolve;
    node!.port.postMessage('stop');
  });
  try {
    await stopping;
  } finally {
    clearTimeout(timer);
    stopping = null;
  }
}
export async function saveMicrophone(
  project: Project,
  line: Dialogue,
  save: (bytes: ArrayBuffer) => Promise<Project>,
) {
  if (state.phase !== 'ready' || !wav) throw Error('MIC_INVALID_AUDIO');
  if (basis !== microphoneBasis(project, line)) throw Error('STALE_REVISION');
  update({ phase: 'saving', error: null });
  try {
    const result = await save(wav);
    update({ phase: 'ready' });
    discardMicrophone();
    return result;
  } catch (error) {
    update({ phase: 'ready' });
    throw error;
  }
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', () => release());
