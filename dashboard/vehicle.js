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

/**
 * Typical phone mounts (phone axes: x → right edge of the screen, y → top edge, z → out of the
 * screen; same on Android and iOS). Lateral sign does not matter: it is derived from the other two.
 */
export const MOUNT_PRESETS = {
  flat: { x: 'lateral', y: 'longitudinal', z: 'vertical' }, // lying flat, screen up, top toward the front
  right: { x: 'longitudinal', y: 'vertical', z: 'lateral' }, // upright, screen facing out on the RIGHT side
  left: { x: '-longitudinal', y: 'vertical', z: 'lateral' }, // upright, screen facing out on the LEFT side
  driver: { x: 'lateral', y: 'vertical', z: '-longitudinal' }, // upright, screen facing the driver (backward)
  front: { x: 'lateral', y: 'vertical', z: 'longitudinal' }, // upright, screen facing forward
};

/** Axis map for a preset, optionally with the forward direction inverted. */
export function presetAxisMap(preset, invertForward = false) {
  const base = MOUNT_PRESETS[preset];
  if (!base) throw new Error(`unknown mount preset "${preset}"`);
  if (!invertForward) return { ...base };
  const flip = (v) => (v.replace(/^[+-]/, '') === 'longitudinal' ? (v.startsWith('-') ? 'longitudinal' : '-longitudinal') : v);
  return { x: flip(base.x), y: flip(base.y), z: flip(base.z) };
}

/** Which preset (and inversion) an axis map corresponds to, or null for a custom map. */
export function matchPreset(axisMap) {
  const key = (m) => ['x', 'y', 'z'].map((k) => String(m?.[k] ?? '').trim().replace(/^\+/, '').replace(/^-lateral$/, 'lateral')).join(',');
  // Plain presets first: "right" inverted is the same map as "left".
  for (const invertForward of [false, true]) {
    for (const preset of Object.keys(MOUNT_PRESETS)) {
      if (key(presetAxisMap(preset, invertForward)) === key(axisMap)) return { preset, invertForward };
    }
  }
  return null;
}

/**
 * Vehicle frame {f, l, u, accelSign} in phone coordinates from a gravity sample.
 *
 * Platforms disagree on sign conventions: Android reports gravity pointing UP and linear
 * acceleration in the direction of motion; raw iOS (Core Motion) reports gravity pointing DOWN
 * and acceleration with the opposite sign. The mounted vertical axis (axisMap) tells which one
 * we got: `accelSign` is −1 for the iOS convention, so acceleration is corrected, not just gravity.
 */
export function frameFromGravity(gravity, axes) {
  let u = unit(gravity);
  if (!u) return null;
  let accelSign = 1;
  if (dot(u, axes.vertical) < 0) {
    u = scale(u, -1);
    accelSign = -1;
  }
  const f = unit(sub(axes.longitudinal, scale(u, dot(axes.longitudinal, u))));
  if (!f) return null; // longitudinal axis is vertical: bad axisMap
  return { f, l: cross(u, f), u, accelSign };
}

/** Project a phone-frame vector onto the vehicle frame. */
export function toVehicle(v, frame) {
  return { long: dot(v, frame.f), lat: dot(v, frame.l), vert: dot(v, frame.u) };
}

/** Project a phone-frame linear acceleration, correcting the platform sign convention. */
export function accelToVehicle(a, frame) {
  const s = frame.accelSign ?? 1;
  return toVehicle([a[0] * s, a[1] * s, a[2] * s], frame);
}

/**
 * Factor to convert accelerometer/gravity readings to m/s²: iOS may report in g (|gravity| ≈ 1),
 * Android in m/s² (|gravity| ≈ 9.8).
 */
export function unitScale(gravity) {
  const n = norm(gravity);
  return n > 0.3 && n < 3 ? G0 : 1;
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
