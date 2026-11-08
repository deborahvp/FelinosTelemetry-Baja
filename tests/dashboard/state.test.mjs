import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Decimator, Session, Store } from '../../dashboard/state.js';
import { G0 } from '../../dashboard/vehicle.js';

const realMessage = JSON.parse(
  readFileSync(new URL('../fixtures/stream_message_sample.json', import.meta.url), 'utf8'),
);
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

/** Synthetic message: flat phone, constant forward accel `a` (m/s²), yaw rate `w` (rad/s). */
function synth({ id = 1, session = 'S', t0 = 1e18, seconds = 1, a = 0, w = 0, rate = 100, extra = [] }) {
  const payload = [];
  for (let i = 0; i < seconds * rate; i += 1) {
    const time = t0 + (id - 1) * seconds * 1e9 + i * (1e9 / rate);
    payload.push({ name: 'gravity', time, values: { x: 0, y: 0, z: G0 } });
    payload.push({ name: 'gyroscope', time, values: { x: 0, y: 0, z: w } });
    payload.push({ name: 'accelerometer', time, values: { x: 0, y: a, z: 0 } });
  }
  return { messageId: id, sessionId: session, deviceId: 'dev', payload: [...payload, ...extra] };
}

test('Decimator averages into fixed buckets', () => {
  const d = new Decimator(0.04, ['v']);
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    const r = d.push(i * 0.01, { v: i });
    if (r) rows.push(r);
  }
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { t: 0.02, v: 1.5 });
  close(rows[1].v, 5.5, 1e-12);
  assert.deepEqual(d.flush(), { t: 0.1, v: 8.5 });
  assert.equal(d.flush(), null);
});

test('synthetic acceleration and yaw come out in g and deg/s at ~25 Hz', () => {
  const s = new Session('S');
  s.ingest(synth({ seconds: 2, a: 0.5 * G0, w: Math.PI / 18 }), 0);
  close(s.now.along, 0.5, 1e-9);
  close(s.now.alat, 0, 1e-9);
  close(s.now.yaw, 10, 1e-9);
  close(s.now.grade, 0, 1e-9);
  close(s.imu.t.length, 2 / 0.04, 2);
  close(s.max.along, 0.5, 1e-9);
  close(s.duration, 1.99, 1e-6);
});

test('real captured message parses without errors', () => {
  const s = new Session('c886864a');
  s.ingest(realMessage, 1794032706500);
  assert.equal(s.messages, 1);
  close(s.imu.t.length, 107 / 4, 1.5); // 107 IMU samples at 100 Hz → ~27 points at 25 Hz
  assert.ok(s.imu.along.every(Number.isFinite));
  assert.ok(Math.abs(s.now.yaw) < 720);
  close(s.latencyS, 0.43, 0.01); // received 1794032706.5 s vs newest sample 1794032706.067 s
  close(s.duration, 3.33, 0.01);
});

test('location → speed (km/h), accuracy and run max; invalid speed ignored', () => {
  const s = new Session('S');
  const loc = (time, speed, acc) => ({
    name: 'location',
    time,
    values: { latitude: 21.1471, longitude: -101.6887, speed, horizontalAccuracy: acc },
  });
  s.ingest({ messageId: 1, payload: [loc(1e18, 10, 4), loc(1e18 + 1e9, 5, 3.8), loc(1e18 + 2e9, -1, 3)] }, 0);
  assert.equal(s.gps.t.length, 3);
  assert.equal(s.now.speed, null);
  close(s.max.speed, 36, 1e-9);
  assert.equal(s.now.acc, 3);
});

test('message gaps are counted from messageId', () => {
  const s = new Session('S');
  for (const id of [1, 2, 6]) s.ingest({ messageId: id, payload: [] }, 0);
  assert.equal(s.missing, 3);
});

test('battery level 0–1 or 0–100 and hours-left estimate', () => {
  const s = new Session('S');
  const bat = (sec, level) => ({ name: 'battery', time: 1e18 + sec * 1e9, values: { batteryLevel: level } });
  s.ingest({ payload: [bat(0, 0.8)] }, 0);
  assert.equal(s.now.battery, 80);
  assert.equal(s.batteryHoursLeft(), null);
  s.ingest({ payload: [bat(300, 79)] }, 0); // 1 % per 5 min → 79 % lasts 6.58 h
  close(s.batteryHoursLeft(), 79 / (1 / 300) / 3600, 1e-9);
});

test('recentImu returns only the last N seconds', () => {
  const s = new Session('S');
  s.ingest(synth({ seconds: 3, a: 1 }), 0);
  const r = s.recentImu(1);
  close(r.along.length, 25, 2);
});

test('Store starts a new session on a new sessionId and persists the level', () => {
  const saved = {};
  const store = new Store({
    loadLevel: (dev) => saved[dev] ?? null,
    saveLevel: (dev, g) => { saved[dev] = g; },
  });
  const events = [];
  store.onChange((s, changed) => events.push([s.id, changed]));
  store.handle(synth({ id: 1, session: 'A', seconds: 6 }), 0);
  store.handle(synth({ id: 2, session: 'A', seconds: 1 }), 0);
  close(saved.dev[2], G0, 1e-9); // fixed after 5 s
  store.handle(synth({ id: 1, session: 'B' }), 0);
  assert.deepEqual(events, [['A', true], ['A', false], ['B', true]]);
  assert.equal(store.session.level.gravity, saved.dev); // reused for the same device
  store.handle(null);
  assert.equal(events.length, 3);
});

test('iPhone convention (gravity down, opposite sign, units in g) gives the same result', () => {
  // Raw Core Motion: flat phone reads gravity (0,0,-1) g; accelerating forward (+y) at 0.5 g
  // reads userAcceleration y = -0.5 g.
  const s = new Session('S');
  const payload = [];
  for (let i = 0; i < 100; i += 1) {
    const time = 1e18 + i * 1e7;
    payload.push({ name: 'gravity', time, values: { x: 0, y: 0, z: -1 } });
    payload.push({ name: 'gyroscope', time, values: { x: 0, y: 0, z: Math.PI / 18 } });
    payload.push({ name: 'accelerometer', time, values: { x: 0, y: -0.5, z: 0 } });
  }
  s.ingest({ messageId: 1, payload }, 0);
  close(s.now.along, 0.5, 1e-9);
  close(s.now.alat, 0, 1e-9);
  close(s.now.yaw, 10, 1e-9); // gyroscope convention is the same on both platforms
  close(s.now.grade, 0, 1e-9);
});

test('setAxisMap changes the mounting live and re-levels', () => {
  const store = new Store();
  store.handle(synth({ seconds: 1, a: 0.5 * G0 }), 0);
  close(store.session.now.along, 0.5, 1e-9);
  // Phone turned 180° about vertical (top now points backward): same motion reads −y.
  store.setAxisMap({ x: '-lateral', y: '-longitudinal', z: 'vertical' });
  assert.equal(store.session.frame, null); // re-leveling
  store.handle(synth({ id: 2, seconds: 3, a: 0.5 * G0 }), 0);
  close(store.session.now.along, -0.5, 1e-9);
  assert.throws(() => store.setAxisMap({ x: 'lateral', y: 'lateral', z: 'vertical' }), /twice/);
});

test('session feeds the live analyzer: free fall is a jump on both platforms', () => {
  for (const ios of [false, true]) {
    const s = new Session('S');
    const g = ios ? -1 : G0; // iOS: gravity down, in g
    const payload = [];
    for (let i = 0; i < 300; i += 1) {
      const time = 1e18 + i * 1e7;
      const air = i >= 150 && i < 200; // 0.5 s of free fall
      // linear acceleration during free fall = 1 g downward (Android sign); iOS reports the opposite
      const az = air ? (ios ? 1 : -G0) : 0;
      payload.push({ name: 'gravity', time, values: { x: 0, y: 0, z: g } });
      payload.push({ name: 'accelerometer', time, values: { x: 0, y: 0, z: az } });
    }
    s.ingest({ messageId: 1, payload }, 0);
    assert.equal(s.analysis.counts.jump, 1, ios ? 'iOS' : 'Android');
    close(s.analysis.events.find((e) => e.type === 'jump').airtime, 0.5, 0.02);
  }
});

test('relevel discards the frame and rebuilds it', () => {
  const s = new Session('S');
  s.ingest(synth({ seconds: 1 }), 0);
  s.relevel(0.5);
  assert.equal(s.frame, null);
  s.ingest(synth({ id: 2, seconds: 1, a: G0 }), 0);
  assert.ok(s.frame);
  close(s.now.along, 1, 1e-9);
});
