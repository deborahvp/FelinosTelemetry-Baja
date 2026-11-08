import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULTS, LiveAnalyzer, haversine } from '../../dashboard/analysis.js';
import { G0 } from '../../dashboard/vehicle.js';

const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);
const REST = { long: 0, lat: 0, vert: 0, sf: 1, yaw: 0, grade: 0 };
const IMU_DT = 0.01;

/** Drive the analyzer: imu(t) returns the IMU sample, gps(t) returns [speedKmh, lat, lon] each second. */
function run(an, t0, t1, imu, gps) {
  for (let i = Math.round(t0 / IMU_DT); i <= Math.round(t1 / IMU_DT); i += 1) {
    const t = i * IMU_DT;
    if (gps && i % 100 === 0) an.gps(t, ...gps(t));
    an.imu(t, imu(t));
  }
}

test('haversine: 1 arc-minute of latitude ≈ 1853 m', () => {
  close(haversine(21, -101.7, 21 + 1 / 60, -101.7), 1853.2, 1);
});

test('usage: active time and distance only while moving', () => {
  const an = new LiveAnalyzer();
  // 10 s stopped, then 20 s at 18 km/h (5 m/s) heading north
  const lat0 = 21.0894;
  const mPerDegLat = haversine(0, 0, 1, 0);
  run(an, 0, 30, () => REST, (t) => (t <= 10 ? [0, lat0, -101.7] : [18, lat0 + ((t - 10) * 5) / mPerDegLat, -101.7]));
  close(an.activeS, 20, 1e-9);
  close(an.distanceM, 100, 0.5);
});

test('usage: without GPS, vibration above 0.1 g RMS counts as active time (IMU fallback)', () => {
  const an = new LiveAnalyzer();
  // 10 s stopped (0.03 g noise), 20 s driving (0.2 g vibration), no GPS at all
  run(an, 0, 30, (t) => ({ ...REST, vert: (t < 10 ? 0.03 : 0.2) * Math.sin(t * 60) * Math.SQRT2 }));
  close(an.activeImuS, 20, 1.5);
  assert.equal(an.activeGpsS, 0);
  close(an.activeS, an.activeImuS, 1e-12);
});

test('usage: with GPS coverage the IMU fallback does not double count', () => {
  const an = new LiveAnalyzer();
  run(an, 0, 20, (t) => ({ ...REST, vert: 0.2 * Math.sin(t * 60) * Math.SQRT2 }), () => [20, 21, -101]);
  assert.equal(an.activeImuS, 0);
  close(an.activeGpsS, 20, 1e-9);
});

test('usage: GPS gaps longer than max_gap are not counted', () => {
  const an = new LiveAnalyzer();
  an.gps(0, 20, 21, -101);
  an.gps(10, 20, 21.001, -101); // 10 s gap > 5 s
  assert.equal(an.activeS, 0);
  assert.equal(an.distanceM, 0);
});

test('events: impacts with peak, severity bin and refractory period', () => {
  const an = new LiveAnalyzer();
  const spikes = [[1.0, 2.6], [1.1, 3.5], [3.0, 4.8], [5.0, 1.5]]; // 1.1 s is inside the refractory window of 1.0 s
  run(an, 0, 6, (t) => {
    const s = spikes.find(([ts]) => Math.abs(t - ts) < 0.015);
    return { ...REST, vert: s ? s[1] : 0 };
  });
  assert.equal(an.counts.impact, 2);
  assert.deepEqual(an.impactBins, [1, 0, 1]);
  const peaks = an.events.filter((e) => e.type === 'impact').map((e) => e.peak);
  assert.deepEqual(peaks, [2.6, 4.8]);
});

test('events: free fall followed by a landing peak counts one jump with its airtime', () => {
  const an = new LiveAnalyzer();
  run(an, 0, 4, (t) => (t >= 1 && t < 1.45 ? { ...REST, sf: 0.05, vert: -0.95 } : { ...REST, vert: t >= 1.45 && t < 1.47 ? 3.2 : 0 }));
  assert.equal(an.counts.jump, 1);
  const jump = an.events.find((e) => e.type === 'jump');
  close(jump.airtime, 0.45, 0.02);
  assert.equal(an.counts.impact, 1); // the landing
});

test('events: short dips are ignored; sustained braking and cornering are counted once', () => {
  const an = new LiveAnalyzer();
  run(an, 0, 10, (t) => {
    if (t >= 1 && t < 1.1) return { ...REST, long: -0.9 }; // 100 ms: too short
    if (t >= 3 && t < 4) return { ...REST, long: -0.7 }; // hard brake 1 s
    if (t >= 6 && t < 7) return { ...REST, lat: 0.65 }; // hard corner 1 s
    return REST;
  });
  assert.equal(an.counts.hardBrake, 1);
  assert.equal(an.counts.hardCorner, 1);
});

test('VG-04: constant 0.5 g launch → time to 100 ft = √(2d/a)', () => {
  const an = new LiveAnalyzer();
  const a = 0.5;
  const tLaunch = 3;
  const speedAt = (t) => (t < tLaunch ? 0 : a * G0 * (t - tLaunch) * 3.6);
  run(an, 0, 12, (t) => ({ ...REST, long: t >= tLaunch && t < 8 ? a : 0 }), (t) => [Math.min(speedAt(t), speedAt(8)), 21, -101]);
  an.flush();
  assert.equal(an.attempts.length, 1);
  const att = an.attempts[0];
  close(att.t, tLaunch, 0.02);
  close(att.t100, Math.sqrt((2 * 30.48) / (a * G0)), 0.05); // 3.526 s
  close(att.t150, Math.sqrt((2 * 45.72) / (a * G0)), 0.05); // 4.319 s
  close(att.gps100, Math.sqrt((2 * 30.48) / (a * G0)), 0.15); // GPS-only cross-check
});

test('VG-04: a bias from mis-leveling is removed using the rest period', () => {
  const an = new LiveAnalyzer();
  const bias = 0.04; // tilted mount reads +0.04 g at rest
  run(an, 0, 12, (t) => ({ ...REST, long: bias + (t >= 3 && t < 8 ? 0.5 : 0) }), (t) => [t < 3 ? 0 : Math.min(0.5 * G0 * (t - 3), 0.5 * G0 * 5) * 3.6, 21, -101]);
  an.flush();
  close(an.attempts[0].t100, 3.526, 0.06);
});

test('VG-04: no launch without a standing start; stalled launches are discarded', () => {
  const rolling = new LiveAnalyzer();
  run(rolling, 0, 8, (t) => ({ ...REST, long: t > 2 ? 0.4 : 0 }), () => [25, 21, -101]);
  rolling.flush();
  assert.equal(rolling.attempts.length, 0);

  const stalled = new LiveAnalyzer();
  run(stalled, 0, 10, (t) => ({ ...REST, long: t >= 3 && t < 3.5 ? 0.3 : t >= 3.5 && t < 4 ? -0.3 : 0 }), () => [0, 21, -101]);
  stalled.flush();
  assert.equal(stalled.attempts.length, 0);
});

test('VG-05: steady circle → R = v / ω', () => {
  const an = new LiveAnalyzer();
  const v = 8; // km/h
  const R = 2.5; // m
  const yaw = ((v / 3.6) / R) * (180 / Math.PI); // deg/s
  run(an, 0, 12, (t) => ({ ...REST, yaw: t >= 2 && t < 10 ? yaw : 0 }), () => [v, 21, -101]);
  an.flush();
  assert.equal(an.turns.length, 1);
  close(an.turns[0].rCgM, R, 0.01);
  assert.equal(an.turns[0].dir, 'left');
});

test('VG-05: unsteady yaw or speed outside the window is not a turn', () => {
  const an = new LiveAnalyzer();
  run(an, 0, 12, (t) => ({ ...REST, yaw: 40 * Math.sin(t * 3) }), () => [8, 21, -101]);
  const fast = new LiveAnalyzer();
  run(fast, 0, 12, () => ({ ...REST, yaw: 30 }), () => [40, 21, -101]);
  an.flush();
  fast.flush();
  assert.equal(an.turns.length, 0);
  assert.equal(fast.turns.length, 0);
});

test('snapshot is a plain copy', () => {
  const an = new LiveAnalyzer(DEFAULTS);
  const s = an.snapshot();
  s.counts.impact = 99;
  assert.equal(an.counts.impact, 0);
  assert.deepEqual(Object.keys(s), ['activeS', 'activeGpsS', 'activeImuS', 'distanceM', 'counts', 'impactBins', 'attempts', 'turns']);
});
