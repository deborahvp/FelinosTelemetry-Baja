// Live analysis: usage (active time, distance), events and vehicle-goal attempts, computed while
// data streams in. Pure logic, no DOM. These are monitoring estimates; the official numbers come
// from the offline Python analysis of the phone's recording. Thresholds mirror
// config/analysis.yaml (a test keeps them in sync).

import { G0 } from './vehicle.js';

export const DEFAULTS = {
  usage: { activeSpeedKmh: 3.0, maxGapS: 5.0 },
  events: {
    impactG: 2.0, impactRefractoryS: 0.3, impactSeverityG: [2.0, 3.0, 4.0],
    freefallG: 0.3, jumpMinAirtimeS: 0.1,
    hardBrakeG: 0.5, hardBrakeMinS: 0.2, hardCornerG: 0.5, hardCornerMinS: 0.3, smoothS: 0.1,
  },
  acceleration: {
    restSpeedKmh: 1.0, restMinS: 1.0, launchG: 0.1, launchMinS: 0.1,
    distancesM: [30.48, 45.72], timeoutS: 60.0, gpsBlend: 0.5,
  },
  turning: { windowS: 2.0, minYawDegS: 10.0, maxYawCv: 0.15, speedKmh: [3.0, 15.0], maxSpeedCv: 0.15 },
  durability: { targetHours: 80.0 },
};

const R_EARTH = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const std = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

export class LiveAnalyzer {
  constructor(config = DEFAULTS) {
    this.cfg = config;
    // usage
    this.activeS = 0;
    this.distanceM = 0;
    this.lastGps = null; // {t, speed, lat, lon}
    // events
    this.counts = { impact: 0, jump: 0, hardBrake: 0, hardCorner: 0 };
    this.impactBins = config.events.impactSeverityG.map(() => 0);
    this.events = [];
    this.impact = null;
    this.lastImpactEnd = -Infinity;
    this.airStart = null;
    this.brake = null;
    this.corner = null;
    this.longS = 0;
    this.latS = 0;
    this.lastImuT = null;
    // launches (VG-04 / VG-06)
    this.restStart = null;
    this.restBias = { sum: 0, n: 0 };
    this.exceedStart = null;
    this.launch = null;
    this.attempts = [];
    // turns (VG-05)
    this.yawWin = [];
    this.gpsWin = [];
    this.turnSeg = null;
    this.turns = [];
    this.nextTurnEval = 0;
  }

  /** GPS fix: t (s), speed (km/h or null), lat, lon. */
  gps(t, speedKmh, lat, lon) {
    const { activeSpeedKmh, maxGapS } = this.cfg.usage;
    const prev = this.lastGps;
    if (prev && speedKmh !== null) {
      const dt = t - prev.t;
      if (dt > 0 && dt <= maxGapS && speedKmh >= activeSpeedKmh) {
        this.activeS += dt;
        this.distanceM += haversine(prev.lat, prev.lon, lat, lon);
      }
    }
    this.lastGps = { t, speed: speedKmh, lat, lon };
    if (speedKmh !== null) this.gpsWin.push({ t, speed: speedKmh });
    this.trimWindows(t);
    if (this.launch && speedKmh !== null) this.launchGps(t, speedKmh);
  }

  speedNow(t) {
    const g = this.lastGps;
    return g && g.speed !== null && t - g.t <= 2.5 ? g.speed : null;
  }

  /**
   * IMU sample in the vehicle frame: long/lat/vert (g, gravity removed), sf = |specific force|
   * (g, ≈1 at rest, ≈0 in free fall), yaw (deg/s), grade (deg).
   */
  imu(t, s) {
    const dt = this.lastImuT === null ? 0 : Math.max(0, Math.min(0.1, t - this.lastImuT));
    this.lastImuT = t;
    const e = this.cfg.events;
    const alpha = dt > 0 ? dt / (e.smoothS + dt) : 1;
    this.longS += alpha * (s.long - this.longS);
    this.latS += alpha * (s.lat - this.latS);
    this.detectImpact(t, Math.abs(s.vert));
    this.detectJump(t, s.sf);
    this.brake = this.sustained(t, this.brake, -this.longS > e.hardBrakeG, -this.longS, e.hardBrakeMinS, 'hardBrake');
    this.corner = this.sustained(t, this.corner, Math.abs(this.latS) > e.hardCornerG, Math.abs(this.latS), e.hardCornerMinS, 'hardCorner');
    this.launchImu(t, dt, s);
    this.turnImu(t, s.yaw);
  }

  record(type, ev) {
    this.counts[type] += 1;
    this.events.push({ type, ...ev });
    if (this.events.length > 500) this.events.shift();
  }

  detectImpact(t, v) {
    const e = this.cfg.events;
    if (v > e.impactG) {
      if (this.impact) this.impact.peak = Math.max(this.impact.peak, v);
      else if (t - this.lastImpactEnd >= e.impactRefractoryS) this.impact = { t, peak: v };
    } else if (this.impact) {
      const { peak } = this.impact;
      let bin = 0;
      e.impactSeverityG.forEach((edge, i) => { if (peak >= edge) bin = i; });
      this.impactBins[bin] += 1;
      this.record('impact', { t: this.impact.t, peak, bin });
      this.impact = null;
      this.lastImpactEnd = t;
    }
  }

  detectJump(t, sf) {
    const e = this.cfg.events;
    if (sf < e.freefallG) {
      if (this.airStart === null) this.airStart = t;
    } else if (this.airStart !== null) {
      const airtime = t - this.airStart;
      if (airtime >= e.jumpMinAirtimeS) this.record('jump', { t: this.airStart, airtime });
      this.airStart = null;
    }
  }

  sustained(t, state, active, value, minS, type) {
    if (active) {
      if (!state) return { t, peak: value, counted: false };
      state.peak = Math.max(state.peak, value);
      if (!state.counted && t - state.t >= minS) {
        state.counted = true;
        this.record(type, { t: state.t, peak: state.peak });
      }
      return state;
    }
    return null;
  }

  // ---- launches: time to 100 ft / 150 ft from a standing start ----------------------------

  launchImu(t, dt, s) {
    const c = this.cfg.acceleration;
    if (this.launch) {
      const L = this.launch;
      L.v = Math.max(0, L.v + (s.long - L.bias) * G0 * dt);
      const before = L.d;
      L.d += L.v * dt;
      L.grades.push(s.grade);
      c.distancesM.forEach((target, i) => {
        if (L.times[i] === null && L.d >= target) {
          const frac = L.v > 0 && dt > 0 ? (target - before) / (L.d - before) : 1;
          L.times[i] = t - dt + frac * dt - L.t0;
        }
      });
      const elapsed = t - L.t0;
      const done = L.times.every((x) => x !== null);
      const stalled = elapsed > 2 && L.v < 0.5;
      if (done || stalled || elapsed > c.timeoutS) this.finishLaunch();
      return;
    }
    const speed = this.speedNow(t);
    const atRest = speed !== null && speed < c.restSpeedKmh;
    if (atRest) {
      if (this.restStart === null) { this.restStart = t; this.restBias = { sum: 0, n: 0 }; }
      this.restBias.sum += s.long; // a_long at rest = bias to remove (mounting/level error)
      this.restBias.n += 1;
    } else if (this.restStart !== null) {
      // GPS lags ~1 s, so stay armed right after the stop; disarm on a short stop or when
      // clearly moving without a detected launch (rolling start).
      const shortStop = t - this.restStart < c.restMinS;
      const rolling = speed !== null && speed > c.restSpeedKmh + 5;
      if (shortStop || rolling) this.restStart = null;
    }
    const armed = this.restStart !== null && t - this.restStart >= c.restMinS && this.restBias.n > 0;
    if (!armed) { this.exceedStart = null; return; }
    const bias = this.restBias.sum / this.restBias.n;
    if (s.long - bias > c.launchG) {
      if (this.exceedStart === null) {
        this.exceedStart = t;
        this.pre = { v: 0, d: 0 }; // integrate during confirmation so no motion is lost
      } else {
        this.pre.v += (s.long - bias) * G0 * dt;
        this.pre.d += this.pre.v * dt;
      }
      if (t - this.exceedStart >= c.launchMinS) {
        this.launch = {
          t0: this.exceedStart, bias, v: this.pre.v, d: this.pre.d, grades: [],
          times: c.distancesM.map(() => null), gpsTimes: c.distancesM.map(() => null),
          gpsD: 0, gpsLast: { t: this.exceedStart, v: 0 }, maxSpeedKmh: 0,
        };
        this.restStart = null;
        this.exceedStart = null;
      }
    } else {
      this.exceedStart = null;
    }
  }

  launchGps(t, speedKmh) {
    const c = this.cfg.acceleration;
    const L = this.launch;
    const v = speedKmh / 3.6;
    L.maxSpeedKmh = Math.max(L.maxSpeedKmh, speedKmh);
    L.v += c.gpsBlend * (v - L.v); // complementary correction of the integrated speed
    const dt = t - L.gpsLast.t;
    if (dt > 0) {
      const before = L.gpsD;
      L.gpsD += ((L.gpsLast.v + v) / 2) * dt; // GPS-only distance (trapezoid)
      c.distancesM.forEach((target, i) => {
        if (L.gpsTimes[i] === null && L.gpsD >= target) {
          const frac = (target - before) / (L.gpsD - before);
          L.gpsTimes[i] = L.gpsLast.t + frac * dt - L.t0;
        }
      });
    }
    L.gpsLast = { t, v };
  }

  finishLaunch() {
    const L = this.launch;
    this.launch = null;
    if (L.times[0] === null) return; // never reached 100 ft: not an attempt
    this.attempts.push({
      t: L.t0,
      t100: L.times[0],
      t150: L.times[1] ?? null,
      gps100: L.gpsTimes[0],
      gps150: L.gpsTimes[1] ?? null,
      maxSpeedKmh: L.maxSpeedKmh,
      meanGradeDeg: L.grades.length ? mean(L.grades) : null,
    });
  }

  // ---- steady-state turns: R = v / ω ---------------------------------------------------

  trimWindows(t) {
    const w = this.cfg.turning.windowS;
    while (this.yawWin.length && this.yawWin[0].t < t - w) this.yawWin.shift();
    while (this.gpsWin.length && this.gpsWin[0].t < t - w - 1) this.gpsWin.shift();
  }

  turnImu(t, yaw) {
    const c = this.cfg.turning;
    this.yawWin.push({ t, yaw });
    this.trimWindows(t);
    if (t < this.nextTurnEval) return;
    this.nextTurnEval = t + 0.25;
    const span = this.yawWin.length ? t - this.yawWin[0].t : 0;
    let steady = false;
    let r = null;
    let speed = null;
    if (span >= c.windowS * 0.9 && this.gpsWin.length >= 2) {
      const ys = this.yawWin.map((p) => p.yaw);
      const m = mean(ys);
      const speeds = this.gpsWin.map((p) => p.speed);
      speed = mean(speeds);
      steady = Math.abs(m) >= c.minYawDegS && std(ys) / Math.abs(m) <= c.maxYawCv
        && speed >= c.speedKmh[0] && speed <= c.speedKmh[1] && std(speeds) / speed <= c.maxSpeedCv;
      if (steady) r = (speed / 3.6) / rad(Math.abs(m));
      if (steady) this.turnDir = Math.sign(m);
    }
    if (steady) {
      if (!this.turnSeg) this.turnSeg = { t: t - span, rs: [], speeds: [] };
      this.turnSeg.rs.push(r);
      this.turnSeg.speeds.push(speed);
    } else if (this.turnSeg) {
      const seg = this.turnSeg;
      this.turnSeg = null;
      this.turns.push({ t: seg.t, rCgM: median(seg.rs), speedKmh: mean(seg.speeds), dir: this.turnDir > 0 ? 'left' : 'right' });
    }
  }

  /** Close any open segment (end of recording). */
  flush() {
    if (this.launch) this.finishLaunch();
    if (this.turnSeg) this.turnImu(Infinity, 0);
  }

  snapshot() {
    return {
      activeS: this.activeS,
      distanceM: this.distanceM,
      counts: { ...this.counts },
      impactBins: [...this.impactBins],
      attempts: this.attempts.map((a) => ({ ...a })),
      turns: this.turns.map((x) => ({ ...x })),
    };
  }
}
