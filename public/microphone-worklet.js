// Local PCM capture, downmixed by Web Audio before this processor. No network.
class StudioMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(4096);
    this.used = 0;
    this.total = 0;
    this.done = false;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.finish(); };
  }
  flush() {
    if (this.used) this.port.postMessage({ samples: this.chunk.slice(0, this.used) });
    this.used = 0;
  }
  finish() {
    if (this.done) return;
    this.done = true;
    this.flush();
    this.port.postMessage({ done: true });
  }
  process(inputs) {
    if (this.done) return false;
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.chunk[this.used++] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
      this.total++;
      if (this.used === this.chunk.length) this.flush();
      if (this.total >= sampleRate * 120) { this.finish(); return false; }
    }
    return true;
  }
}
registerProcessor('studio-microphone', StudioMicrophone);
