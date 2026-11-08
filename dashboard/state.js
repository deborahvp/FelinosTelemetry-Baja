// In-memory state for the live dashboard. Pure logic, no DOM, so it runs under `node --test`.
//
// Sensor Logger messages ({messageId, sessionId, deviceId, payload: [{name, time, values}]})
// are folded into a Session: decimated (~25 Hz) vehicle-frame series for plotting, GPS
// points for the map, and running stats for the status panel. The full session stays in
// memory so charts can be scrolled back.

import { DEFAULTS, LiveAnalyzer } from './analysis.js';
import { G0, LevelReference, accelToVehicle, attitude, frameFromGravity, parseAxisMap, toDeg, toG, toKmh, toVehicle, unitScale } from './vehicle.js';

export const PLOT_DT = 0.04; // 25 Hz for plotting only
const BATTERY_WINDOW_S = 300;

/** Bucket-averages several channels onto a fixed time grid (decimation for plotting). */
export class Decimator {
  constructor(dt, channels) {
    this.dt = dt;
    this.channels = channels;
    this.bucket = null;
    this.sums = null;
    this.n = 0;
  }
  /** Add one sample; returns a finished {t, ...means} row or null. */
  push(t, values) {
    const b = Math.floor(t / this.dt);
    let out = null;
    if (this.bucket !== null && b !== this.bucket) out = this.flush();
    if (this.bucket === null) {
      this.bucket = b;
      this.sums = Object.fromEntries(this.channels.map((c) => [c, 0]));
      this.n = 0;
    }
    for (const c of this.channels) this.sums[c] += values[c];
    this.n += 1;
    return out;
  }
  flush() {
    if (this.bucket === null || this.n === 0) return null;
    const row = { t: (this.bucket + 0.5) * this.dt };
    for (const c of this.channels) row[c] = this.sums[c] / this.n;
    this.bucket = null;
    return row;
  }
}

const nsToS = (t) => Number(t) / 1e9;
const vec = (v) => [Number(v?.x), Number(v?.y), Number(v?.z)];
const finite3 = (a) => a.every(Number.isFinite);

export class Session {
  constructor(id, { axisMap, savedLevel = null, analysisConfig = DEFAULTS } = {}) {
    this.id = id;
    this.analysis = new LiveAnalyzer(analysisConfig);
    this.deviceId = null;
    this.axes = parseAxisMap(axisMap ?? { x: 'lateral', y: 'longitudinal', z: 'vertical' });
    this.level = new LevelReference(5);
    if (savedLevel) this.level.gravity = savedLevel;
    this.frame = savedLevel ? frameFromGravity(savedLevel, this.axes) : null;
    this.t0 = null; // first sample, epoch seconds
    this.tLast = null;
    this.gravity = null;
    this.gyro = null;
    this.dec = new Decimator(PLOT_DT, ['along', 'alat', 'yaw', 'grade']);
    this.imu = { t: [], along: [], alat: [], yaw: [], grade: [] };
    this.gps = { t: [], lat: [], lon: [], speed: [], acc: [] };
    this.battery = { t: [], level: [] };
    this.now = { along: null, alat: null, yaw: null, grade: null, speed: null, acc: null, battery: null };
    this.max = { speed: 0, along: 0, alat: 0 };
    this.messages = 0;
    this.missing = 0;
    this.lastMessageId = null;
    this.lastReceivedMs = null;
    this.latencyS = null;
  }

  /**
   * |specific force| in g from a linear acceleration sample (phone frame, m/s²): ≈1 at rest or
   * cruising, ≈0 in free fall. Uses the current gravity direction, sign-corrected per platform.
   */
  specificForceG(a) {
    if (!this.gravity || !this.frame) return 1;
    const n = Math.hypot(...this.gravity);
    if (!n) return 1;
    const s = this.frame.accelSign ?? 1; // gravity reading points up on Android, down on raw iOS
    const f = a.map((x, i) => x * s + (this.gravity[i] / n) * s * G0);
    return Math.hypot(...f) / G0;
  }

  /** Relative time (s since session start) of the newest sample. */
  get duration() {
    return this.t0 === null || this.tLast === null ? 0 : this.tLast - this.t0;
  }

  /** Re-level: discard the reference and average gravity again from now on. */
  relevel(spanSeconds = 2) {
    this.level = new LevelReference(spanSeconds);
    this.frame = null;
  }

  /** The phone was mounted differently: new axis map, and re-level since the old reference no longer applies. */
  setAxisMap(axisMap, spanSeconds = 2) {
    this.axes = parseAxisMap(axisMap);
    this.relevel(spanSeconds);
  }

  ingest(message, receivedMs = Date.now()) {
    this.messages += 1;
    this.lastReceivedMs = receivedMs;
    if (message.deviceId) this.deviceId = String(message.deviceId);
    const mid = message.messageId;
    if (Number.isInteger(mid)) {
      if (this.lastMessageId !== null && mid > this.lastMessageId + 1) this.missing += mid - this.lastMessageId - 1;
      this.lastMessageId = mid;
    }
    const entries = Array.isArray(message.payload) ? message.payload : [];
    const sorted = entries
      .filter((e) => e && typeof e.name === 'string' && e.values && Number.isFinite(Number(e.time)))
      .sort((a, b) => Number(a.time) - Number(b.time));
    let newest = null;
    for (const e of sorted) {
      const t = nsToS(e.time);
      newest = newest === null ? t : Math.max(newest, t);
      this.sample(e.name.toLowerCase(), t, e.values);
    }
    if (newest !== null) this.latencyS = receivedMs / 1000 - newest;
  }

  sample(name, t, v) {
    if (this.t0 === null) this.t0 = t;
    this.tLast = this.tLast === null ? t : Math.max(this.tLast, t);
    const rel = t - this.t0;
    switch (name) {
      case 'gravity': {
        const g = vec(v);
        if (!finite3(g)) return;
        this.gravity = g;
        this.accelScale = unitScale(g); // iOS may report in g instead of m/s²
        const fixed = this.level.add(t, g);
        if (fixed) this.levelFixed = this.level.gravity;
        if (fixed || !this.frame) this.frame = frameFromGravity(this.level.current(), this.axes);
        return;
      }
      case 'gyroscope': {
        const w = vec(v);
        if (finite3(w)) this.gyro = w;
        return;
      }
      case 'accelerometer': {
        const k = this.accelScale ?? 1;
        const a = vec(v).map((x) => x * k);
        if (!finite3(a) || !this.frame) return;
        const av = accelToVehicle(a, this.frame);
        const along = toG(av.long);
        const alat = toG(av.lat);
        const yaw = this.gyro ? toDeg(toVehicle(this.gyro, this.frame).vert) : 0;
        const grade = this.gravity ? attitude(this.gravity, this.frame).pitch : 0;
        // Full-rate analysis (events need peaks the 25 Hz plot decimation would smooth away).
        this.analysis.imu(t, { long: along, lat: alat, vert: toG(av.vert), sf: this.specificForceG(a), yaw, grade });
        const row = this.dec.push(rel, { along, alat, yaw, grade });
        if (row) this.pushImu(row);
        return;
      }
      case 'location': {
        const lat = Number(v.latitude);
        const lon = Number(v.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        const speedMs = Number(v.speed);
        const speed = Number.isFinite(speedMs) && speedMs >= 0 ? toKmh(speedMs) : null;
        const acc = Number(v.horizontalAccuracy);
        this.gps.t.push(rel);
        this.gps.lat.push(lat);
        this.gps.lon.push(lon);
        this.gps.speed.push(speed);
        this.gps.acc.push(Number.isFinite(acc) ? acc : null);
        this.now.speed = speed;
        this.now.acc = Number.isFinite(acc) ? acc : null;
        if (speed !== null) this.max.speed = Math.max(this.max.speed, speed);
        this.analysis.gps(t, speed, lat, lon);
        return;
      }
      case 'battery': {
        let level = Number(v.batteryLevel ?? v.level);
        if (!Number.isFinite(level)) return;
        if (level <= 1) level *= 100; // 0–1 or 0–100 depending on platform
        this.battery.t.push(rel);
        this.battery.level.push(level);
        this.now.battery = level;
        return;
      }
      default:
    }
  }

  pushImu(row) {
    for (const k of ['t', 'along', 'alat', 'yaw', 'grade']) this.imu[k].push(row[k]);
    this.now.along = row.along;
    this.now.alat = row.alat;
    this.now.yaw = row.yaw;
    this.now.grade = row.grade;
    this.max.along = Math.max(this.max.along, Math.abs(row.along));
    this.max.alat = Math.max(this.max.alat, Math.abs(row.alat));
  }

  /** Estimated hours of battery left from the discharge slope, or null. */
  batteryHoursLeft() {
    const { t, level } = this.battery;
    if (t.length < 2) return null;
    const tEnd = t[t.length - 1];
    let i = t.length - 1;
    while (i > 0 && tEnd - t[i - 1] <= BATTERY_WINDOW_S) i -= 1;
    const dt = tEnd - t[i];
    const drop = level[i] - level[level.length - 1];
    if (dt < 120 || drop <= 0) return null;
    return level[level.length - 1] / (drop / dt) / 3600;
  }

  /** Index of the first element of a sorted array >= value. */
  static lowerBound(arr, value) {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** IMU points within the last `seconds` (for the G-G diagram). */
  recentImu(seconds) {
    const start = Session.lowerBound(this.imu.t, this.duration - seconds);
    return { along: this.imu.along.slice(start), alat: this.imu.alat.slice(start) };
  }
}

/** Routes messages to the current session; a new sessionId starts a fresh session. */
export class Store {
  constructor({ axisMap, loadLevel = () => null, saveLevel = () => {} } = {}) {
    this.axisMap = axisMap;
    this.loadLevel = loadLevel;
    this.saveLevel = saveLevel;
    this.session = null;
    this.listeners = new Set();
  }
  /** Change the mounting live (Mount dialog). Throws on an invalid map. */
  setAxisMap(axisMap) {
    parseAxisMap(axisMap);
    this.axisMap = axisMap;
    if (this.session) this.session.setAxisMap(axisMap);
  }
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  handle(message, receivedMs = Date.now()) {
    if (!message || typeof message !== 'object') return;
    const id = String(message.sessionId ?? 'unknown');
    let changed = false;
    if (!this.session || this.session.id !== id) {
      if (this.session) {
        this.session.analysis.flush(); // close a launch/turn still open when the recording ended
        this.previous = this.session;
      }
      const device = message.deviceId ? String(message.deviceId) : null;
      this.session = new Session(id, { axisMap: this.axisMap, savedLevel: device ? this.loadLevel(device) : null });
      changed = true;
    }
    const s = this.session;
    s.ingest(message, receivedMs);
    if (s.levelFixed && s.deviceId) {
      this.saveLevel(s.deviceId, s.levelFixed);
      s.levelFixed = null;
    }
    for (const fn of this.listeners) fn(s, changed);
  }
}
