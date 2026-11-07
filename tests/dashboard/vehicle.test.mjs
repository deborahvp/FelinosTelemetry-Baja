import assert from 'node:assert/strict';
import { test } from 'node:test';

import { G0, LevelReference, attitude, frameFromGravity, parseAxisMap, toVehicle } from '../../dashboard/vehicle.js';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const DEFAULT = { x: 'lateral', y: 'longitudinal', z: 'vertical' };

test('parseAxisMap builds signed unit vectors', () => {
  const axes = parseAxisMap({ x: '-longitudinal', y: 'vertical', z: 'lateral' });
  assert.deepEqual(axes.longitudinal, [-1, 0, 0]);
  assert.deepEqual(axes.vertical, [0, 1, 0]);
  assert.deepEqual(axes.lateral, [0, 0, 1]);
});

test('parseAxisMap rejects bad maps', () => {
  assert.throws(() => parseAxisMap({ x: 'lateral', y: 'lateral', z: 'vertical' }), /twice/);
  assert.throws(() => parseAxisMap({ x: 'sideways', y: 'longitudinal', z: 'vertical' }), /not a vehicle axis/);
});

test('flat phone: identity-like frame, accelerations map directly', () => {
  const frame = frameFromGravity([0, 0, G0], parseAxisMap(DEFAULT));
  const v = toVehicle([0.5, 2, 0.1], frame); // phone y forward, x lateral
  close(v.long, 2);
  close(v.vert, 0.1);
  close(Math.abs(v.lat), 0.5);
});

test('gravity sign does not matter (platform-agnostic)', () => {
  const axes = parseAxisMap(DEFAULT);
  const up = frameFromGravity([0, 0, G0], axes);
  const down = frameFromGravity([0, 0, -G0], axes);
  for (const k of ['f', 'l', 'u']) up[k].forEach((v, i) => close(v, down[k][i]));
});

test('mounting tilt is removed: tilted phone still reads pure longitudinal', () => {
  // Phone pitched back 30° about its x axis: phone y (nominal forward) tilts upward.
  const th = (30 * Math.PI) / 180;
  const gravity = [0, Math.sin(th) * G0, Math.cos(th) * G0]; // "up" in phone coords
  const frame = frameFromGravity(gravity, parseAxisMap(DEFAULT));
  // A true horizontal forward acceleration of 3 m/s², expressed in phone coords:
  const accelPhone = [0, 3 * Math.cos(th), -3 * Math.sin(th)];
  const v = toVehicle(accelPhone, frame);
  close(v.long, 3, 1e-9);
  close(v.vert, 0, 1e-9);
  close(v.lat, 0, 1e-9);
});

test('attitude: grade relative to the level reference, nose up positive', () => {
  const axes = parseAxisMap(DEFAULT);
  const frame = frameFromGravity([0, 0, G0], axes);
  const th = (10 * Math.PI) / 180;
  // Vehicle nose up 10°: true up now leans toward phone +y (forward).
  const { pitch, roll } = attitude([0, Math.sin(th) * G0, Math.cos(th) * G0], frame);
  close(pitch, 10, 1e-9);
  close(roll, 0, 1e-9);
});

test('portrait phone on a vertical tube (real export orientation)', () => {
  // Real export: gravity ≈ (−0.005, 9.62, 1.92) → phone y is up. Mount with y vertical, z forward.
  const axes = parseAxisMap({ x: 'lateral', y: 'vertical', z: 'longitudinal' });
  const frame = frameFromGravity([-0.005, 9.616, 1.922], axes);
  close(frame.u[1], 0.98, 0.01);
  // forward axis is horizontal and orthogonal to up
  close(frame.f[0] * frame.u[0] + frame.f[1] * frame.u[1] + frame.f[2] * frame.u[2], 0, 1e-12);
});

test('field guide mounts: portrait on a tube, screen facing out', () => {
  // Right side: phone y = up, z = out of screen = vehicle right ⇒ x = y × z = forward.
  const right = frameFromGravity([0, G0, 0], parseAxisMap({ x: 'longitudinal', y: 'vertical', z: 'lateral' }));
  const vr = toVehicle([2, 0, 0], right);
  close(vr.long, 2);
  close(toVehicle([0, 0, 1], right).lat, -1); // screen normal points right ⇒ ISO lateral (left) −
  // Left side: z = vehicle left ⇒ x = y × z = rearward.
  const left = frameFromGravity([0, G0, 0], parseAxisMap({ x: '-longitudinal', y: 'vertical', z: 'lateral' }));
  close(toVehicle([-2, 0, 0], left).long, 2);
  close(toVehicle([0, 0, 1], left).lat, 1);
});

test('frameFromGravity returns null for degenerate input', () => {
  const axes = parseAxisMap(DEFAULT);
  assert.equal(frameFromGravity([0, 0, 0], axes), null);
  assert.equal(frameFromGravity([0, G0, 0], axes), null); // longitudinal axis vertical
});

test('LevelReference averages over the span then fixes', () => {
  const ref = new LevelReference(1);
  assert.equal(ref.current(), null);
  assert.equal(ref.add(0, [0, 0, 9]), false);
  assert.deepEqual(ref.current(), [0, 0, 9]);
  assert.equal(ref.add(0.5, [0, 0, 11]), false);
  assert.equal(ref.add(1.0, [0, 0, 10]), true);
  assert.deepEqual(ref.gravity, [0, 0, 10]);
  assert.equal(ref.add(2, [5, 5, 5]), false); // fixed: ignores later samples
  assert.deepEqual(ref.current(), [0, 0, 10]);
});
