import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunLog, folderName, nextRunId, slug, toCsv, toMetaYaml } from '../../dashboard/runlog.js';

const memory = (initial = null) => {
  let data = initial;
  return { load: () => data, save: (v) => { data = JSON.parse(JSON.stringify(v)); }, peek: () => data };
};
const HEADER = { run: 'R01', test: 'acceleration', suspension: 'susp-A', cvt: 'cvt-1', driver: 'Ana', place: 'La Salle Bajío' };

test('nextRunId', () => {
  assert.equal(nextRunId('R01'), 'R02');
  assert.equal(nextRunId('R09'), 'R10');
  assert.equal(nextRunId('R99'), 'R100');
  assert.equal(nextRunId('x'), 'R01');
});

test('first recording uses the header run ID; the next one auto-increments', () => {
  const store = memory();
  const log = new RunLog(store);
  const a = log.startSession('S1', HEADER, { startedAt: 1000 });
  assert.equal(a.entry.run, 'R01');
  const b = log.startSession('S2', a.header, { startedAt: 2000 });
  assert.equal(b.entry.run, 'R02');
  assert.equal(b.entry.test, 'acceleration'); // keeps test type and configuration
  assert.equal(b.header.run, 'R02');
  assert.equal(store.peek().length, 2); // persisted
});

test('reloading during a recording resumes its entry', () => {
  const log = new RunLog(memory());
  log.startSession('S1', HEADER);
  const again = log.startSession('S1', { ...HEADER, run: 'R07' });
  assert.equal(again.entry.run, 'R01');
  assert.equal(again.header.run, 'R01');
  assert.equal(log.entries.length, 1);
});

test('a manually chosen free run ID is kept', () => {
  const log = new RunLog(memory());
  log.startSession('S1', HEADER);
  const b = log.startSession('S2', { ...HEADER, run: 'R10', test: 'turning' });
  assert.equal(b.entry.run, 'R10');
  assert.equal(b.entry.test, 'turning');
  assert.equal(log.startSession('S3', b.header).entry.run, 'R11');
});

test('relabel, stats and clear', () => {
  const store = memory();
  const log = new RunLog(store);
  log.startSession('S1', HEADER, { startedAt: 1_000_000 });
  log.relabel('S1', { ...HEADER, test: 'climb', driver: 'Luis' });
  log.updateStats('S1', { lastSampleAt: 1_042_400, maxSpeed: 31.25, maxAlong: 0.52, maxAlat: 0.61, deviceId: 'dev' });
  const e = log.find('S1');
  assert.equal(e.test, 'climb');
  assert.equal(e.deviceId, 'dev');
  assert.equal(e.maxSpeed, 31.25);
  assert.equal(e.duration, 42.4);
  // After a page reload mid-recording the dashboard sees smaller maxima: they must not shrink.
  log.updateStats('S1', { lastSampleAt: 1_050_000, maxSpeed: 10, maxAlong: 0.9, maxAlat: 0.1 });
  assert.equal(e.duration, 50);
  assert.equal(e.maxSpeed, 31.25);
  assert.equal(e.maxAlong, 0.9);
  assert.equal(e.maxAlat, 0.61);
  log.relabel('nope', HEADER); // ignored
  log.clear();
  assert.deepEqual(store.peek(), []);
});

test('survives corrupt storage', () => {
  assert.deepEqual(new RunLog(memory('garbage')).entries, []);
});

test('folder name and slug follow the field guide', () => {
  assert.equal(folderName({ run: 'R01', test: 'acceleration', suspension: 'susp A', cvt: 'cvt-1' }), 'R01_acceleration_susp-A_cvt-1');
  assert.equal(folderName({ run: 'R02', test: 'free', suspension: '', cvt: '' }), 'R02_free');
  assert.equal(slug('La Salle Bajío — Ingenierías'), 'la-salle-bajio-ingenierias');
});

test('meta.yaml contains the run details and requirement IDs', () => {
  const log = new RunLog(memory());
  const { entry } = log.startSession('c886864a', HEADER, { startedAt: new Date(2026, 10, 8, 10, 30).getTime() });
  log.updateStats('c886864a', { lastSampleAt: entry.startedAt + 12_000, maxSpeed: 40, maxAlong: 0.5, maxAlat: 0.2 });
  const yaml = toMetaYaml(entry, { axisMap: { x: 'longitudinal', y: 'vertical', z: 'lateral' } });
  assert.match(yaml, /^date: 2026-11-08$/m);
  assert.match(yaml, /^run_id: "R01"$/m);
  assert.match(yaml, /^session_id: "2026-11-08_la-salle-bajio"$/m);
  assert.match(yaml, /^sensorlogger_session_id: "c886864a"$/m);
  assert.match(yaml, /^requirement_ids: \[VG-04\]$/m);
  assert.match(yaml, /axis_map: \{x: "longitudinal", y: "vertical", z: "lateral"\}/);
  assert.match(yaml, /duration 12 s; max speed 40\.0 km\/h/);
});

test('CSV export quotes fields that need it', () => {
  const log = new RunLog(memory());
  log.startSession('S1', { ...HEADER, driver: 'Pérez, Ana' }, { startedAt: new Date(2026, 10, 8, 9, 5, 7).getTime() });
  const csv = toCsv(log.entries).split('\n');
  assert.equal(csv[0].split(',')[0], 'run');
  assert.match(csv[1], /^R01,acceleration,susp-A,cvt-1,"Pérez, Ana",La Salle Bajío,2026-11-08 09:05:07,0,0\.0,0\.00,0\.00,S1,,R01_acceleration_susp-A_cvt-1,,,,,,,,,$/);
});

test('live analysis is stored per run and exported to CSV and meta.yaml notes', () => {
  const log = new RunLog(memory());
  const { entry } = log.startSession('S1', HEADER, { startedAt: 1_000_000 });
  const analysis = {
    activeS: 95.4, distanceM: 812, counts: { impact: 4, jump: 1, hardBrake: 2, hardCorner: 0 }, impactBins: [3, 1, 0],
    attempts: [{ t: 10, t100: 4.61, t150: 5.9 }, { t: 30, t100: 4.38, t150: null }], turns: [{ t: 50, rCgM: 2.8 }, { t: 70, rCgM: 2.65 }],
  };
  log.updateStats('S1', { lastSampleAt: 1_100_000, analysis });
  log.updateStats('S1', { lastSampleAt: 1_100_000, analysis: { ...analysis, activeS: 10, counts: { impact: 1, jump: 0, hardBrake: 0, hardCorner: 0 } } });
  assert.equal(entry.analysis.activeS, 95.4); // a reload never shrinks it
  assert.equal(entry.analysis.counts.impact, 4);
  const row = toCsv(log.entries).split('\n')[1].split(',');
  assert.deepEqual(row.slice(-9), ['95', '0.812', '4', '1', '2', '0', '4.38', '5.90', '2.65']);
  const yaml = toMetaYaml(entry);
  assert.match(yaml, /active 95 s; distance 0\.81 km; impacts 4, jumps 1, hard brakes 2, hard corners 0; best 100 ft 4\.38 s; best 150 ft 5\.90 s; tightest steady turn R_cg 2\.65 m \(live estimates\)/);
});
