// Phone axes → vehicle axes (ISO 8855: x forward, y left, z up). Pure functions, no DOM.
//
// The phone is rigidly mounted, so the vehicle axes expressed in phone coordinates are
// constant. They are computed once from a gravity reference taken while the vehicle is
// level (first seconds of a session, or the "Set level" button):
//   u = up (from gravity), f = nominal longitudinal axis projected onto the horizontal plane,
//   l = u × f (left).
// Live values are then simple dot products. This is an approximation for monitoring;
// the rigorous version lives in Python (processing/frames.py, v0.2).

export const G0 = 9.80665;
const IDX = { x: 0, y: 1, z: 2 };
const AXES = ['longitudinal', 'lateral', 'vertical'];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a); return n > 1e-9 ? scale(a, 1 / n) : null; };
const clamp1 = (v) => Math.max(-1, Math.min(1, v));
const DEG = 180 / Math.PI;

/** {x: '-lateral', ...} → {longitudinal: [0,0,-1]-style unit vectors in phone coords}. */
export function parseAxisMap(map) {
  const out = {};
  for (const phoneAxis of ['x', 'y', 'z']) {
    const raw = String(map?.[phoneAxis] ?? '').trim();
    const sign = raw.startsWith('-') ? -1 : 1;
    const target = raw.replace(/^[+-]/, '');
    if (!AXES.includes(target)) throw new Error(`axisMap.${phoneAxis}: "${raw}" is not a vehicle axis`);
    if (out[target]) throw new Error(`axisMap: "${target}" is mapped twice`);
    const v = [0, 0, 0];
    v[IDX[phoneAxis]] = sign;
    out[target] = v;
  }
  return out;
}

/** Vehicle frame {f, l, u} in phone coordinates from a gravity sample. */
export function frameFromGravity(gravity, axes) {
  let u = unit(gravity);
  if (!u) return null;
  // Sign-agnostic: Android reports gravity pointing up, other platforms may not.
  if (dot(u, axes.vertical) < 0) u = scale(u, -1);
  const f = unit(sub(axes.longitudinal, scale(u, dot(axes.longitudinal, u))));
  if (!f) return null; // longitudinal axis is vertical: bad axisMap
  return { f, l: cross(u, f), u };
}

/** Project a phone-frame vector onto the vehicle frame. */
export function toVehicle(v, frame) {
  return { long: dot(v, frame.f), lat: dot(v, frame.l), vert: dot(v, frame.u) };
}

/** Pitch (grade, nose up +) and roll (left side up −) in degrees from the current gravity. */
export function attitude(gravity, frame) {
  let up = unit(gravity);
  if (!up) return { pitch: NaN, roll: NaN };
  if (dot(up, frame.u) < 0) up = scale(up, -1);
  return { pitch: Math.asin(clamp1(dot(up, frame.f))) * DEG, roll: Math.asin(clamp1(dot(up, frame.l))) * DEG };
}

/** Averages gravity over a time span to build a stable level reference. */
export class LevelReference {
  constructor(spanSeconds = 5) {
    this.span = spanSeconds;
    this.reset();
  }
  reset() {
    this.sum = [0, 0, 0];
    this.n = 0;
    this.t0 = null;
    this.gravity = null;
  }
  /** Feed a gravity sample; returns true when the reference has just been fixed. */
  add(t, g) {
    if (this.gravity) return false;
    if (this.t0 === null) this.t0 = t;
    this.sum = [this.sum[0] + g[0], this.sum[1] + g[1], this.sum[2] + g[2]];
    this.n += 1;
    if (t - this.t0 >= this.span) {
      this.gravity = scale(this.sum, 1 / this.n);
      return true;
    }
    return false;
  }
  /** Current best estimate (final if fixed, running mean otherwise). */
  current() {
    return this.gravity ?? (this.n ? scale(this.sum, 1 / this.n) : null);
  }
}

export const toG = (ms2) => ms2 / G0;
export const toKmh = (ms) => ms * 3.6;
export const toDeg = (rad) => rad * DEG;
