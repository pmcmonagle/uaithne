// Inserts Uaithne's master GainNode between superdough and the speakers, with
// a unity-gain input node in front of it that recording taps (so recordings
// don't follow the volume slider).
//
// superdough routes everything through SuperdoughOutput.destinationGain →
// ctx.destination, and rebuilds that pair on resetGlobalEffects(). The class
// isn't exported from the bundled dist, so we patch it through an instance.

import { getSuperdoughAudioController, setAudioContext } from '@strudel/webaudio';

/**
 * WebKitGTK reports destination.maxChannelCount as 0, even while running.
 * superdough copies it into channelCount (which rejects 0) and sizes its
 * output merger from it. Patch the prototype rather than the instance:
 * WebKit can recreate a node's JS wrapper and drop instance properties.
 */
function patchWebKitDestination() {
  const proto = AudioDestinationNode.prototype;
  const max = Object.getOwnPropertyDescriptor(proto, 'maxChannelCount');
  if (!max?.get || (proto as { uaithnePatched?: boolean }).uaithnePatched) return;
  Object.defineProperty(proto, 'uaithnePatched', { value: true });
  Object.defineProperty(proto, 'maxChannelCount', {
    get(this: AudioDestinationNode) {
      return max.get!.call(this) || 2;
    },
    configurable: true,
  });
  let count: PropertyDescriptor | undefined;
  for (let p: object | null = proto; p && !count; p = Object.getPrototypeOf(p)) {
    count = Object.getOwnPropertyDescriptor(p, 'channelCount');
  }
  if (count?.get && count.set) {
    Object.defineProperty(proto, 'channelCount', {
      get(this: AudioDestinationNode) {
        return count.get!.call(this);
      },
      set(this: AudioDestinationNode, n: number) {
        try {
          count.set!.call(this, n);
        } catch {
          // WebKit rejects counts above its (zero) max; keep the stereo default
        }
      },
      configurable: true,
    });
  }
}

/** Creates the shared AudioContext (one per page, even if this module re-runs). */
export function createAudioContext(): AudioContext {
  patchWebKitDestination();
  const w = window as { uaithneAudioContext?: AudioContext };
  w.uaithneAudioContext ??= new AudioContext({ latencyHint: 'interactive' });
  return setAudioContext(w.uaithneAudioContext);
}

export interface Master {
  /** Everything superdough plays, before the volume. */
  input: GainNode;
  /** The volume control, connected to the speakers. */
  gain: GainNode;
}

export function installMasterGain(ctx: AudioContext): Master {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  const input = ctx.createGain();
  input.connect(master);

  const output = getSuperdoughAudioController().output;
  const proto = Object.getPrototypeOf(output);
  const initializeAudio = proto.initializeAudio;
  proto.initializeAudio = function (this: { destinationGain: GainNode }) {
    initializeAudio.call(this);
    this.destinationGain.disconnect();
    this.destinationGain.connect(input);
  };

  output.destinationGain.disconnect();
  output.destinationGain.connect(input);
  return { input, gain: master };
}
