import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

import { ReplayController, groupRecordings, parseCsv, recordingFromCsvFiles, recordingFromNdjson, testFromTag } from '../../dashboard/replay.js';
import { Session } from '../../dashboard/state.js';

const fixtureDir = new URL('../fixtures/iphone_accel/', import.meta.url);
const iphoneFiles = () => readdirSync(fixtureDir).map((name) => ({ name, text: readFileSync(new URL(name, fixtureDir), 'utf8') }));
const close = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

test('testFromTag maps Sensor Logger tags to test types', () => {
  assert.equal(testFromTag('Aceleración'), 'acceleration');
  assert.equal(testFromTag('Radio de giro'), 'turning');
  assert.equal(testFromTag('Ascenso'), 'climb');
  assert.equal(testFromTag('Suspensión'), 'suspension');
  assert.equal(testFromTag('Tracción'), 'traction');
  assert.equal(testFromTag('Frenado'), 'free');
  assert.equal(testFromTag(''), 'free');
});

test('parseCsv', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\n\n3,4\n'), { header: ['a', 'b'], rows: [['1', '2'], ['3', '4']] });
  assert.deepEqual(parseCsv(''), { header: [], rows: [] });
});

test('real iPhone export → recording with tag, device and sorted entries', () => {
  const rec = recordingFromCsvFiles(iphoneFiles(), 'accel');
  assert.equal(rec.tag, 'Aceleración');
  assert.equal(rec.test, 'acceleration');
  assert.equal(rec.platform, 'ios');
  assert.equal(rec.startedAt, 1794875013340);
  const names = new Set(rec.entries.map((e) => e.name));
  assert.deepEqual([...names].sort(), ['accelerometer', 'battery', 'gravity', 'gyroscope', 'location']);
  assert.ok(rec.entries.every((e, i, a) => i === 0 || a[i - 1].time <= e.time));
  assert.ok(rec.t1 - rec.t0 > 30);
  const battery = rec.entries.find((e) => e.name === 'battery');
  assert.equal(battery.values.batteryState, undefined); // text fields are skipped
  close(battery.values.batteryLevel, 0.55, 1e-6);
});

test('spreadsheet-damaged time column is rebuilt from the recording epoch', () => {
  const files = [
    { name: 'Metadata.csv', text: 'version,recording epoch time\n3,1794875013340\n' },
    { name: 'Accelerometer.csv', text: 'time,seconds_elapsed,z,y,x\n1.79488E+18,0.5,0,0,1\n' },
  ];
  const rec = recordingFromCsvFiles(files, 'x');
  close(rec.entries[0].time, 1794875013340e6 + 0.5e9, 1e3);
});

test('groupRecordings: one recording per export folder, ndjson files apart, natural order', () => {
  const p = (path) => ({ path });
  const groups = groupRecordings([
    p('day/accel10/Accelerometer.csv'), p('day/accel10/Gravity.csv'),
    p('day/accel2/Accelerometer.csv'), p('day/accel/Accelerometer.csv'),
    p('day/analisis/results.csv'), // no Accelerometer.csv: not a recording
    p('day/analisis/plot.png'),
    p('day/stream/abc.ndjson'),
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.kind, g.files.length]), [
    ['abc', 'ndjson', 1], ['accel', 'csv', 1], ['accel2', 'csv', 1], ['accel10', 'csv', 2],
  ]);
});

test('ndjson backup → recording', () => {
  const line = (t, name, values) => JSON.stringify({ received_at: t, topic: 'felinos/d/s', message: { deviceId: 'd', sessionId: 's', payload: [{ name, time: t, values }] } });
  const rec = recordingFromNdjson([line(2e18, 'gravity', { x: 0, y: 0, z: 9.8 }), line(1e18, 'accelerometer', { x: 1, y: 0, z: 0 }), line(3e18, 'annotation', {})].join('\n'), 'abc');
  assert.equal(rec.entries.length, 2);
  assert.equal(rec.entries[0].name, 'accelerometer');
  assert.equal(rec.deviceId, 'd');
});

test('ReplayController: play, speed, seek forward/backward and end', () => {
  const entries = Array.from({ length: 101 }, (_, i) => ({ name: 'accelerometer', time: (1000 + i * 0.1) * 1e9, values: {} }));
  const rec = { t0: 1000, t1: 1010, entries };
  let fed = 0;
  let resets = 0;
  const rc = new ReplayController(rec, { onReset: () => { resets += 1; fed = 0; }, onFeed: (batch) => { fed += batch.length; } });
  assert.equal(resets, 1);
  rc.speed = 2;
  rc.play(0);
  rc.tick(1000); // 1 s wall × 2 = 2 s of data
  close(rc.elapsed, 2, 1e-9);
  assert.equal(fed, 21);
  rc.seekFraction(0.5);
  assert.equal(fed, 51);
  rc.seek(1001); // backwards → reset and replay
  assert.equal(resets, 2);
  assert.equal(fed, 11);
  rc.tick(10_000); // past the end
  assert.equal(rc.ended, true);
  assert.equal(rc.playing, false);
  assert.equal(fed, 101);
  rc.play(0); // at the end, play restarts
  assert.equal(resets, 3);
});

test('real iPhone recording replayed through the dashboard session finds the launch (~5.1 s)', () => {
  const rec = recordingFromCsvFiles(iphoneFiles(), 'accel');
  const session = new Session(rec.id, { axisMap: { x: 'lateral', y: 'vertical', z: 'longitudinal' } });
  const rc = new ReplayController(rec, { onReset: () => {}, onFeed: (batch, id) => session.ingest({ messageId: id, sessionId: rec.id, payload: batch }, 0) });
  rc.seek(rec.t1);
  session.analysis.flush();
  const attempts = session.analysis.attempts.filter((a) => a.t100 !== null);
  assert.equal(attempts.length, 1);
  close(attempts[0].t100, 5.19, 0.2); // team's own analysis: 5.19 s
  close(session.max.speed, 34.7, 0.5);
  close(session.now.battery, 55, 1);
});
