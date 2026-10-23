import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

function processor() {
  const messages = [];
  class Base { port = { onmessage: null, postMessage: data => messages.push(structuredClone(data)) }; }
  let Constructor;
  runInNewContext(readFileSync(new URL('../../public/audio-meter.worklet.js', import.meta.url), 'utf8'), { AudioWorkletProcessor: Base, sampleRate: 48000, registerProcessor: (_name, type) => { Constructor = type; } });
  const meter = new Constructor();
  const active = (enabled, epoch = 1) => meter.port.onmessage({ data: { active: enabled, epoch } });
  return { meter, messages, active };
}
it('captures a single negative sample above full scale across a complete window without changing the input', () => {
  const { meter, messages, active } = processor(); active(true);
  const left = new Float32Array(128), right = new Float32Array(128);
  left[17] = -1.25; right[17] = 1.25;
  const before = left.slice();
  meter.process([[left, right]]);
  for (let i = 0; i < 18; i++) meter.process([[new Float32Array(128), new Float32Array(128)]]);
  expect(messages).toHaveLength(1);
  expect(messages[0].peak).toEqual([1.25, 1.25]);
  expect(messages[0].rms[0]).toBeCloseTo(Math.sqrt(1.25 ** 2 / 2432));
  expect(left).toEqual(before);
});
it('never downmixes opposite stereo phases and computes RMS on every frame', () => {
  const { meter, messages, active } = processor(); active(true);
  for (let i = 0; i < 19; i++) meter.process([[new Float32Array(128).fill(.5), new Float32Array(128).fill(-.5)]]);
  expect(messages[0].peak).toEqual([.5, .5]);
  expect(messages[0].rms).toEqual([.5, .5]);
});
it('stops reporting while paused and discards an old window when playback or seeking changes epochs', () => {
  const { meter, messages, active } = processor();
  for (let i = 0; i < 25; i++) meter.process([[new Float32Array(128).fill(2)]]);
  expect(messages).toHaveLength(0);
  active(true, 1); meter.process([[new Float32Array(128).fill(2)]]);
  active(false, 2); active(true, 3);
  for (let i = 0; i < 19; i++) meter.process([[new Float32Array(128).fill(.25)]]);
  expect(messages).toHaveLength(1);
  expect(messages[0].epoch).toBe(3);
  expect(messages[0].peak).toEqual([.25, 0]);
});
