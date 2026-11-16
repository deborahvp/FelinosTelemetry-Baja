import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RunLog, bestManual, toCsv, toMetaYaml } from '../../dashboard/runlog.js';
import { CLOCK_SLACK_S, Stopwatch, autoTimes, formatStopwatch } from '../../dashboard/timer.js';

test('stopwatch: start, elapsed, stop and toggle', () => {
  const sw = new Stopwatch();
  assert.equal(sw.running, false);
  assert.equal(sw.toggle(1000), null); // starts
  assert.equal(sw.running, true);
  assert.equal(sw.elapsedS(3500), 2.5);
  const r = sw.toggle(5620); // stops
  assert.deepEqual(r, { startMs: 1000, stopMs: 5620, manualS: 4.62 });
  assert.equal(sw.stopped, true);
  assert.equal(sw.elapsedS(99999), 4.62); // frozen after stop
  assert.equal(sw.stop(6000), null); // not running
  sw.reset();
  assert.equal(sw.elapsedS(1), 0);
});

test('formatStopwatch', () => {
  assert.equal(formatStopwatch(4.62), '00:04.62');
  assert.equal(formatStopwatch(72.305), '01:12.31');
  assert.equal(formatStopwatch(-1), '00:00.00');
});

test('autoTimes: launch in progress wins, then the latest finished one in the window', () => {
  const startMs = 100_000;
  const live = { t: 101, t100: null, t150: null };
  assert.deepEqual(autoTimes([], live, startMs, 105_000), { t100: null, t150: null, measuring: true });
  const attempts = [{ t: 50, t100: 4.0 }, { t: 99, t100: 4.4, t150: 5.9 }, { t: 103, t100: 4.38, t150: null }];
  assert.deepEqual(autoTimes(attempts, null, startMs, 110_000), { t100: 4.38, t150: null, measuring: false });
  // a launch slightly before Start (phone/laptop clock offset) is still matched
  assert.deepEqual(autoTimes([{ t: 100 - CLOCK_SLACK_S + 0.5, t100: 4.5 }], null, startMs, 101_000).t100, 4.5);
  assert.equal(autoTimes([{ t: 50, t100: 4.0 }], null, startMs, 110_000), null); // too early
  assert.equal(autoTimes(attempts, null, null, 0), null);
});

const memory = () => { let d = null; return { load: () => d, save: (v) => { d = JSON.parse(JSON.stringify(v)); } }; };
const HEADER = { run: 'R01', test: 'acceleration', suspension: 'susp-A', cvt: 'cvt-1', driver: 'Ana', place: 'León' };

test('run log: edit labels and notes after the fact', () => {
  const log = new RunLog(memory());
  log.startSession('S1', HEADER, { startedAt: 1_000 });
  log.startSession('S2', HEADER, { startedAt: 2_000 });
  assert.equal(log.isRunIdTaken('R01', 'S2'), true);
  assert.equal(log.isRunIdTaken('R02', 'S2'), false); // its own ID
  const e = log.update('S2', { run: ' R05 ', driver: 'Luis', test: 'climb', notes: 'Llanta trasera baja' });
  assert.equal(e.run, 'R05');
  assert.equal(e.driver, 'Luis');
  assert.equal(e.test, 'climb');
  assert.equal(e.notes, 'Llanta trasera baja');
  assert.equal(log.update('nope', { run: 'R9' }), null);
});

test('run log: stopwatch timings, best time, delete timing and run', () => {
  const log = new RunLog(memory());
  log.startSession('S1', HEADER, { startedAt: 1_000 });
  log.addTiming('S1', { startMs: 1, stopMs: 4621, manualS: 4.62, auto100: 4.38, auto150: null });
  log.addTiming('S1', { startMs: 9, stopMs: 4509, manualS: 4.5, auto100: null, auto150: null });
  const e = log.find('S1');
  assert.equal(bestManual(e), 4.5);
  log.removeTiming('S1', 1);
  assert.equal(e.timings.length, 1);
  log.removeTiming('S1', 5); // out of range: ignored
  assert.equal(e.timings.length, 1);
  log.update('S1', { notes: 'Viento en contra, "pista" húmeda' });
  const yaml = toMetaYaml(e);
  assert.match(yaml, /^notes: "Viento en contra, \\"pista\\" húmeda \| stopwatch: 4\.62 s \| duration/m);
  const row = toCsv(log.entries).split('\n')[1];
  assert.ok(row.endsWith(',4.62,4.62,"Viento en contra, ""pista"" húmeda"'), row);
  log.remove('S1');
  assert.deepEqual(log.entries, []);
  assert.equal(log.addTiming('S1', {}), null);
});
