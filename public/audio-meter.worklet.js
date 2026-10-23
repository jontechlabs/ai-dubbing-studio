// Parallel measurement only: the audible signal never passes through this node.
// Aggregate every render quantum so short transients and opposite stereo phases
// cannot disappear between UI frames. No audio samples leave this worklet.
class StudioAudioMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.epoch = 0;
    this.active = false;
    this.clear();
    this.port.onmessage = ({ data }) => {
      this.epoch = data.epoch;
      this.active = data.active;
      this.clear();
    };
  }
  clear() {
    this.peaks = [0, 0];
    this.squares = [0, 0];
    this.frames = 0;
  }
  process(inputs) {
    if (!this.active) return true;
    const channels = inputs[0];
    const frames = channels[0]?.length ?? 128;
    for (let channel = 0; channel < 2; channel++) {
      const data = channels[channel];
      if (!data) continue;
      let peak = this.peaks[channel], sum = this.squares[channel];
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (!Number.isFinite(value)) continue;
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
      }
      this.peaks[channel] = peak;
      this.squares[channel] = sum;
    }
    this.frames += frames;
    if (this.frames >= sampleRate / 20) {
      this.port.postMessage({
        epoch: this.epoch,
        peak: this.peaks,
        rms: this.squares.map(sum => Math.sqrt(sum / this.frames)),
      });
      this.clear();
    }
    // Output buffers stay zero. The parallel tap cannot alter playback.
    return true;
  }
}
registerProcessor('studio-audio-meter', StudioAudioMeter);
