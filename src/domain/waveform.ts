export interface Waveform {
  durationMs: number;
  stepMs: number;
  peaks: number[];
  audioStreamIndex: number;
}
export function audioPeaks(samples: Float32Array, sampleRate: number): Waveform {
  const durationMs = Math.round((samples.length / sampleRate) * 1000);
  const stepMs = Math.max(20, Math.ceil(durationMs / 200_000));
  const bin = Math.max(1, Math.round((stepMs * sampleRate) / 1000));
  const peaks: number[] = [];
  for (let i = 0; i < samples.length; i += bin) {
    let peak = 0;
    for (let j = i; j < Math.min(i + bin, samples.length); j++)
      peak = Math.max(peak, Math.abs(samples[j]));
    peaks.push(Math.min(1, peak));
  }
  return { durationMs, stepMs, peaks, audioStreamIndex: 0 };
}
