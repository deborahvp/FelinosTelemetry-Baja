// Run stopwatch: manual start/stop (button or space bar) plus the automatic launch times the
// vehicle measured meanwhile (VG-04 100 ft / VG-06 150 ft). Pure logic, no DOM.
//
// Human reaction adds ~0.2 s to a manual time; the automatic time comes from the phone's
// IMU + GPS, so for acceleration and climb tests both are shown side by side.

/** Phone and laptop clocks differ slightly; accept launches starting a bit before "Start". */
export const CLOCK_SLACK_S = 3;

export class Stopwatch {
  constructor() {
    this.reset();
  }

  reset() {
    this.startMs = null;
    this.stopMs = null;
  }

  get running() {
    return this.startMs !== null && this.stopMs === null;
  }

  get stopped() {
    return this.startMs !== null && this.stopMs !== null;
  }

  start(nowMs) {
    this.startMs = nowMs;
    this.stopMs = null;
  }

  /** Stop and return the result, or null if it was not running. */
  stop(nowMs) {
    if (!this.running) return null;
    this.stopMs = nowMs;
    return { startMs: this.startMs, stopMs: this.stopMs, manualS: (this.stopMs - this.startMs) / 1000 };
  }

  /** Start ↔ stop (space bar / main button). Returns the result when it stops. */
  toggle(nowMs) {
    if (this.running) return this.stop(nowMs);
    this.start(nowMs);
    return null;
  }

  elapsedS(nowMs) {
    if (this.startMs === null) return 0;
    return ((this.stopMs ?? nowMs) - this.startMs) / 1000;
  }
}

/**
 * Automatic times for the stopwatch window: the latest launch (finished attempt or the one in
 * progress) that started between `startMs` (minus clock slack) and `endMs`.
 * @returns {{t100: number|null, t150: number|null, measuring: boolean} | null}
 */
export function autoTimes(attempts, live, startMs, endMs) {
  if (startMs === null) return null;
  const from = startMs / 1000 - CLOCK_SLACK_S;
  const to = endMs / 1000 + CLOCK_SLACK_S;
  const inWindow = (a) => a && a.t >= from && a.t <= to;
  if (inWindow(live)) return { t100: live.t100, t150: live.t150, measuring: true };
  const done = (attempts ?? []).filter(inWindow);
  if (!done.length) return null;
  const last = done[done.length - 1];
  return { t100: last.t100 ?? null, t150: last.t150 ?? null, measuring: false };
}

/** mm:ss.cc for the big display. */
export function formatStopwatch(seconds) {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}
