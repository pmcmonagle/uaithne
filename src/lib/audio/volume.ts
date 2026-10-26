// Global volume. The slider position goes through one taper here so every
// engine receives the same gain for the same position.

/** Slider position (0..1) to linear gain, using an x² taper. */
export function taper(position: number): number {
  const p = Math.min(1, Math.max(0, position));
  return p * p;
}

/** Linear gain to dB, for engines (SuperCollider) that take decibels. */
export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}
