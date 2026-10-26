// Taps an audio node with an AudioWorklet and streams what it hears to the
// backend (record_chunk), which writes the WAV. Chunks are interleaved
// 32-bit float stereo, about a quarter of a second each.

import * as ipc from '$lib/ipc';

const PROCESSOR = `
class UaithneTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = Math.round(sampleRate / 4);
    this.buffer = new Float32Array(this.frames * 2);
    this.at = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') this.send(true);
    };
  }
  send(last) {
    const chunk = this.buffer.slice(0, this.at * 2);
    this.at = 0;
    this.port.postMessage({ chunk, last }, [chunk.buffer]);
  }
  process(inputs) {
    const input = inputs[0];
    const left = input[0];
    if (!left) return true;
    const right = input[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.buffer[this.at * 2] = left[i];
      this.buffer[this.at * 2 + 1] = right[i];
      if (++this.at === this.frames) this.send(false);
    }
    return true;
  }
}
registerProcessor('uaithne-tap', UaithneTap);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

function loadProcessor(ctx: BaseAudioContext) {
  let promise = loaded.get(ctx);
  if (!promise) {
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'application/javascript' }));
    promise = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, promise);
  }
  return promise;
}

export class Tap {
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  /** Chunks sent and not yet acknowledged, so stop() can wait for them. */
  private sending: Promise<unknown> = Promise.resolve();
  private flushed: (() => void) | null = null;

  /** Starts streaming `source` to the recording the backend has open. */
  async start(source: AudioNode) {
    const ctx = source.context;
    await loadProcessor(ctx);
    this.node = new AudioWorkletNode(ctx, 'uaithne-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (e: MessageEvent<{ chunk: Float32Array; last: boolean }>) => {
      const { chunk, last } = e.data;
      if (chunk.length) {
        const bytes = new Uint8Array(chunk.buffer);
        this.sending = this.sending.then(() => ipc.recordChunk(bytes)).catch(() => {});
      }
      if (last) this.flushed?.();
    };
    // A worklet only runs while connected towards the speakers; this one adds silence.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    source.connect(this.node);
    this.node.connect(this.sink);
    this.sink.connect(ctx.destination);
  }

  /** Stops tapping, sending what's buffered first. */
  async stop() {
    const node = this.node;
    if (!node) return;
    await new Promise<void>((resolve) => {
      this.flushed = resolve;
      node.port.postMessage('flush');
      setTimeout(resolve, 500); // in case the audio thread is stopped
    });
    this.flushed = null;
    node.disconnect();
    this.sink?.disconnect();
    this.node = null;
    this.sink = null;
    await this.sending;
  }
}
