// Strudel's .midi() and .osc(), sent through the backend: WebKitGTK has no
// WebMIDI, and strudel.cc's OSC needs a Node bridge. Each event goes with how
// far ahead it should sound, so Rust can send it on time (src-tauri/src/midi.rs,
// osc.rs).

import { noteToMidi, Pattern } from '@strudel/core';
import { getAudioContext } from '@strudel/webaudio';

import * as ipc from '$lib/ipc';
import { addLog } from '$lib/log.svelte';

/** How long audio takes to reach the speakers, so MIDI lines up with it. */
function outputLatencyMs() {
  const ctx = getAudioContext() as AudioContext;
  return ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
}

// One log line per distinct failure, not one per note.
let lastFailure = '';
function report(source: string, err: unknown) {
  const message = `${err}`;
  if (message === lastFailure) return;
  lastFailure = message;
  addLog(source, message, 'error');
  setTimeout(() => lastFailure === message && (lastFailure = ''), 5000);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const midiNumber = (note: unknown) => (typeof note === 'number' ? note : noteToMidi(String(note)));

/** The MIDI messages for one event: program, CC, then note on and off. */
export function midiMessages(value: Record<string, any>, durationMs: number, delayMs: number): ipc.TimedMidi[] {
  const channel = clamp(Math.round(Number(value.midichan ?? 1)) - 1, 0, 15);
  const out: ipc.TimedMidi[] = [];
  if (value.progNum !== undefined) out.push({ delayMs, bytes: [0xc0 | channel, clamp(Math.round(value.progNum), 0, 127)] });
  if (value.ccn !== undefined && value.ccv !== undefined) {
    const cc = clamp(Math.round(value.ccn), 0, 127);
    out.push({ delayMs, bytes: [0xb0 | channel, cc, clamp(Math.round(value.ccv * 127), 0, 127)] });
  }
  if (value.note !== undefined) {
    const note = clamp(Math.round(midiNumber(value.note)), 0, 127);
    const velocity = clamp(Math.round((value.velocity ?? 0.9) * (value.gain ?? 1) * 127), 1, 127);
    out.push({ delayMs, bytes: [0x90 | channel, note, velocity] });
    // Off a hair early, so a repeated note's off doesn't cut the next on.
    out.push({ delayMs: delayMs + Math.max(1, durationMs - 10), bytes: [0x80 | channel, note, 0] });
  }
  return out;
}

/** The `/dirt/play` arguments for one event, as SuperDirt expects them. */
export function oscArgs(value: Record<string, any>, cps: number, cycle: number, deltaSeconds: number): (string | number)[] {
  const controls: Record<string, unknown> = { cps, cycle, delta: deltaSeconds, ...value };
  // Strudel's note is a MIDI number; SuperDirt's `note` counts from middle C, so send midinote.
  if (controls.note !== undefined) {
    controls.midinote = midiNumber(controls.note);
    delete controls.note;
  }
  return Object.entries(controls).flatMap(([key, v]) => [key, typeof v === 'number' || typeof v === 'string' ? v : String(v)]);
}

let installed = false;

/** Adds .midi() and .osc() to patterns (once, after Strudel's modules load). */
export function installOutputs() {
  if (installed) return;
  installed = true;
  const proto = Pattern.prototype as any;

  /** Plays notes (and CCs, program changes) on a MIDI output, by name or part of one. */
  proto.midi = function (output?: string) {
    return this.onTrigger((hap: any, currentTime: number, cps: number, targetTime: number) => {
      const value = hap.value && typeof hap.value === 'object' ? hap.value : { note: hap.value };
      const port = typeof output === 'string' ? output : (value.midiport ?? '');
      const delay = (targetTime - currentTime) * 1000 + outputLatencyMs();
      const duration = (hap.duration.valueOf() / cps) * 1000;
      const messages = midiMessages(value, duration, delay);
      if (messages.length) ipc.midiSend(String(port), messages).catch((err) => report('strudel', `MIDI: ${err}`));
    });
  };

  /** Sends each event to SuperDirt (or the OSC target in settings) as /dirt/play. */
  proto.osc = function (address = '/dirt/play') {
    return this.onTrigger((hap: any, currentTime: number, cps: number, targetTime: number) => {
      hap.ensureObjectValue();
      const value = hap.value;
      const target = value.oscport ? `127.0.0.1:${value.oscport}` : null;
      const args = oscArgs(value, cps, hap.wholeOrPart().begin.valueOf(), hap.duration.valueOf() / cps);
      const delay = (targetTime - currentTime) * 1000 + outputLatencyMs();
      ipc.oscSend(target, address, args, delay).catch((err) => report('strudel', `OSC: ${err}`));
    });
  };
}
